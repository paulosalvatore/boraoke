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

---

## 9. D-022 OPUS MERGE-COUNTING PASS (second tier — the all-night-promise audit)

**Reviewer:** Reviewer agent, opus tier (`claude-opus-4-8`). This is the APPROVE that counts for merge (D-022). Framing: the TL's TV died mid-night once; this merge is the promise it never happens again. Judged against that promise, adversarially.

### 9.1 Independent re-verification (ran myself, this worktree)

- `npx jest` → **25 suites, 380/380 green** (1.7s).
- `npm run build` → **green** (Next.js production build, all routes compiled including `/tv`, `/api/queue/advance`).
- `npx playwright test` → **30/30 green** (1.3m, incl. the two `tv-watchdog.spec.ts` onError e2e tests). No flakes.

Sonnet's numbers reproduced exactly.

### 9.2 Adversarial walk of a 6-hour night — REAL vs THEORETICAL

**(a) A video that plays 2s then stalls repeatedly (ad-injection / throttled wifi).** Traced the ladder. Any poll sample with ≥`MIN_PROGRESS_SECONDS` (0.25s) of `getCurrentTime()` movement resets `escalation` to 0. So a video that plays a spurt, stalls 12s, gets a `replay` nudge, plays another spurt → the ladder resets to rung 0 on every spurt. **It does NOT thrash replay→reload→recreate on every such video** — it re-arms at `replay` (the cheapest, visually-gentle rung) as long as *any* real progress keeps happening. This is the correct, deliberate edge: a video making genuine (if slow) progress should not be hard-skipped. The only cost is that a pathologically-stuttering-but-progressing stream keeps getting gentle `replay` nudges rather than being skipped — acceptable, because it IS advancing and a skip would punish a song that's merely on bad wifi. **Real finding: NONE — behavior is correct by design.** Documented here so the edge is on the record.

**(b) What the venue SEES during a 12s stall window.** No app-level black overlay and no skip toast fire *during* the stall window — I confirmed via `tv.module.css` that `.skipNotice` is a small amber pill (top-14vh/right-3vw), shown only once `skipUnplayable` actually fires (onError or ladder-top). During the 12s no-progress window the YT iframe shows **its own native buffering spinner / last frame** — not black. So the crowd sees at most 12s of YouTube's normal buffering UI before the first *invisible* `replay` nudge (a `seekTo(current)+playVideo`, imperceptible if it succeeds). 12s of frozen-but-spinning karaoke reads as "buffering," not "broken." **Verdict: acceptable venue UX.**

**(c) Repeated stalls across consecutive videos — per-video rung reset.** Verified rung state resets per video at **every** advance boundary: `stallStateRef.current = createStallState(Date.now())` is called in the `onStateChange` ENDED path, in `skipUnplayable`, and in the player-effect's load-new-video branch. So video N's climbed rungs never leak into video N+1. The no-advance-loop guard (`rung >= ESCALATION_LADDER.length` → reset to 0, action `none`) re-arms correctly: after the `advance` rung fires, `skipUnplayable` recreates fresh stall state, so the guard's defensive branch is a belt-and-suspenders that the unit test "never loops advance" exercises directly. **Real finding: NONE — per-video isolation and re-arm are both correct.**

**(d) Genuinely dead network for 10 minutes (bootstrap AND queue poll both failing).** Walked both code paths:
- *Bootstrap:* `inject()` retries the YT API script on `script.onerror` and on ready-timeout, backoff 5/10/20/30s capped-but-unlimited (`bootstrapRetryDelayMs`). Never sits dead. When wifi heals, `onYouTubeIframeAPIReady` fires → `ytReady=true` → player effect creates the player.
- *Queue poll:* `fetchQueue`'s `catch {}` is silent and does NOT call `setQueue`, so the **last-known-good queue persists on screen** through the outage (the TV keeps showing the last now-playing card rather than blanking). Retries every 3s.
- *Watchdog during the outage:* if a player already exists and stalls, the ladder may reach the `advance` rung → `skipUnplayable` → `advance()` does `fetch(/api/queue/advance)` which **throws (network dead) → caught → returns null → server queue is untouched.** So a dead-network stall produces NO spurious server-side advance; the head is preserved. When wifi heals, the next queue poll returns the same head and the player effect reloads it. **Clean reconnection, no data loss, no phantom skips.** Real finding: NONE.

### 9.3 The 12s threshold — TL-experience ruling

