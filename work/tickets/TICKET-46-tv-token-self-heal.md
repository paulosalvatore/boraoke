# TICKET-46 — Kiosk-TV screen-token self-heal

**Source:** F1 follow-up from PR #26 opus review (advance-auth / TICKET-45). MED.

**Board note (verbatim):** "kiosk-TV token self-heal — a TV page that never reloads outlives its ≤48h screen token and wedges silently under enforce (no watchdog rung reloads the PAGE). Add client-side token-age self-heal (page reload or token refetch). Until fixed, the enforce-flip runbook REQUIRES reloading every deployed venue TV after the flip."

## Problem

The TV page (`app/(patron)/[room]/tv/page.tsx`) mints an HMAC screen-token **server-side at page-load** (`mintScreenToken`, `force-dynamic`) and passes it to `TvScreen` as a static prop. A venue kiosk TV commonly runs for **days without a reload**. The token is valid for its 24h bucket plus the previous bucket (`SCREEN_TOKEN_BUCKET_MS = 24h` in `lib/screen-token.ts`) — i.e. **≤48h effective**. After that, once `ADVANCE_AUTH=enforce` is set in prod, `/api/queue/advance` returns **401**, the `advance()` callback in `TvScreen.tsx` silently swallows it (`catch { return null }` and it doesn't even check the advance response status today), and the queue **wedges silently** — no more auto-advance, watchdog skips, or manual skips work, with zero user-facing signal.

Currently there is **no** client-side token-age tracking or 401 recovery anywhere (confirmed: zero hits for age/expiry checks in `components/tv/`).

## Goal

Make the kiosk TV heal itself so an unattended page never outlives its token under enforce — **removing the "hard-reload every venue TV after the enforce flip" operational requirement** from the runbook.

## Scope & approach (implement both layers; keep it small and race-safe)

**Layer 1 — Proactive reload-when-old-AND-idle (primary).**
- Pass the token's **mint time** (or its bucket index) from the server page to `TvScreen` so the client can compute token age. Prefer a plain `screenTokenMintedAt` (ms epoch) prop derived at mint time next to `mintScreenToken(room)`; do NOT expose the secret or any signing material.
- On the client, when the token age crosses a **safe refresh threshold well before the 48h expiry** (suggest ~**20h**, comfortably inside the first bucket so a reload always lands on a fresh token) **AND the player is idle** (no song currently playing — reuse the existing idle/now-playing state), trigger a **full `window.location.reload()`**. Reloading while idle re-mints a fresh token via `force-dynamic` without interrupting anyone's song.
- Never reload mid-playback (would cut off the current singer). If the token is old but a song is playing, wait for the next idle window. A busy venue naturally reaches idle between songs long before 48h; document this reasoning in a comment.

**Layer 2 — Reactive reload-on-auth-failure (backstop).**
- Have `advance()` actually **check the advance fetch's `res.status`**. If it is **401** (token rejected under enforce), trigger a **guarded** `window.location.reload()` as a last-resort self-heal.
- **Guard against reload storms:** use a `sessionStorage` one-shot marker (e.g. `boraoke-tv-selfheal-reload` = timestamp) so the page reloads **at most once per N minutes** (suggest ≥5 min). A genuinely bad config (e.g. secret rotated so every fresh token 401s) must NOT hot-loop the page — after one reload attempt within the window, stop and fail quietly (the existing silent behavior) rather than spin. Clear/re-evaluate the marker on a successful advance.

## Constraints

- **Deploy-safe, behavior-neutral in log mode.** Default `ADVANCE_AUTH` is log-mode; in log-mode advance never 401s, so Layer 2 stays dormant and Layer 1's only effect is an occasional idle reload of a >20h-old page — harmless. No behavior change for the current production default.
- No new server endpoint required — a full page reload re-mints via the existing `force-dynamic` page. (Do not build a token-refetch API unless the reload approach proves insufficient; keep scope minimal.)
- No secret / signing material sent to the client. Only a mint timestamp.
- Keep the change confined to `app/(patron)/[room]/tv/page.tsx`, `components/tv/TvScreen.tsx`, and tests. Do not touch the moderation code (PR #25 / ticket-44) or brand assets.

## Tests (required)

- **Unit** (`__tests__/`): the self-heal decision logic must be extracted into a **pure, testable helper** (e.g. `shouldSelfHealReload({ tokenAgeMs, isPlaying, lastReloadAt, now })`) so it can be unit-tested without a DOM. Cover: (a) old token + idle → reload; (b) old token + playing → no reload; (c) fresh token + idle → no reload; (d) 401 backstop respects the sessionStorage debounce window (no storm); (e) boundary around the ~20h threshold.
- Keep the full existing suite green (was 462/462 on main). Build + typecheck + lint clean.
- e2e: not strictly required (48h time-travel is awkward in Playwright), but if a bounded assertion is cheap, add one. Otherwise rely on the pure-helper unit coverage and note the e2e gap in the dev report.

## Non-goals

- Not changing the token TTL, the bucket scheme, or the enforce/log flag.
- Not the enforce flip itself (separate TM runbook action).
- Not the other TICKET-45 follow-up (F2, unplayable rate-charge exemption) — separate ticket.
