# TICKET-151 review (D-022 opus pass)

**Reviewed head:** `6bfb07a` (`origin/ticket/151-delete-room`), PR #101.
**Verdict:** REQUEST-CHANGES (1 required item). Gate preconditions also open: no Cyber Security PASS on the PR or in the ticket store yet, and no `app-tester-waived` row yet (the diff touches no UI, so a waiver fits; the TM records it).

## What I checked

Story (`work/tickets/TICKET-151-delete-room-capability.md`), plan, full diff read locally (`git diff main...origin/ticket/151-delete-room`), dev report (treated as claims), PR body and thread.

### TM dispatch requirements, verified in code

| Requirement | Result | Where |
|---|---|---|
| Dry run by default; delete only with `--apply` + typed slug | PASS | `runDelete` returns `dry-run` unless `apply`; `confirm()` must equal `plan.slug` (lib/room-delete.ts `runDelete`); CLI `parseArgs` defaults `apply:false` |
| Snapshot (value + TTL of every key) to a gitignored path BEFORE any delete | PASS | `takeSnapshot` then `saveSnapshot` then `applyDelete`; a throwing save aborts (tested, "disk full" case); `.room-delete-snapshots/` in `.gitignore`, dir 0700, file 0600 |
| `--restore <snapshot>` with a round-trip test | PASS | `restoreSnapshot`; test "restore round-trips the snapshot (values, TTL, order, memberships)", plus refuse-over-existing-keys |
| Keys enumerated from code, never a wildcard delete; SCAN cross-check refuses on unknown keys | PASS | `buildPlan` derives keys from the app's own builders; `DEL` only on the explicit list; `room:<slug>:*` SCAN feeds `unaccounted`, non-empty makes `isApplicable` refuse |
| Membership removal by SREM only | PASS | `applyDelete` calls `kv.srem(setKey, slug)` only |
| Explicit race handling against `mutateRoom` | PASS | record deleted first; `ROOM_CAS_SCRIPT` (lib/rooms.ts:717-719) returns 0 on a missing key and never creates one, proved against real Redis; re-created keys surface as leftovers (exit 2) |

### Independent key-builder sweep

`/usr/bin/grep -rnaE` over `lib/` and `app/` for every template-string key builder and every module touching Redis (`embed-cache, feedback-store, identity-store, karaoke-index/store, pending-store, rate-limit-counter, retention, rooms, search-budget, search-cache, search-single-flight, store/upstash, telemetry-store, video-meta`). Room-slug-embedding Redis keys found:

- `room:<id>:meta`, `room:<id>:session-epoch` (lib/rooms.ts:590, 597)
- `room:<id>:queue`, `room:<id>:paused` (lib/store/types.ts:125-126)
- `room:<id>:pending:index`, `room:<id>:pending:item:<id>` (lib/pending-store.ts:115-116)
- `rl:hostrevoke:<id>` (lib/host-auth.ts:594 via rate-limit-counter `rl:` prefix, no window suffix)

Not Redis or not room-keyed: advance-rate-limit `room:/total:/unplayable:<id>` buckets are an in-memory `hits` Map; rotation keys are in-memory table ids; host cookies and `cantai:<id>:*` are client-side; telemetry is day-keyed; `rooms:count` is global and over-counting is documented as safe. History and rotation live inside the queue and meta values. The engine's list is complete.

Pending scoping: item keys are built as `room:<target>:pending:item:<id>` from ids read out of the target's own index, and `DEL` is literal, so another room's items cannot be reached. Rejected items stay in the index until lazily pruned (pending-store.ts 300-320, 344-357), so they do not show up as unaccounted keys. `ROOM_ID_RE = /^[a-z0-9-]{1,64}$/` rules out glob characters and `:` in the slug.

### Deleted while a TV/patron tab is live

- TV/patron GET polls are read-only: `getRoom` returns null, the queue reads return empty. Host actions need the record, so the session-epoch cannot be bumped once it is gone.
- **Re-creation path (pre-existing, out of diff):** `POST /api/queue` (app/api/queue/route.ts:65 onwards) never checks that the room exists, so an open patron tab can `RPUSH` a fresh, TTL-less orphan `room:<slug>:queue` after the script exits. During a run, the post-delete verification catches it. After a run, nothing does. Follow-up ticket recommended: queue POST should 404 for a missing room, which also closes an unauthenticated storage-write vector. An orphan queue also makes `--restore` refuse (safe, but the operator must clear it first).

## Required

1. **Show the plan before the typed confirmation.** In `scripts/delete-room.ts`, `printPlan` runs only after `runDelete` returns, so on interactive `--apply` the operator types the slug without seeing which keys and memberships will go, and sees the list only after the deletion. Pass the plan to `confirm` (or print it inside the callback) so the list is on screen before the prompt. The confirmation is the only interactive safety step, and the story asks for "a printed key list before the destructive step". Small change, and it needs no new test beyond keeping the existing `runDelete` gate case green.

