# TICKET-31 — Admin dashboard / analytics (read-only)

- **Product:** boraoke
- **Status:** draft → in progress
- **Priority:** requested twice by the TL (see `work/status/BOARD.md` history and `work/planning/boraoke-roadmap-reconciliation.md`, P1 of the growth arc) — "all karaoke days, musics played" analytics.
- **TL directive (verbatim intent, binding):** a read-only view of all karaoke days and songs played.

## What to build

A READ-ONLY admin analytics view over the existing telemetry data:

1. Karaoke sessions/days over time — how many days had karaoke, session counts, active rooms per day, across a flexible date range.
2. Songs played — counts over time, and TOP SONGS (most-played, by title/videoId).
3. Rooms/venues activity — per-room breakdown (events, patrons, songs queued/played/skipped, sessions, active days).

## What already existed (reused, not rebuilt)

- `lib/telemetry-types.ts` — raw event schema, `dayRange()`, `telemetryKeys`.
- `lib/telemetry-store.ts` — `TelemetryStore.listRange(fromDay, toDay)` (memory + Upstash drivers, `STORE_DRIVER` env).
- `lib/telemetry-rollup.ts` — the WEEKLY, file-based rollup (`scripts/telemetry-rollup.ts` → `work/telemetry/rollups/<week>.md`). Its per-room session-splitting logic (`>SESSION_GAP_MS` gap rule) was factored out into a new exported `countSessions()` helper so both the weekly rollup and the new live analytics aggregation share ONE definition of "a session" instead of duplicating the loop.
- `lib/host-auth.ts` — the per-room HOST_TOKEN admin-auth model (`requireHost`, `resolveRoomToken`, `hostCookieName`, etc.) — untouched, reused as-is (see Auth decision below).

## New in this ticket

- `lib/analytics.ts` — pure aggregation (`computeAnalytics(events, fromDay, toDay, opts)`): a days-over-time series (`DayActivity[]`), top-N songs by play count (`TopSong[]`), and a per-room breakdown (`RoomActivity[]`). Takes raw events over an arbitrary day range (not fixed to an ISO week like the rollup); reuses `countSessions`/`dayRange` exactly like the rollup script does.
- `app/api/host/analytics/route.ts` — `GET ?from=&to=&topSongs=` — auth-gated (see below), reads via `telemetryStore.listRange`, calls `computeAnalytics`, returns JSON. Zero writes to any store. **Route location is load-bearing:** it MUST live under `/api/host/*` so the host session cookie (scoped to `HOST_COOKIE_PATH="/api/host"`) is actually sent by a real browser — an earlier draft at `/api/admin/analytics` was outside the cookie scope, so a logged-in host's browser never attached the cookie and every request 401'd (App Tester real-browser catch; unit tests missed it because they set the cookie directly on mock requests). A path-scope regression test now guards this.
- `app/admin/analytics/page.tsx` + `analytics.module.css` — client page: login gate (reuses the existing host-login flow), date-range controls, a days-over-time bar strip, a top-songs table, and a per-room table.
- `app/api/queue/advance/route.ts` — additive telemetry fix (see "Known gap closed" below).

## Auth decision (documented per the ticket brief)

The new `/admin/analytics` surface and its `/api/admin/analytics` route are gated by the **same host-session mechanism** as `/[room]/admin`, scoped to the `default` room — i.e. the site's existing `HOST_TOKEN` secret (the pre-multi-room `/admin` was already this site's single global admin surface; `default`'s token is the natural site-wide admin secret). Concretely:

- `GET /api/host/analytics` calls `requireHost(req, DEFAULT_ROOM)` — the exact same function every other host route calls, just checked against `DEFAULT_ROOM` instead of a real venue id. It lives under `/api/host/*` precisely so it shares the host cookie's path scope (see above).
- The page reuses the EXISTING `/api/host/login?room=default` and `/api/host/session?room=default` endpoints for the login gate — no new login endpoint, no new secret, no new cookie name (`cantai_host`, the legacy `default`-room cookie).
- This is fail-closed in production exactly like every other host route: if `HOST_TOKEN` is unset in prod, `/admin/analytics` is locked (same "host controls are not configured" message as `/[room]/admin`).
- Per-room host auth is untouched — `lib/host-auth.ts` has zero code changes.
- No new attack surface: this reuses an existing auth primitive for a new READ-ONLY route; there is no new write path or new secret to reason about.

## Title-gap decision (documented per the ticket brief)

`song_played` (emitted in `app/api/queue/advance/route.ts`) previously carried only `props: { mode }` — no `videoId`, so "top songs" could not be computed from telemetry. **Closed, not skipped:** the event now also includes `videoId` and (when the patron supplied one) `title`, sourced directly from the `QueueEntry` already resolved by `store.advance()` — no new read, no live-data write path, purely an additive prop on an existing fire-and-forget telemetry emit. `sanitizeProps` (existing `MAX_PROP_KEYS=8`, `MAX_PROP_STRING=64`) truncates/guards both fields exactly like every other prop; when `title` is undefined, `sanitizeProps` drops the key entirely (no `title: undefined` written), so this is backward-compatible with historical events (pre-TICKET-31 `song_played` rows have no `videoId` — `computeAnalytics` buckets those under a synthetic `"unknown"` videoId row rather than dropping them, so the top-songs table stays honest about the small blind spot for old data instead of silently undercounting).

## Explicitly out of scope (per the ticket brief)

- Per-patron identity enrichment (TICKET-26/28 territory) — `lib/analytics.ts` has a comment noting `RoomActivity` is the seam a future identity lookup could join against; not built here.
- Any mutation UI, delete/reset/clear endpoints, or write path beyond the one additive `song_played` prop.
- `app/admin/page.tsx` (the legacy `/default/admin` redirect) — untouched; analytics lives at a fresh route, `/admin/analytics`.
- i18n: this page is English-only. It is internal TL-facing tooling, not patron-facing UI (unlike `/[room]/admin`, which follows the app's i18n convention because it shares locale context with patron-facing pages this ticket does not touch). A documented, deliberate scope call — flag if this should change.

## Acceptance criteria

1. `/admin/analytics` is unreachable without a valid `default`-room host session (401 from the API route; the page shows the login gate).
2. The days-over-time series correctly buckets events into UTC days for an arbitrary `[from, to]` range, including days with zero events (shown as zero, not omitted).
3. Top songs are ranked by play count, ties broken deterministically (videoId ascending); a `title` is shown when telemetry recorded one, falling back to videoId otherwise.
4. Per-room breakdown sums match the sum of daily figures for the same range (no double-counting/undercounting across the day-vs-room grouping).
5. Zero writes: the aggregation function and the API route never call any store's write/mutate methods.
6. `song_played` events emitted going forward carry `videoId` (+ `title` when available); historical events without it are still counted, under an "unknown" videoId bucket.

## Tests

- `__tests__/analytics.test.ts` — day-range bucketing (including zero-event days), top-songs ranking + tie-break, per-room breakdown correctness, cross-check that room-sum totals equal day-sum totals, and the `"unknown"`-videoId fallback for events with no `videoId` prop.
- `__tests__/queue-advance-song-played-props.test.ts` — asserts `POST /api/queue/advance` emits `song_played` with `videoId` (and `title` when the entry has one) in its telemetry props.

## Gate chain

Dev → App Tester (visual: login gate + dashboard render, read-only — no live-data mutation to verify) → Reviewer. Deliver as a draft PR — every boraoke `main` merge is a live prod deploy, so do NOT auto-merge; hand off to the Tech Lead / Tech Manager for merge confirmation per the existing gate-chain convention.
