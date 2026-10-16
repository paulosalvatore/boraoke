# TICKET-127 — Reviewer report (D-022 opus pass)

**PR:** #98 · **Branch:** `ticket/127-room-write-race` · **Reviewed head:** `a00a09f` (diff base `41b77bf`, merge-base with `origin/main`)
**Date:** 2026-10-16
**Verdict:** APPROVE. It counts for merge once the Cyber Security gate, which is running now, returns PASS or PASS-WITH-NOTES with nothing that needs a code change. If Cyber asks for a code change, the new head needs a fresh review.

## Read order

Story first: `work/tickets/TICKET-127-room-record-write-race.md`. Then `work/plans/TICKET-127-plan.md`, including the five rejected alternatives. Then the full diff of `lib/rooms.ts`, the test diffs, `work/reports/dev/TICKET-127-dev-report.md` (read from the PR branch) and the evidence in `work/evidence/TICKET-127/`, then the PR body and thread. I read the diff locally against `origin/ticket/127-room-write-race`. Mutations ran in a separate throwaway detached worktree. The shared worktree was not modified, apart from adding this report.

## Design judgment: is a revision compare-and-set the simplest correct fix?

Yes. The record is one JSON string and six mutators change it. Each mutator carries cap, owner-pin and epoch-tag logic that is already tested in TypeScript. The other options:

- **Separate keys** (plan alt A). Claim-list mutations are not single commands. The cap keeps the owner plus the newest others, and the list is tied to an epoch tag. That logic would have to be rewritten in Lua, which jest cannot run. Every reader would also need a "new key, else record" fallback for legacy rooms. Settings-vs-settings lost updates would remain.
- **Per-field atomics / HSET** (alts B and C). The same Lua duplication, plus a type change from string to hash. That change risks WRONGTYPE errors mid-deploy and forces a migration onto the auth record.
- **WATCH/MULTI** (alt D). Not available over Upstash REST.
- **Byte-compare CAS** (alt E). Fragile when the JSON does not round-trip byte for byte.

A version field checked inside one EVAL is one of the remedies the ticket itself names. It keeps the Lua tiny: about 20 lines, with no knowledge of claims, owners or epochs. It also fixes all three scenarios in one place. It is lock-free: every conflict means another writer committed, so the system as a whole always makes progress. I agree with the choice.

## Does every writer go through `mutateRoom` and carry `rev`?

Searched with `/usr/bin/grep -a` (fail-loud). Positive control: the same search found the known `lib/rooms.ts:777` and `:895`, so it ran over the right files.

- `roomBackend.update(` has exactly one production call site: `mutateRoom` (`lib/rooms.ts:777`).
- `redis.set(roomKey…)` appears only in `UpstashRoomBackend.create` (`:895`). `createRoom` writes a new record, so that write is not a lost-update path, and it is unchanged.
- No other writer of `room:<id>:meta` exists in `lib/`, `app/`, `scripts/` or `packages/`. `lib/retention.ts` only supplies SET options. The cron route (`app/api/cron/karaoke-index`) does not touch room records. `lib/pending-store.ts` only references `setRoomModeration` in a comment.
- Mutators: `issueRoomClaimToken`, `revokeRoomClaimToken`, the `revokeRoomHostSessions` rebind, and `setRoomMode` / `setRoomLanguage` / `setRoomModeration`. All of them go through `mutateRoom`. `mutateRoom` overrides `id` and `rev` with the values it read, so a mutator cannot choose its own revision. Mutant M9 (dev) killed. My Mj (drop the `id` override) survived as an equivalent mutant, because every mutator spreads `room`. The override is defensive and fine.
- **TICKET-151 (delete room), for the record.** A hard delete is safe under this design: the Lua script never creates a key (returns 0), and `mutateRoom` returns null on `missing`. If 151 picks the soft-delete option as a flag on the record, that flag must be written through `mutateRoom`. Raised as a note on 151, not a finding here.

## `ROOM_WRITE_ATTEMPTS = 32` and the fail-safe behaviour for each caller

The bound is justified by measurement. With 8, the TICKET-120 probe that releases 30 concurrent writers exhausted the retries. I reproduced this: mutant Mc set the bound to 8 and was killed by `claim-token-owner-pin` "worst-case lost updates…". 32 is above the 30-writer worst case. Worst-case cost is about 64 round trips per request under sustained contention on a single room, which is acceptable. When retries are exhausted, every caller fails closed. I confirmed each one by mutation:

