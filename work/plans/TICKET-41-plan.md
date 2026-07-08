# TICKET-41 Plan — TV player watchdog + embeddable-only search

- **Dev:** Dev agent (session 2026-07-08) · **Worktree:** `.worktrees/ticket-41` · **Branch:** `ticket/41-tv-watchdog` · **App port:** 3042
- **Status:** implemented per TM-directed scope (the ticket text prescribed the design; treating the TM scope directive as the plan approval — noted for the record)
- **APPROVED-BY:** auto-approved (no plan-gate escalation — design prescribed by the TM scope directive) — validated downstream by gates + TL merge of PR #24

## Approach

### 1. Pure watchdog module — `components/tv/watchdog.ts`

All decision logic extracted as pure functions (no React, no timers, no player handle) so it's unit-testable exactly as the ticket asks:

- `isFatalPlayerError(code)` — codes 2, 5, 100 (bad/removed) and 101, 150 (embedding disabled) → true.
- **Stall machine:** `createStallState(now)` + `stallTick(state, sample)` where `sample = { playerState, currentTime, now }`. Returns `{ state, action }` with `action ∈ none | replay | reload | recreate | advance`.
  - Progress (currentTime moved ≥ MIN_PROGRESS_SECONDS) or ENDED → reset ladder.
  - PAUSED → benign (host paused by design), window timer resets so a later resume gets a fresh window.
  - BUFFERING with progress → benign; BUFFERING/PLAYING/UNSTARTED/CUED without progress for `STALL_WINDOW_MS` (12s) → escalate one rung and re-arm the window.
  - Ladder: `replay` (seek+play) → `reload` (loadVideoById) → `recreate` (destroy+new player) → `advance` (skip the song), then reset.
- **Bootstrap backoff:** `bootstrapRetryDelayMs(attempt)` — 5s, 10s, 20s, then 30s forever (capped, unlimited retries: the TV must never sit dead; a venue-wifi outage eventually heals).

### 2. TvScreen integration (`components/tv/TvScreen.tsx`)

- `onError` player event handler (attached ONCE at player creation, same as existing handlers — no accumulation): fatal code → set pt-BR notice "Pulando vídeo indisponível…" (single timed clear, chrome-timer hygiene pattern) → `advance("unplayable")` → load next.
- Stall poll: one `setInterval` (3s cadence, mirrors the queue poll pattern), cleared on unmount; reads `getPlayerState()`/`getCurrentTime()` inside try/catch (a wedged/destroyed player counts as no-progress); executes ladder actions via refs. State reset whenever the loaded videoId changes.
- Bootstrap retry: if `ytReady` hasn't flipped within the window, remove the failed script tag and re-inject with backoff (single timeout ref, cleared on unmount). Player-never-ready is covered by the stall ladder's `recreate` rung (creation wrapped in try/catch).
- `advance(reason?)` gains an optional reason forwarded as `&reason=unplayable` on the POST.

### 3. Server: `app/api/queue/advance/route.ts` (additive)

- Accept optional `reason` query param, allowlisted to `unplayable`. When present, emit existing `song_skipped` event with `props.reason = "unplayable"` (a props VARIANT on an existing event — the const-locked `TELEMETRY_EVENTS` list is untouched). `song_played` for the next entry unchanged.
- Client-side `track()` is server-only and `CLIENT_ALLOWED_EVENTS` is just `patron_joined` — routing the skip reason through the advance call is the no-new-surface way to get watchdog telemetry.

### 4. Search filter params — `lib/youtube-search.ts` (additive, isolated)

- `videoEmbeddable=true` + `type=video` already present (shipped earlier). Add `videoSyndicated=true` only. Test locks all three.
- **TICKET-40 overlap:** they own `/api/search` QUERY augmentation + `components/SongSearch.tsx`; my diff touches only the filter-param block in `lib/youtube-search.ts` + its test. Noted in the PR for sequential merge.

### 5. Paste-verify decision — DEFERRED (documented call)

Optional pasted-id embeddability pre-check (videos.list `status`, 1 unit) + pt-BR patron warning is **not** implemented in this ticket:

1. **File-ownership collision:** the warning UI lives in the patron form / submit flow — TICKET-40's files, being changed in parallel right now. Touching them guarantees a conflict.
2. **Coverage:** the watchdog's onError path already handles unplayable pastes at play time (skip + telemetry), so the pre-check is UX polish, not a reliability gap.
3. **Cost:** +1 quota unit and +1 round-trip on every paste submit for a rare case.

