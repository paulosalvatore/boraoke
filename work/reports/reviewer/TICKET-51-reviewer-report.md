# TICKET-51 — Reviewer Report

**Verdict:** APPROVE
**Counts as the D-022 merge-counting APPROVE:** YES (fully in-tier; test-only, zero production-source change).
**Merge note:** This APPROVE means gate-green. It does NOT authorize auto-merge — any boraoke merge triggers a live boraoke.com prod deploy, which is the Tech Lead's call.

## Scope reviewed

Branch `ticket/51-junk-reason-strict-bucket-test`, diff `origin/main...HEAD`:

- `__tests__/advance-rate-limit.test.ts` — 2 new route-level tests (+52 lines).
- `work/tickets/TICKET-51-junk-reason-strict-bucket-test.md`, `work/reports/dev/TICKET-51-dev-report.md` — docs.
- `work/events/2026-07.jsonl` — 1 auto event line.

Diff-stat confirms **no production source touched** (`app/`, `lib/` untouched). The claim "prod already routes junk → strict bucket" is verified below.

## What I checked

### (a) Does the test prove what it claims?
Yes.
- Route `app/api/queue/advance/route.ts` L56–58: `skipReason = rawReason && ADVANCE_SKIP_REASONS.has(rawReason) ? rawReason : null` with `ADVANCE_SKIP_REASONS = {"unplayable"}`. Any junk value (`"bogus"`, `"skip"`, `"unplayable-ish"`, `"griefer"`, `"advance"`) → `null`; empty `""` → `null` (falsy `rawReason`). L61: `{ unplayable: skipReason === "unplayable" }` → `false` → strict `room:` bucket.
- `lib/advance-rate-limit.ts` L81–82: `unplayable ? 40 : 12`, keyed `unplayable:<room>` vs `room:<room>`. Strict ceiling = `ADVANCE_ROOM_MAX = 12`.
- Test 1 drives exactly `ADVANCE_RATE_ROOM_MAX` (12) `reason=bogus` successes, then asserts the 13th → 429 `{reason:"rate"}`. A generous-bucket misroute would let 13+ through — so this is a genuine negative assertion of the strict ceiling, not merely "some limit."
- Test 2 interleaves junk + reasonless advances, proving they charge the SAME strict bucket (12 combined → 13th 429s), then proves the unplayable bucket is untouched: a `reason=unplayable` advance in the same room/window still 200s.

### (b) Correct / non-flaky?
Yes.
- `beforeEach` → `_resetAdvanceRateLimit()` + `store.clear(DEFAULT_ROOM)`; `afterEach` restores `process.env`. No shared-state bleed between tests; each test re-sets its own `ADVANCE_AUTH=enforce` env.
- All 13 calls per test land well within the 60s window (`ADVANCE_WINDOW_MS`), so the `Date.now()`-based accounting has no time-boundary race.
- Interleave accounting is sound: `authedAdvance("")` produces a reasonless URL (empty string is falsy in the harness), but reasonless also routes to the strict bucket, so the "12 combined" count is unaffected either way — one POST per iteration, all strict.
- Ran the suite locally 4× (initial + 3 repeat): **11/11 pass every time**, ~0.4s. Deterministic.

### (c) Locks in the fail-safe durably?
Yes.
- Tests assert against the imported `ADVANCE_RATE_ROOM_MAX` symbol, NOT a hard-coded 12 — so they track the constant if it is retuned.
- The sibling TICKET-47 test at L58–59 additionally pins `expect(ADVANCE_RATE_ROOM_MAX).toBe(12)`, double-guarding silent drift.

### Coherence / docs
Dev report and ticket doc match the diff exactly (files touched, test names, prod-verification lines, acceptance criteria). Self-verification claims (11/11 targeted, build exit 0) are consistent with my local re-run of the targeted suite.

## Evidence relied on
- `git diff origin/main...HEAD` (diff-stat + test diff) — read locally, no API.
- Full read of `__tests__/advance-rate-limit.test.ts`, `lib/advance-rate-limit.ts`, `app/api/queue/advance/route.ts`.
- Local `npx jest advance-rate-limit`: 11/11 pass, 4 consecutive runs.

## Follow-ups
None. Optional (non-blocking): the interleave test's `junkReasons` array includes `""`, which the harness turns into a reasonless (not junk) request — harmless to the assertion, but the array name slightly overstates coverage. Not worth a change.

## CI note
The merge gate proper is `scripts/verify-green-local.sh` GREEN (md-doctor + shell-tests, framework-side) — orthogonal to this product test suite and the TM's responsibility to confirm before the deploy decision. This report certifies the product-level test correctness/quality gate for TICKET-51.
