---
ticket: TICKET-152
product: boraoke
status: in_review
---

# TICKET-152 — Owner-pin concurrency probe flaked under host load: a jest TIMEOUT, not an owner lockout

**Filed:** 2026-10-15, by a Dev agent, on a boraoke Tech Manager request.
**Priority:** MEDIUM (it guards an authentication path, so a red here has to be trustworthy).
**Type:** Test reliability (security-adjacent)
**Size:** XS
**Patron-facing:** no. **Gates:** Reviewer. No Cyber gate needed: no product code changes.

## What was seen

During a full jest run at host load ~150-180, `__tests__/claim-token-owner-pin.test.ts` failed once on "30 CONCURRENT logins from distinct clients never evict the owner (8 interleavings)". It passed when re-run alone. The output was not kept. The test guards TICKET-120 (#91, b249326): the claim-token cap must never evict the room owner's device.

The question was whether that was a timing artifact or a real race that lets concurrent logins evict the owner (a venue-owner lockout).

## Cause: a test timeout, proven from evidence

The probe runs on **real timers** (seeded 0-5 ms pauses around every `roomBackend.get`/`update`, and arrivals spread over 60 ms), so its wall time grows with host load. It had no explicit timeout, so it ran against jest's **5,000 ms default** (`jest.config.ts` sets no `testTimeout`).

Measured on origin/main 8473de2, 50 copies of the file per run (load averages 164-188):

| Run | Probe duration (min / median / max) | Result |
|---|---|---|
| alone, 1 worker | 1,702 ms | pass |
| 50 copies, `--maxWorkers=10` | 708 / 2,762 / 4,633 ms | 550/550 pass |
| 50 copies, `--maxWorkers=16` | 1,889 / 3,149 / 4,788 ms | 550/550 pass |
| 50 copies, `--maxWorkers=16 --testTimeout=2500` | n/a | **16 failed, all on this test, all timeouts** |

The max sits within ~200 ms of the 5 s default, so a full suite on a busier host crosses it. All 16 failures under the short timeout were this one failure, verbatim:

```
  ● the owner survives other people's logins (TICKET-120) › 30 CONCURRENT logins from distinct clients never evict the owner (8 interleavings)

    thrown: "Exceeded timeout of 2500 ms for a test.
    Add a timeout value to this test to increase the timeout, if this is a long-running test. See https://jestjs.io/docs/api#testname-fn-timeout."
```

`grep` over that log: 32 `Exceeded timeout` lines (16 failures × 2), **0** `Expected`/`Received` assertion lines. No assertion failed in any run.

## Why it is not a real race

- **By construction.** `issueRoomClaimToken` is a whole-record read-modify-write (the TICKET-127 class), but once the room is created every read returns a record that holds the owner's hash and pointer. Every writer then writes back a list that still holds it: `capClaimHashes` never drops `owner`, and `setRoomMode`/`Language`/`Moderation` spread `...room`. A lost update can drop a concurrent **staff** hash, never the owner's. Only `revokeRoomClaimTokens` (logout) removes it, on purpose.
- **Deterministically, at the worst case.** A new timer-free probe forces every read to land before any write, then releases 30 writes (staff mints plus host mode changes) in a seeded random order, after pre-filling 0-7 staff tokens. **200/200 interleavings keep the owner** on main. Against the pre-fix `slice(-MAX_CLAIM_TOKENS)` it **fails on 99 of 200 seeds** (prove-your-test-can-fail reverse check). A 500-seed scratch version of the same probe gave 0/500 on main and 109/500 on the pre-fix code.

Out of the probe's scope, recorded for completeness: a login racing the creator's own pin (between `createRoom` and `attachClaimCookie(..., { owner: true })`) could write a list without the owner. It is unreachable because the host code exists only in the creation response. TICKET-127 (whole-record lost updates) remains open; logout racing a login is a resurrection risk there, not an eviction.

## Fix (test-only)

`__tests__/claim-token-owner-pin.test.ts`:
1. Both real-timer probes ("30 CONCURRENT" and "six concurrent waves") get an explicit `CONCURRENCY_PROBE_TIMEOUT_MS = 60_000`, with a comment explaining why. A slow host can make them slow but no longer red. Only their assertions can fail them.
2. A new deterministic, load-independent barrier probe (described above).

**Proof under the same stress method:** 100 runs (2 × 50 copies, `--maxWorkers=16 --testTimeout=2500`, load averages 101-147): **1,200/1,200 passed, 0 failed**. The probe ran up to 3,332 ms in those runs, past the 2,500 ms CLI timeout that failed it before, and still passed.

## Acceptance

- [x] Cause determined from evidence (timeout, no assertion failure).
- [x] The probe no longer depends on jest's default timeout; stressed 100× with a CLI timeout it previously failed under.
- [x] Worst-case interleaving covered by a deterministic test that fails on the pre-fix eviction.

## References

- TICKET-120 (`work/tickets/TICKET-120-claim-token-cap-evicts-the-owner.md`, dev report `work/reports/dev/TICKET-120-dev-report.md`), PR #91.
- TICKET-127 (whole-record read-modify-write; on the #90 branch). Not fixed here.