## Optional / follow-ups

- optional: anchor the snapshot dir away from `process.cwd()`. Today it is safe under `npm run` (package root, gitignored), but a snapshot written inside a ticket worktree is lost when `worktree-cleanup` removes that worktree. **Condition on the prod run:** run it from the main checkout, or move the snapshot somewhere durable before any worktree cleanup.
- **Condition on the prod run (reversible-changes rule):** the Upstash adapter in `scripts/delete-room.ts` has no test. The engine is tested over a fake and raw RESP, but nothing tests the adapter itself. I tried an Upstash-REST proxy (SRH) locally; the image pull failed on the network, so this stays UNVERIFIED. Before deleting `t125-prod-verify-throwaway`, do a dry run, then rehearse `--apply` + `--restore` on a disposable room on the same Upstash, then delete for real.
- optional: the M9 and M11 survivors below (a restore-order test; a prefix-sibling room fixture such as `t151-target-2`).
- nit: the real-Redis CAS test calls `r.end()` outside a `finally`, so a failing assertion leaves the socket open and jest hangs (seen under mutation M2). Use try/finally or `afterAll`.
- nit: the dev report is thin. It doesn't mention the snapshot/restore, has no commit SHAs and defers all evidence to the PR body. The PR body covers it, so this doesn't block.
- follow-up ticket: `POST /api/queue` existence check (above).

## Tests and prove-your-test-can-fail

- `REDIS_TEST_URL=redis://127.0.0.1:6432 npx jest room-delete` (redis:7-alpine in Docker): **19 passed, 19 total** (fake + real Redis + the CAS-after-delete case).
- Full `npx jest` on the branch: **82 suites passed; 1609 passed, 90 skipped**. `youtube.test.ts` on main (63a1158) alone: 93/93 passed. The reported flake did not reproduce, and it is out of diff either way.
- `tsc --noEmit`: no errors in non-test sources or in the new test files beyond the repo-wide missing-jest-globals noise that main has too. CLI smoke: module loading and the `server-only` stub work (`npm run room:delete -- --room t151-x` with no env prints the missing-credentials error; `--bogus` prints `unknown argument`).
- New feature, so there is no pre-fix implementation to reverse-check against. Mutation-proof is the instrument. Dev declarations present: `no primitive beneath existing assertions changed` (I agree: `revokeKey`/`redisKey` only gained `export`) and `triggered mutation pass: not triggered`. I agree: no parsing/normalisation function on a money/quantity/identity path.

### Reviewer mutation pass (real Redis + fake)

| Mutant | Result |
|---|---|
| M1 drop `rl:hostrevoke` from the key list | KILLED (4 failed) |
| M2 drop pending item keys | KILLED (13 failed) |
| M3 disable SCAN cross-check | KILLED (2) |
| M4 DEL the membership set instead of SREM | KILLED (4) |
| M5 snapshot after delete instead of before | KILLED (2) |
| M6 drop the legacy `identity:*:rooms` scan | KILLED (4) |
| M7 skip the slug confirmation check | KILLED (2) |
| M8 restore over existing keys | KILLED (2) |
| M9 restore writes the record first | SURVIVED-equivalent (single-threaded test cannot see the ordering window; it is a race property) |
| M10 skip post-delete verification | KILLED (2) |
| M11 SCAN `room:<slug>*` (no colon) | SURVIVED-equivalent (fail-safe: it can only add false refusals for a prefix-sibling room, never a deletion) |
| M12 restore without TTL | KILLED (2) |

triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path.

## Preconditions

- Cyber Security PASS: **missing** (ticket store `TICKET-151` has only dev facts; there is no `work/reports/{cyber,security}/` file for 151). The story makes this gate mandatory. No merge until it lands.
- App Tester: PR body says "App Tester N/A". The diff (`.gitignore`, `__tests__/`, `lib/`, `package.json`, `scripts/`, `work/`) touches no UI surface, so a D-081 waiver is valid once recorded. No `app-tester-waived` row exists yet.
- reviewer-approve: **not recorded** (verdict is REQUEST-CHANGES).

## Round 2 (delta re-review at head `1537201`)

**Verdict:** APPROVE.

- Required item 1 is resolved. `runDelete` calls `opts.onPlan?.(plan)` right after `buildPlan`, before the gate and before `confirm()` (lib/room-delete.ts). The CLI's `onPlan` prints the keys, the memberships and, on `--apply`, the snapshot path pattern. The post-run `printPlan` call is gone.
- New test: "shows the plan before the confirmation prompt, and a declined confirmation writes nothing" asserts the order `["plan:8:2","prompt"]`, `confirmation-mismatch`, no snapshot save and an unchanged keyspace.
- Targeted jest: `npx jest room-delete` 21/21 against real Redis 7 (`REDIS_TEST_URL`), and 10 passed + 1 skipped on the fake alone.
- Mutants:
  - onPlan moved after `confirm()`: KILLED (2 failed, both backends).
  - `confirm()` awaited before onPlan: KILLED (2).
  - onPlan dropped: KILLED (2).
  - onPlan moved below the dry-run/refused returns but still before the prompt: SURVIVED. It is equivalent for the confirmation gate, but the CLI would stop printing the plan on dry-run and refused runs, and nothing asserts that. Nit only (optional: assert onPlan fires on a dry run).
