# Reviewer Report — TICKET-41: TV player watchdog + embeddable-only search

- **Verdict:** APPROVE
- **Reviewer:** Reviewer agent (opus-tier pass; D-022; D-011 verdict)
- **Date:** 2026-07-08
- **PR:** https://github.com/paulosalvatore/boraoke/pull/24
- **Branch:** `ticket/41-tv-watchdog`
- **Worktree reviewed from:** `/Users/paulosalvatore/Documents/GitHub/cantai/.worktrees/ticket-41`

---

## 1. Precondition Check

| Gate | Status |
|------|--------|
| App Tester PASS | ✅ — posted in PR thread; report at `work/reports/testing/TICKET-41-app-test.md`; evidence at `work/evidence/ticket-41/` |
| Security | ✅ — TM-waived N/A-by-content (client-side watchdog + one ALLOWLISTED query param); advance-auth deferral fully documented in `work/plans/TICKET-41-plan.md` §Advance-auth design; PR body does NOT claim auth shipped (no auth mentions) |
| CI green | ✅ — Reviewer ran `npm ci`, `npm test` (380/380 green), `npm run build` (green), `PORT=3042 npm run test:e2e` (30/30 green) locally in the worktree; GitHub Actions `build-and-test` SUCCESS per dev + App Tester reports (run 28973531261); `scripts/verify-green-local.sh` does not exist in this product repo — GitHub Actions is the declared authoritative gate per App Tester assessment |
| Ticket | ✅ — `work/tickets/TICKET-41-tv-watchdog.md` present on branch |
| Plan | ✅ — `work/plans/TICKET-41-plan.md` on branch; advance-auth design (screen-token + rate-limit combined, flag-gated, deferred to follow-up) recorded |
| Dev report | ✅ — `work/reports/dev/TICKET-41-dev-report.md` current (post-merge note added, SHA references present, 380/380 + 30/30 verified) |

**CONFLICTING merge state:** the only conflict identified via `git merge-tree` is `work/events/2026-07.jsonl` (events log, appendable UNION). Zero code-file conflicts. This is a routine rebase item — does not block approval; TM to UNION-resolve on merge.

---

## 2. Own Test Run

Run in `/Users/paulosalvatore/Documents/GitHub/cantai/.worktrees/ticket-41`:

```
npm ci          → clean (audit warnings on deps, no breaking changes)
npm test        → 25 suites, 380 tests, 0 failures  ✅
npm run build   → green (Next.js production build)  ✅
PORT=3042 npm run test:e2e → 30 passed (1.4m), 0 flakes  ✅
```

All three in-scope suites passed in my independent run.

---

## 3. Diff Review

### 3a. `components/tv/watchdog.ts` (new, pure module)

**Error classification (`isFatalPlayerError`):** correct. Codes 2 (invalid param), 5 (HTML5 error), 100 (not found/removed/private), 101 (embedding disabled), 150 (same as 101 disguised) — well-documented, maps exactly to the YT IFrame API spec. Set is `ReadonlySet<number>` for immutability. Non-listed codes left to the stall ladder — correct design (unknown future codes default to recovery attempts, not hard skip).

**Stall machine (`stallTick`):** the escalation logic is sound and complete:

- **ENDED / PAUSED** re-arm the window without touching the ladder — correct. PAUSED by a host should not escalate; ENDED is owned by `onStateChange`.
- **Real progress:** uses `Math.abs(currentTime - state.lastTime) >= MIN_PROGRESS_SECONDS` — the absolute delta is the key correctness insight: after a `reload`/`recreate` rung, the player restarts at 0, which would be a large negative delta on a signed comparison; `abs()` correctly reads it as activity. I verified the unit test "BACKWARD clock movement counts as activity" explicitly exercises this path.
- **First sample** only arms the baseline (no escalation) — prevents a spurious rung 0 fire on fresh load.
- **Window open → wait; window elapsed → climb one rung, re-arm.** Clean.
- **Defensive no-advance-loop guard** at `rung >= ESCALATION_LADDER.length`: returns `none` and resets — prevents an infinite advance storm if integration fails to reset state after the `advance` action. Tested.
- **Wedged player** (`null` state + `null` time): falls through to the no-progress path — correctly counts as stall. Tested.

**Bootstrap backoff (`bootstrapRetryDelayMs`):** 5s/10s/20s/30s cap with unlimited retries. Values are sane (within 10–15s STALL_WINDOW_MS validated by sanity test). Unlimited retries is the correct call for venue-wifi recovery.

**API surface:** clean — all exported symbols are used by `TvScreen.tsx`; no dead exports.

### 3b. `TvScreen.tsx` wiring

**TICKET-18 reliability properties:**

