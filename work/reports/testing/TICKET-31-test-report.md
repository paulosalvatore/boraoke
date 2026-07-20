# TICKET-31 — Admin analytics dashboard — App Tester report

**Verdict: FAIL** (HIGH-severity functional defect: an authenticated host sees zero data).

## Environment
- Worktree: `.worktrees/31-admin-analytics`, branch `ticket/31-admin-analytics`, clean tree.
- Server: **production build** (`npm run build` + `npm run start`) on **port 3040**, started with `HOST_TOKEN=gatetoken123`.
- Why prod build, not `next dev`: under `next dev` each API route is bundled separately, so the in-process **memory** telemetry singleton is NOT shared between the writing routes (`/api/rooms`, `/api/queue`, `/api/queue/advance`) and the reading route (`/api/admin/analytics`) — driving the real flow left analytics at `totalEvents: 0`. `next start` runs all routes in one shared module registry, so real-flow seeding populates analytics (production uses shared Upstash, so this is a dev-harness constraint, not a product issue).
- Why `HOST_TOKEN` set: prod `NODE_ENV=production` rejects the dev-fallback token (`lib/host-auth.ts` locks host controls unless `HOST_TOKEN` is configured), so I supplied a token and logged in with it.

## How telemetry was seeded (honest, real-flow)
Drove the real API end-to-end (no direct store poke): created 2 rooms (`bar-do-ze`, `boteco-lua`) via `POST /api/rooms`; submitted songs via `POST /api/queue` (paste path with real videoIds/titles — no YouTube key needed); advanced each room's queue via `POST /api/queue/advance` (default-room advance is fail-open in `ADVANCE_AUTH=log`) to emit `song_played` carrying the new `videoId`/`title` props. Result: 29 events across 3 rooms, top-song ranking Evidencias×3, Bohemian Rhapsody×2, Garota de Ipanema×2, etc. This also smoke-tests the additive `song_played` videoId/title change end-to-end — it works.

## Evidence (`work/evidence/ticket-31/`)
1. `01-unauthenticated-gate-desktop.png` — unauthenticated `/admin/analytics` shows only the host-token login form. No data leak. PASS.
2. `02-authed-but-unauthorized-desktop.png` — **THE BUG.** After a successful UI login (header shows "read-only", so the session check passed), the data area shows **"Unauthorized"**. No metric groups render.
3. `03-authed-but-unauthorized-mobile.png` — same bug at 390px.
4. `04-populated-desktop.png` — intended render (see workaround note): all three groups present — Karaoke days stat row + per-day bars; Top songs table with real titles + video IDs + plays; per-room activity table. Coherent, legible.
5. `05-populated-mobile.png` — reflows to single column; the 8-column Rooms table is cramped and clipped at the right edge on mobile (minor follow-up, not a blocker).
6. `06-empty-state-desktop.png` — empty range (2026-05-01→10): zero stat tiles, "No songs played in range.", "No room activity in range." Graceful, no crash. PASS.

## THE DEFECT (HIGH) — host session cookie is path-scoped away from the analytics endpoint
- Repro: log in via the real `/admin/analytics` form with the valid host token → dashboard shell renders but data reads **401 "Unauthorized"**; on reload the page stays authed (no re-login) yet data still 401s.
- Root cause: the host session cookie is set with `path=/api/host` (`HOST_COOKIE_PATH` in `lib/host-auth.ts`, comment: "only the `/api/host/*` routes ever read it"). The **new** analytics endpoint lives at `/api/admin/analytics` — outside that path prefix — so the browser never attaches the cookie, and `requireHost` sees no cookie → 401. The page's own session check (`/api/host/session`, under `/api/host`) DOES get the cookie, so the UI wrongly believes it's authed and renders the shell before the data fetch fails.
- Proof it's the path, not the logic: sending the same session value with an unscoped (`path=/`) cookie makes `/api/admin/analytics` return the full dataset (that's how screenshots 04–06 were produced) — a deliberate harness workaround for this bug, noted as such.
- Why the unit tests (20/20 green) missed it: `__tests__/api-admin-analytics.test.ts` sets the cookie directly on a mock `NextRequest` regardless of path, so it never exercises the browser's path-based send rule.
- Fix direction (Dev's call): serve analytics under the `/api/host/*` prefix, OR widen the host cookie path to `/` (or `/api`), OR mint an appropriately-scoped cookie for this route. A gate for "logged-in host actually loads data in a browser" should be added.

## Console
- Only relevant app error is the 401 on `/api/admin/analytics` (and the expected pre-login 401 on `/api/host/session`, which the app handles to show the gate — benign). No JS exceptions. (Other console noise — hosts 3141/3333/3008 — is from unrelated tabs in the shared browser, not boraoke.)

## Acceptance-criteria check
- (a) three metric groups render — YES, but only via the cookie workaround; **NO in the real logged-in browser flow** (blocked by the defect).
- (b) top-songs shows real titles now that song_played carries videoId/title — YES (Evidencias/Bohemian/Garota etc.).
- (c) no console errors — the only app error is the defect's 401.
- (d) empty state graceful — YES.
- (e) unauthenticated access denied — YES (gate, no leak; API 401).
- (f) visually coherent on mobile + desktop — YES desktop; mobile OK except Rooms table clips right edge (follow-up).

## Follow-ups (non-blocking)
- Rooms table (8 columns) overflows/clips on mobile — wrap in a horizontal-scroll container.