**BLESSED.** Rationale: YouTube's own player will spin on a wedged stream *indefinitely* without ever self-recovering to a different video — that is precisely the failure that killed the TL's TV. 12s before the first (invisible) `replay` is long enough that ordinary transient buffering — an ad, a slow segment, a 3–5s wifi hiccup — resolves on its own with zero intervention, and short enough that a truly wedged stream gets nudged before the crowd notices. The first two rungs (`replay`, `reload`) are visually gentle; only after 4×12s ≈ **48s of sustained no-progress** does the watchdog hard-skip. That 48s-to-skip is well-judged patience: it never nukes a merely-slow video, yet guarantees recovery within ~1 minute of a genuine stall. A tighter window would fight YouTube's normal buffering and cause spurious skips; a looser one would leave the crowd staring. 12s is the right number.

### 9.4 The reason-param C1 interaction under the watchdog-advance vs host-skip RACE

Re-audited the race the brief flagged: watchdog-advance (`POST /api/queue/advance?reason=unplayable`) colliding with host-skip (`POST /api/host/skip`), both targeting head X.

- Store `advance` is atomic `LPOP` + `LINDEX 0` (upstash) / `shift()` (memory). `nowPlaying` is a non-mutating `LINDEX 0`.
- **`song_played` single-source is intact:** grepped all emitters — the ONLY `song_played` source is `advance/route.ts`. `host/skip` does NOT emit `song_played`. So the C1 invariant (one `song_played` source) survives this ticket. Confirmed.
- **The loser's telemetry does NOT emit for an entry that didn't skip in the double-LPOP sense:** the watchdog route reads `skipped = nowPlaying` *before* its own `advance`, and only emits `song_skipped` when `skipped` is non-null. Under a true simultaneous double-LPOP, X and Y are both physically removed — both `song_skipped` emissions (reason=unplayable for X, reason=host for the head the host route read) correspond to entries that WERE removed. There is no phantom `song_skipped` for an entry still in the queue.
- **The one honest edge:** if host-skip's LPOP lands in the tiny window between the watchdog's `nowPlaying` read and its own LPOP, the watchdog's LPOP removes what is now Y while its telemetry is attributed to X → a *mis-attributed* (not phantom) `song_skipped`, and Y is dropped un-announced. This is **fire-and-forget telemetry mis-attribution under a sub-millisecond race between two rare human/automated skip events on the identical head** — and it is **pre-existing** (the host-skip-vs-TV-end-advance race already had identical LPOP semantics before this ticket; TICKET-41 adds one more advance caller, not a new class of race). It does not corrupt queue state beyond the inherent double-skip that any concurrent-advance design has, does not break C1, and does not affect a route's response. **Not a blocker.** Filed as an observation for a future atomic compare-and-advance (skip-by-id) hardening if telemetry precision under concurrent skips ever matters — out of scope for the all-night-promise, which is about *self-healing*, not race-exact telemetry.

### 9.5 Zero-overlap claim vs post-#21/#22 main — VERIFIED BY DIFF

Merge-base is `5943a10`, which is **after** #21 (TICKET-40 `af156a7`) and #22 (TICKET-43 `b97289e`) on `origin/main` — the branch is already based on post-#21/#22 main. `comm -12` of files-changed-on-main-since-base ∩ files-changed-on-branch yields **exactly one file: `work/events/2026-07.jsonl`** (append-only log, UNION-resolvable, non-code). Zero code-file conflicts. The one file shared with TICKET-40's declared lane (`lib/youtube-search.ts`) is a purely additive single-param change (`videoSyndicated=true`) — TICKET-40 did not touch that file, so no conflict. **Zero-overlap claim CONFIRMED.**

### 9.6 Opus-pass findings

- **Blocking:** none.
- **Observation (non-blocking, future ticket):** telemetry mis-attribution under the sub-ms watchdog-advance vs host-skip race on the identical head (§9.4). Pre-existing class, fire-and-forget only, C1 intact. Candidate for a skip-by-id atomic advance if precise concurrent-skip telemetry is ever wanted.
- Both sonnet-pass NITs (PR body advance-auth mention; "20 vs 23 tests" count) stand as-is — informational, non-blocking.

### 9.7 OPUS VERDICT

**[reviewer] APPROVE (D-022 opus, merge-counting).** The all-night promise is kept: every failure mode I could construct across a 6-hour night — fatal onError, intermittent-progress stutter, per-video repeated stalls, a 10-minute dead network hitting both bootstrap and queue poll — self-heals without a human refresh and reconnects clean when wifi returns. 12s is the right patience. C1 `song_played` single-source survives; the reason-param is strictly allowlisted (XSS-tested). Zero code-overlap with post-#21/#22 main, confirmed by diff. 380/380 + 30/30 + build green, reproduced independently. The only merge action is the routine `work/events/2026-07.jsonl` UNION resolve (TM).