- **Timer hygiene:** three timer concerns, all separated and cleared:
  - Bootstrap retry: `readyTimer` + `retryTimer` both cleared on `disposed = true` in unmount cleanup. `disposed` flag prevents callbacks firing after unmount.
  - Stall poll: single `setInterval(t)` in one `useEffect`, `return () => clearInterval(t)` — clean.
  - Skip notice: `skipNoticeTimerRef` cleared in a dedicated `useEffect` cleanup. The inline `clearTimeout` before setting the new timer also prevents stacking.
- **No listener accumulation:** player handlers (`onReady`, `onStateChange`, `onError`) attached ONCE at `new window.YT.Player(...)` creation. The player effect guards `if (playerRef.current)` to not re-create if player already exists; the `playerEpoch` bump is the only mechanism that forces a re-create, and it does so correctly by nulling `playerRef.current` before the bump.
- **Idempotent player effect:** `[ytReady, queue, advance, skipUnplayable, playerEpoch]` deps are correct — the effect either finds an existing player and loads a new video, or creates one. The `playerDivRef.current` null check + `playerRef.current` guard are both present.

**Bootstrap retry interaction with recreate rung:**

The question raised in the review brief: can the bootstrap retry loop and the recreate rung run simultaneously? No — they are orthogonal:
- The bootstrap `useEffect` runs once (no deps change after `ytReady` flips `true`), and its `disposed` flag + `retryTimer` guard prevent duplicate injections.
- The recreate rung only fires from the stall watchdog after the player is created (`playerRef.current` is non-null). When recreate fires: `player.destroy()`, `playerRef.current = null`, `currentVideoIdRef.current = null`, then `setPlayerEpoch(n+1)`. The player effect re-runs and calls `new window.YT.Player(...)` — `window.YT.Player` is already loaded (`ytReady` is already `true`), so the bootstrap retry path is never triggered. No pathological interaction.

**`skipUnplayable` correctness:**

- `skippingRef.current` guard prevents re-entrant calls — correct, since both `onError` and the stall `advance` action can both call this.
- `finally` block resets `skippingRef.current = false` — guard is always released.
- `stallStateRef.current = createStallState(Date.now())` after the advance call — stall state reset before loading the next video. Correct.
- If `playerRef.current` is null (player was destroyed before skip landed), the `loadVideoById` call is skipped — the `else if (!nextVideoId)` branch handles empty queue.

**`advance()` URL construction:** `roomQuery` is either `"?room=<id>"` or `""`. The ternary `${roomQuery ? "&" : "?"}reason=${reason}` correctly computes the separator. Verified in code.

**`onError` → `isFatalPlayerError` → `void skipUnplayable()`:** attached once at player creation. Non-fatal codes silently ignored — left to the stall ladder. Correct.

### 3c. `app/api/queue/advance/route.ts`

**Allowlist strictness:** `ADVANCE_SKIP_REASONS = new Set(["unplayable"])` — a Set allowlist with strict membership check. `rawReason && ADVANCE_SKIP_REASONS.has(rawReason) ? rawReason : null` — handles null, empty, and arbitrary strings (including `<script>` from the test) all rejected cleanly. Confirmed by unit test "an unknown reason is ignored (allowlist): no song_skipped".

**Song_skipped uuid (C1 single-source):** `skipped = store.nowPlaying(roomId)` read **before** `store.advance(roomId)` — captures the head that IS being skipped, not the promoted one. This is the correct semantic for `song_skipped`. `song_played` still uses `next.patronUuid` (post-advance head) — C1 single-source unchanged, confirmed by unit test and comment.

**Fail-open telemetry:** `void track(...)` — fire-and-forget. Both `song_skipped` and `song_played` are fire-and-forget. If telemetry throws it doesn't affect the advance response. Correct, consistent with existing C1 pattern.

**Empty-queue with reason:** `const skipped = skipReason ? await store.nowPlaying(roomId) : null` — if queue is empty, `nowPlaying` returns null, so `if (skipReason && skipped)` is false → no `song_skipped` emitted. Tested.

### 3d. `lib/youtube-search.ts`

`videoSyndicated=true` is one line, additive, correct placement (after `videoEmbeddable=true`, both require `type=video` which is set above). Comment documents the paste-link gap (watchdog covers at play time). Test-locked in `__tests__/youtube-search.test.ts`.

### 3e. `lib/telemetry-types.ts`

Comment-only update: `"song_skipped", // props: reason ("host" | "noshow" | "unplayable" — TICKET-41 watchdog)`. Correct documentation of the new props variant. `TELEMETRY_EVENTS` const-locked array is untouched (no new event types).

### 3f. Test quality