- Preconditions: the app-tester waiver is now recorded (the TM says so; the diff touches no UI). The Cyber Security PASS is still the TM's to confirm before merge.
- Prod-run conditions from round 1 still stand: run from the main checkout, and rehearse `--apply`/`--restore` on a disposable room on the same Upstash first.

## Round 3 (delta re-review at head `4b6444f`, code at `e5b69a6`)

**Verdict:** REQUEST-CHANGES (1 required item, tests only). The round-2 reviewer-approve row stays; no new approve row is recorded for this round.

Scope: `git diff 1537201..HEAD -- lib scripts __tests__`.

### Correctness

- The shared key builders are reused, not duplicated. `typeOfAllowed` and `validateSnapshot` call `roomKey`, `roomSessionEpochKey`, `queueKeys.*`, `pendingKeys.*` and `counterKey(revokeKey())`. The list of fixed keys is written out a second time, though (buildPlan's `derived` vs `typeOfAllowed`). A key later added to only one of them makes restore refuse, which is fail-safe. optional: one shared `roomFixedKeys(slug)`.
- Types match Redis TYPE for every key: meta, epoch (INCR value), paused and `rl:hostrevoke` are strings; queue and pending index are lists. Pending items are allowed only for ids in the snapshot's own index, which matches how buildPlan derives them. Rejected items stay in the index.
- Restore is still SADD-only and writes the record last. `runRestore` order is plan, then clash refusal, then dry-run, then typed slug, then write.
- **A legit snapshot restores identically.** I added a scratch real-Redis test (not committed). It seeds every key with distinct TTLs and pending index order `p3,p1,p2`, deletes, restores, then compares type, value and TTL (10 s buckets) of every `*<slug>*` key. Result: identical, index order kept, paused `"1"` kept.
- Cyber INFO (a forged file can SADD its own slug into any `identity:<id>:rooms`): not material. Whoever runs restore already holds the Upstash write token and can SADD directly. The guard's job is to stop wholesale set writes, and it does. A stray membership only lists a room under an identity; hosting still needs the host code. Agree INFO.
- nit: `args` is now parsed at module top level, outside `main().catch`, so an unknown argument throws an uncaught stack trace instead of the clean one-line error.
- `SNAPSHOT_DIR = __dirname/..` is the worktree root when run from a worktree. The round-1 prod-run condition (run from the main checkout) still stands.

### Tests

`REDIS_TEST_URL=… npx jest room-delete` + my scratch fidelity test: **32 passed, 32 total** (31 theirs + 1 mine).

| Mutant (lib/room-delete.ts) | Result |
|---|---|
| R1 allow any key | KILLED (4) |
| R2 pending item with any id | KILLED (2) |
| R3 drop `MEMBERSHIP_RE` | KILLED (2) |
| R4 drop the type check | KILLED (2) |
| R5 drop the value-shape check (`okValue`) | **SURVIVED-real-gap** |
| R6 skip `validateSnapshot` in `planRestore` | KILLED (2) |
| R7 drop the restore dry-run default | KILLED (2) |
| R8 drop the restore slug confirmation | KILLED (2) |
| R9 reverse list order on restore | KILLED (3) |
| R10 drop TTL restore | KILLED (3) |
| R11 drop the duplicate-key check | **SURVIVED-real-gap** |

R5: with no shape check, an empty-list entry passes validation, and `rpush` with no values then errors partway through the restore. Keys written before it stay, which breaks the "refuse-all, writes nothing" claim. A non-string value would be written as a serialized object. R11: a duplicated list entry passes and `rpush`es twice, doubling the queue. Both are untested guards on a function whose whole job is Cyber MEDIUM-1 validation, so the severity floor applies.

### Required

1. Add tests that KILL R5 and R11: (a) a wrong-shape value, i.e. an empty list for `room:<slug>:queue`, a non-string array item and a non-string value for a string key, is refused and the keyspace is unchanged; (b) a snapshot with a duplicated key is refused. Show each new assertion failing with its guard removed.

## Round 4 (head `8ccf0b4`)

**APPROVE.** The diff since `e5b69a6` touches only tests, reports and events; `lib/room-delete.ts` is byte-identical. room-delete 35/35 on real Redis. R5 (value-shape check) and R11 (duplicate-key check) are now KILLED, 2 failures each.
