# Dev Report — TICKET-41 (TV player watchdog + embeddable-only search)

- **Status:** delivered — PR #24 open (draft), CI `build-and-test` SUCCESS, MERGEABLE/CLEAN, awaiting gate chain
- **Worktree:** `.worktrees/ticket-41` · **Branch:** `ticket/41-tv-watchdog` (upstream `origin/ticket/41-tv-watchdog`) · **Port:** 3042
- **PR:** https://github.com/paulosalvatore/boraoke/pull/24

## Post-merge note (2026-07-08)

PR was initially CONFLICTING with main (events-log), which silently suppresses Actions. Merged `origin/main` (conflict: `work/events/2026-07.jsonl` → UNION resolution, 172+172→175 unique lines, no markers; `BOARD.md` auto-merged; zero code overlap — main had moved only on status/events). Post-merge re-verify: `npm test` 25 suites / 380 tests green; `PORT=3042 npm run test:e2e` 30/30 green. CI then ran: `build-and-test` SUCCESS, PR MERGEABLE/CLEAN. Advance-auth design (screen-token vs host-session scope addition) recorded in `work/plans/TICKET-41-plan.md` — decision: screen-token + advance rate-limit as a follow-up ticket, NOT bundled into PR #24 (rationale in plan).

## Picking up from

Fresh Dev, direct TM assignment (TL bug: a song didn't play, TV needed a hard refresh). No prior reports for this ticket. Ticket + plan authored this session from the TM scope directive.

## Exploration summary (2 Explore subagents, done)

- Player: `components/tv/TvScreen.tsx` — YT IFrame API script injected once; player created once (`playerRef` guard), handlers attached at creation only; ENDED → `advance()` (client fetch `POST /api/queue/advance?room=`). NO `onError` handler existed — that's the TL's bug: an unplayable video fires onError, nothing listens, TV sits dead.
- TICKET-18 reliability patterns (opus review of PR #9): one outstanding timer per concern cleared on unmount; no handler re-attachment; idempotent player effect; single poll interval. Preserved.
- Search: `lib/youtube-search.ts` already sent `type=video` + `videoEmbeddable=true`; `videoSyndicated=true` was missing.
- Telemetry: `TELEMETRY_EVENTS` const-locked; `song_skipped` exists (reasons `host|noshow`); client can't emit host events → skip reason rides the advance call as an allowlisted query param, emitted server-side.
- Tests: jest + playwright (PORT-overridable, single worker); TICKET-18 fullscreen prototype-stub is the template for the YT-player stub.

## Plan

`work/plans/TICKET-41-plan.md`. Note: the TM scope directive prescribed the design in detail; treated as the plan approval and proceeded (TL autonomy standing preference) — flagging here for the record.

## Implementation log

**Commit `41a61ad` — TICKET-41: TV player watchdog + embeddable-only search**

1. **`components/tv/watchdog.ts` (new, pure)** — all watchdog decisions with zero React/player deps: `isFatalPlayerError` (2/5/100/101/150); stall machine `createStallState`/`stallTick` (12s no-progress window, `MIN_PROGRESS_SECONDS=0.25`, ladder `replay → reload → recreate → advance`, PAUSED/ENDED benign, absolute clock delta so reload/recreate restarts read as activity, defensive no-advance-loop); `bootstrapRetryDelayMs` (5/10/20s then 30s cap, unlimited).
2. **`components/tv/TvScreen.tsx`** — (a) `onError` attached once at player creation: fatal code → `skipUnplayable()` → amber pt-BR toast "Pulando vídeo indisponível…" (single timed clear) + `advance("unplayable")` + load next; in-flight guard (`skippingRef`). (b) stall poll: one 3s `setInterval` (cleared on unmount) sampling `getPlayerState/getCurrentTime` in try/catch (wedged player = no progress), executing ladder actions; `recreate` destroys the player and bumps `playerEpoch` so the player effect rebuilds deterministically. (c) bootstrap: script injection now retries with backoff on `script.onerror` OR silence past `BOOTSTRAP_READY_TIMEOUT_MS` (10s); failed tag removed before re-inject; `new YT.Player` try/caught so a failed constructor retries on the next effect run. Stall state reset on every video change/skip/ENDED.
3. **`app/api/queue/advance/route.ts`** — allowlisted `?reason=unplayable` → emits existing `song_skipped` with the SKIPPED head's uuid (`store.nowPlaying` read before advance, telemetry-only); `song_played` single-source (C1) unchanged; unknown reasons ignored.
4. **`lib/youtube-search.ts`** — `videoSyndicated=true` (embeddable + type=video already present); comment documents the paste-link gap → watchdog coverage. `lib/telemetry-types.ts` comment updated (reason `unplayable`).
5. **Tests** — `__tests__/tv-watchdog.test.ts` (20 tests: error-code table, ladder walk, benign PAUSED/ENDED/buffering-with-progress, backward-clock activity, wedged player, no-advance-loop, backoff schedule, window sanity 10–15s); `telemetry-instrumentation.test.ts` +3 (reason variant w/ skipped-head uuid, allowlist rejection, empty-queue no-emit); `youtube-search.test.ts` +videoSyndicated lock; `e2e/tv-watchdog.spec.ts` (2 tests: onError 150 → notice + auto-advance with `reason=unplayable` + next song takes stage + notice self-clears; onError 100 skips while non-fatal code 1 does NOT).

**Decisions**

- **Paste-verify: DEFERRED** (plan §5): patron form is TICKET-40's file (live parallel work → guaranteed conflict); watchdog onError covers unplayable pastes at play time; saves 1 quota unit + 1 RTT per paste. Follow-up filed in plan for after TICKET-40 merges.
- **Telemetry:** no new event types — `song_skipped` props variant `reason: "unplayable"`, emitted server-side off the allowlisted advance param (client `track()` is server-only by design).

## Self-verification

- **Unit:** `npm test` → **25 suites, 380 tests, all passing** (`work/evidence/ticket-41/unit-tests-output.txt`).
- **Build:** `npm run build` → green.
- **e2e:** `PORT=3042 npm run test:e2e` → **30 passed** (`work/evidence/ticket-41/e2e-tests-output.txt`). First run had 1 failure in the PRE-EXISTING `tv.spec.ts` playing-state test — the documented memory-driver first-compile reset flake (see `playwright.config.ts` comment); it passes in isolation and in the full re-run (2× 30/30). Not a regression from this branch.
- **Visual evidence:** `work/evidence/ticket-41/01-skip-notice-unplayable-video.png` — 1080p TV showing the amber "Pulando vídeo indisponível…" toast while skipping a blocked video, next singer on the rail.
- **Servers:** dev server on 3042 stopped after capture; ports clean.

## Overlap note (TICKET-40)

TICKET-40 owns `components/SongSearch.tsx` + patron form + `/api/search` QUERY augmentation. This branch touches `lib/youtube-search.ts` only in the filter-param block (one param + comment) + one test assertion — additive and isolated. Merge sequentially; whichever lands second rebases trivially.

## Friction

- One-off evidence-capture script couldn't resolve `@playwright/test` from the scratchpad dir (Node ESM resolves from the script's location, not cwd) — copied into the worktree to run, then removed. Minor.