**`__tests__/tv-watchdog.test.ts` (23 tests):** pure state-machine tests, no mocking. Covers: all 5 fatal codes, 5 non-fatal codes; first-sample baseline; progress resets ladder; backward clock = activity; PAUSED benign (window re-arm, ladder preserved); ENDED benign; buffering-with-progress benign; full ladder walk replay→reload→recreate→advance; window still open = quiet; wedged player escalates; progress between rungs resets bottom; no-advance-loop guard; backoff schedule 5/10/20/30; constants in sane range. Coverage is excellent — every decision branch in `watchdog.ts` has a corresponding test.

**`__tests__/telemetry-instrumentation.test.ts` (+3 tests):** allowlist acceptance (`reason=unplayable` → `song_skipped` with skipped head uuid), rejection (`reason=<script>` → no `song_skipped`), empty-queue safety. Test confirms the uuid is the skipped entry's uuid, not the promoted one.

**`__tests__/youtube-search.test.ts` (+1 assertion):** `videoSyndicated=true` locked. Additive, no disruption.

**`e2e/tv-watchdog.spec.ts` (2 tests):** YT player prototype-stub via `addInitScript` (same pattern as TICKET-18 fullscreen tests). Test 25: onError 150 → notice visible → advance called with `reason=unplayable` → next song in `tv-hero` → notice self-clears in 6s. Test 26: code 100 skips; non-fatal code 1 does NOT skip. Correct scope — stall behavior is correctly left to unit tests (stall windows are impractical in e2e).

---

## 4. Security Gate Waiver Assessment

TM waiver: N/A-by-content. Assessment:

- **Client-side watchdog:** no server-side attack surface added by the pure module or TvScreen wiring.
- **`?reason=` query param:** properly allowlisted server-side (`Set(["unplayable"])`); no injection path; junk values unit-tested. The param affects only telemetry props, not store state or response shape.
- **Advance-auth deferral:** documented in full detail in `work/plans/TICKET-41-plan.md` (screen-token + rate-limit design, honest threat model, flag-gated rollout). The PR body does NOT imply auth shipped — zero auth mentions. The deferral is honestly presented: the plan explicitly states "implemented as a **follow-up ticket, not in PR #24**" with sound rationale (e2e suite breakage, independent of watchdog delivery). TICKET-45 is queued per BOARD status. Waiver is appropriate.

---

## 5. Scope Check

In-scope items delivered: watchdog pure module ✅, onError ✅, stall ladder ✅, bootstrap retry ✅, pt-BR skip notice ✅, advance `reason` param + telemetry ✅, `videoSyndicated=true` ✅, tests ✅. Out-of-scope items correctly excluded: patron paste-verify UI (TICKET-40 file conflict, documented), advance-auth (TICKET-45, documented), new event types (const-locked list untouched). No drive-by refactors. No scope creep.

TICKET-40 overlap: TICKET-40 did not touch `lib/youtube-search.ts` (verified via `git show af156a7 --name-only`). The only overlap file is `work/events/2026-07.jsonl` (events log). Rebase is trivial UNION.

---

## 6. Dev Report Currency

Dev report (`work/reports/dev/TICKET-41-dev-report.md`) is current: post-merge note added documenting the events-log conflict resolution and the re-verify (380/380, 30/30), CI run 28973531261, advance-auth design record. Implementation log with commit SHA `41a61ad`. Self-verification results. No stale prose.

---

## 7. Findings

### Blocking
None.

### Nits (non-blocking)
1. **NIT — PR body doesn't mention advance-auth deferral.** The plan and dev report document it thoroughly, but a reader of the PR description alone won't know about TICKET-45 or the advance-auth design. Optional: one sentence in the PR body — "Advance endpoint auth deferred to TICKET-45 (screen-token design in `work/plans/TICKET-41-plan.md`)." This is informational only; the deferral is honest and the PR does not claim auth shipped.
2. **NIT — dev report says "20 unit tests"; actual count is 23.** App Tester noted this too. Minor count discrepancy, easily attributed to adding 3 more tests during implementation. Not a correctness issue.

---

## 8. Verdict

**[reviewer] APPROVE** — TICKET-41 is correct, well-tested, and clean.

Evidence: Reviewer ran the full suite independently (npm test 380/380, npm run build green, e2e 30/30 with no flakes). The pure-function watchdog design makes the state machine fully provable at unit level (23 tests, all branches covered). TICKET-18 reliability properties are preserved: single timers per concern, cleared on unmount, handlers attached once, `playerEpoch` recreate pattern is the only mechanism that re-creates the player. The advance route `reason` allowlist is strict. Song_skipped uuid is correctly sourced from the pre-advance head. Auth deferral is honestly documented and not misrepresented. The only merge obstacle is the events-log UNION (code-clean).

The only remaining items before merge: UNION-resolve the `work/events/2026-07.jsonl` conflict (TM), and gate checkboxes in the PR description.