| Caller | On exhaustion | Mutant that proves the test bites |
|---|---|---|
| login / creation mint | returns null; device keeps its session cookie | Mf (rethrow instead of null): KILLED |
| logout | throws before the route clears cookies (`app/api/host/session/route.ts:148` runs before `:152-153`) | Me (swallow the conflict): KILLED |
| settings | throws; route returns 500; nothing changed | covered by `room-write-cas` "settings change throws" |
| revoke rebind | falls back with `keptClaimToken: false`; route mints a fresh owner claim | Md (report kept=true): KILLED; Mh (rethrow): KILLED |

The adversarial-flood residual is stated honestly in plan §4. It fails closed: sessions end, the claims die, and the owner is re-minted.

## Backend `update` API change (`"ok" | "conflict" | "missing"`)

The only consumer is `mutateRoom`. It handles `ok` (returns the committed record with `rev + 1`) and `missing` (returns null). Anything else is retried. Upstash maps the EVAL result 1/0/-1 through `Number()`. I checked that `@upstash/redis` 1.38.0's `defaultSerializer` passes string arguments through unchanged (`node_modules/@upstash/redis/nodejs.js:562`), so the record JSON reaches Lua byte for byte. Mutant Mg (treat `missing` as a retry) survived as an equivalent mutant: the next read returns null and `mutateRoom` returns null anyway. The tests that call `update` directly now assert on its return value (`room-session-epoch-backend`, `host-session-revocation`).

## The memory store's "no await between check and write" claim

True. `MemoryRoomBackend.update` does the `Map.get`, the revision compare and the `Map.set` synchronously inside one async body, with no `await`. In Node's single-threaded event loop nothing can interleave there. `mutateRoom` awaits between `getRoom` and `update`, but that gap is exactly what the CAS detects. Mutant Ma (memory compare removed) is killed by 47 tests.

## Test quality

**Reverse check, reproduced.** I ran the 45-pair suite against `git show 41b77bf:lib/rooms.ts` and got `Tests: 44 failed, 2 passed, 46 total`, which matches the dev evidence. The two passes are the pair-count meta test and `stale revoke, interleaved logout`.

**Is the one genuine pass on main really safe?** Yes, but it proves nothing. The logout in slot B removes `staff[0]`, a hash minted before the bump, and the revoke's rebind prunes every pre-bump hash anyway. The stale rebind therefore lands on a superset of what the logout wanted, and the outcome is correct by coincidence. The dev report says this itself and does not claim the pair as a regression proof. That is accurate.

**Gap found (non-blocking).** There is a revoke-vs-logout race that matters and is not in the suite. A device logs in by code after the bump, so its hash is carried by the rebind as a post-bump hash. The rebind reads, the device logs out, then the rebind's write lands. I wrote a throwaway probe for this (not committed). It **fails on the pre-fix `lib/`** (`Expected: false, Received: true`: the logged-out device's claim is live again). It **passes on the PR**, and mutants Ma and Mi kill it. So the PR fixes this case too, but no committed test pins it. Optional follow-up below.

**My mutation pass.** It ran over 6 suites plus my probe, 163 tests. The dev's 12-mutant table covers the Lua side, and its M1-M5 need the real-Redis suite. I also re-ran `__tests__/room-cas-lua.integration.test.ts` against my own `redis:7-alpine` container on 127.0.0.1:6498, stopped afterwards: `Tests: 68 passed, 68 total`, none skipped.

| Mutant | Result |
|---|---|
| Ma memory compare removed | KILLED (47) |
| Mb `verifyRoomClaimToken` ignores the epoch tag | KILLED (2, `host-session-revocation`: "EARLIER epoch grants nothing", "owner token in a DEAD-tagged list") |
| Mc attempts 32 → 8 | KILLED (1, owner-pin worst-case probe) |
| Md fallback reports `keptClaimToken: true` | KILLED (1) |
| Me logout swallows conflict | KILLED (1) |
| Mf mint rethrows conflict | KILLED (1) |
| Mg `missing` treated as a retry | SURVIVED-equivalent (the re-read returns null) |
| Mh rebind rethrows conflict | KILLED (1) |
| Mi rebind drops `ownerClaimTokenHash` | KILLED (2) |
| Mj `mutateRoom` drops the `id` override | SURVIVED-equivalent (every mutator spreads `room`) |
| Mk `capClaimHashes` ignores the owner pin | KILLED (5 in `claim-token-owner-pin`, including the 30-writer barrier probe) |

`triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path.` `normaliseRoomRev` delegates to the existing `normaliseSessionEpoch`. The CAS mutation pass above was run anyway.

**Targeted jest on the PR head:** `room-write-race`, `room-write-cas`, `host-session-revocation`, `claim-token-owner-pin`, `room-session-epoch-backend`, `host-claim`: `Test Suites: 6 passed`, `Tests: 162 passed, 162 total`.

## Changed existing tests: was anything hollowed out?

I checked each change in the dev report's "Hollowing-out (c)" list against its diff:

- **`withStaleWriter`** (`mockImplementationOnce`, held first write). The held write is now a conflict and the retry passes through. The revoke-not-undone assertions still bite: Ma kills one test in this file. Not hollowed.
- **The randomized `revokeAmidStaleWriters` probe** now holds each stale writer's first write only (`staleCtx { firstWrite }`). Before, it held every write, which under CAS would hang the retry. Its TICKET-118 invariants are now defence in depth. The epoch-tag guard they used to exercise is still pinned by two dedicated tests, which Mb kills. Not hollowed.
- **"every rebind is clobbered" → "when the rebind never commits"**. The fake now returns `"conflict"` instead of `undefined` and adds `expect(lost).toBe(ROOM_WRITE_ATTEMPTS + 1)`. That is stronger: Md and Mh kill it.
- **"EARLIER epoch grants nothing"**. It now asserts that the stale snapshot is refused (`conflict`), then plants it with the current `rev`, the shape an old-code write could produce mid-deploy. That keeps the epoch tag under test (Mb kills it). Not hollowed.
- **Record-shape key list gains `rev`**. Correct: it is the one field a write adds.
- **`claim-token-owner-pin` barrier probe** holds the first 30 writes and passes retries through. Mk shows it still catches owner eviction, and Mc shows it still exercises deep retries. Not hollowed.
- **`room-session-epoch-backend` stale-copy test**. It asserts the conflict, then plants the stale copy with a raw `fake.set`, so `max(record, counter)` is still tested. Not hollowed.

## PR body accuracy

The summary, design, `requireHost` claim (one `MGET`, no write; pinned by the `room-write-cas` call-count test) and no-migration claim all match the code. The App Tester N/A reason, "no UI, route or copy change", is correct. I checked the diff file list: it touches `lib/rooms.ts`, `__tests__/**` and `work/**`, and no page, component, stylesheet or public asset. Design-parity therefore does not apply.

Two NITs. The gates checklist still lists "Tech Lead merge confirmation", which D-043 superseded. Plan §5 lists `__tests__/host-claim.test.ts` as modified, but the diff does not touch it. The dev report does not claim it.

## CI / green evidence

boraoke has no `scripts/verify-green-local.sh`, so the D-051 local-Docker verdict does not exist for this repo, as for #96. The dev evidence stands in for it: full jest `78 passed` suites, `1461 passed` tests (`work/evidence/TICKET-127/jest-full-summary.txt`); full e2e `143 passed`, exit 0 (`e2e-summary.txt`); build OK. As briefed, I ran targeted jest only.

## Findings

1. **optional (follow-up test):** add the probe described under Test quality (a post-bump login whose device logs out while the rebind write is held) to `room-write-race.test.ts`. It is the one revoke-vs-logout shape that genuinely fails on main, and today no committed test pins it. The fix already handles it.
2. **NIT (unreachable):** Lua and JS normalise exotic revision strings differently. Lua `tonumber` rejects `"0b1"` and `"0o7"`, which JS `Number` accepts, and accepts `"0x1p4"`, which JS rejects. Code only ever writes a numeric `rev`, so only a hand edit could produce such a string. The result would fail closed, but every write to that room would conflict until the record is fixed. Optional hardening: treat only a numeric `rev` as valid on both sides.
3. **NIT:** PR body gate list ("Tech Lead merge confirmation", superseded by D-043) and plan §5 (`host-claim.test.ts` listed but not modified).
4. **Note for TICKET-151:** a soft-delete flag on the record must be written through `mutateRoom`. A hard delete needs nothing extra.

None of these blocks the merge.

## Verdict

**APPROVE** at head `a00a09f`. It counts for merge once the Cyber gate PASSes without code changes.