Follow-up candidate after TICKET-40 merges: server-side `status.embeddable` check in `/api/queue` POST returning a non-blocking `warning` field, patron form rendering "esse vídeo não permite reprodução em telões — pode não tocar".

## Files touched

- `components/tv/watchdog.ts` (new, pure module)
- `components/tv/TvScreen.tsx` (onError + stall poll + bootstrap retry + skip notice)
- `components/tv/tv.module.css` (skip-notice style, additive)
- `app/api/queue/advance/route.ts` (reason param → song_skipped variant)
- `lib/youtube-search.ts` (one line: videoSyndicated)
- `lib/telemetry-types.ts` (comment-only: document the new reason variant next to the existing ones)
- `__tests__/tv-watchdog.test.ts` (new), `__tests__/youtube-search.test.ts` (+params), `__tests__/api-queue.test.ts` or new advance test (+reason variant)
- `e2e/tv-watchdog.spec.ts` (new, YT-player prototype-stub → onError → auto-advance)

## Risks

- Stall heuristics vs. real-world pauses: mitigated by treating PAUSED as benign and requiring an escalation LADDER (4 rungs) before skipping a song.
- YT type surface: `getPlayerState/getCurrentTime/seekTo/playVideo` added to the local `YTPlayer` interface; all calls try/catch-wrapped.
- e2e determinism: onError path only (stall windows are unit-tested); player stubbed via the TICKET-18 `addInitScript` prototype-stub pattern.

## Advance-auth design (scope addition — decision recorded, implementation deferred to follow-up)

The TL bug exposed a second issue on the same surface: `POST /api/queue/advance` is unauthenticated (TICKET-1 security INFO, accepted-for-prototype) — any patron who reads the QR knows the room slug and can curl-skip the current singer. Decision requested: **screen-token vs host-session**.

**Constraints:** the TV is a zero-login public URL (`/[room]/tv` — venue staff just opens it; that UX must survive); Vercel serverless + memory/Upstash store duality → verification must be stateless; the existing host-session cookie is `httpOnly` and **path-scoped to `/api/host`**, so it is not even sent on `/api/queue/advance` today.

**Options weighed:**

1. **Host-session (`requireHost`) on advance** — strongest, but breaks the zero-login TV: the venue would have to host-login the TV browser, and the cookie path would need re-scoping. Friction on the core "open a URL on the TV" flow. Rejected as the primary gate.
2. **Screen-token (RECOMMENDED)** — the `/[room]/tv` server component already resolves the room server-side; it additionally mints a stateless HMAC token: `HMAC-SHA256(key = room.hostCodeHash (server-only, never leaves the server), msg = "boraoke-screen-v1|roomId|<24h expiry bucket>")`, passes it to `TvScreen` as a prop; the TV sends it as an `X-Boraoke-Screen` header on advance. The route recomputes + `timingSafeEqual`s (accepting current + previous bucket for rollover), and ALSO accepts a valid host session (host tools keep working). Legacy `default` room keys off `HOST_TOKEN`; when no key material exists (dev/CI), enforcement is off. Rollout flag-gated: log-only first, then enforce.
   - Honest threat note: `/[room]/tv` is a public page, so a determined attacker can scrape a token from its HTML. The screen-token raises the bar from "one curl" to "fetch + parse the TV page", which kills the casual/patron-prank class — the class that actually threatens a venue night.
3. **Rate-limit-only** — no auth change; per-room throttle on advance (e.g. min 5s between advances, per the existing `queue-rate-limit.ts` pattern). Cheapest, blunts skip-spam, stops nothing targeted.

**Decision: 2 + 3 combined** (screen-token, flag-gated, plus a per-room advance throttle as defense-in-depth), implemented as a **follow-up ticket, not in PR #24**: enforcing auth on advance breaks every e2e helper that drains the queue via bare `POST /api/queue/advance` (all spec files) and needs its own migration/test rework — bolting that onto a delivery-time merge is how a live venue TV breaks mid-night. The watchdog (this PR) is independent of it and ships now.

## Test strategy

Unit (jest): error-code table; ladder transitions incl. benign PAUSED/buffering-with-progress; progress resets; backoff schedule; search params; advance reason → song_skipped. e2e (playwright, PORT=3042): stub `window.YT`, seed 2-entry queue, fire onError(150), assert skip notice + advance call with `reason=unplayable` + next entry becomes hero.
