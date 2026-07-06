# TICKET-7 — Host controls — Dev Report

- **Status:** IMPLEMENTED — build green, 109 unit tests pass, 3 e2e pass locally. Draft PR opened; ready for testing gate.
- **Branch:** `ticket/7-host-controls` · **Worktree:** `.worktrees/ticket-7` · **Base:** `main` (built on merged TICKET-6 persistence)

## What shipped

A venue host can run the night: `/admin` behind a token gate with skip, remove (confirm), button-reorder, and pause — all thin wrappers over the frozen TICKET-6 store ops. The store was not touched.

### Host auth (`lib/host-auth.ts` — single swap point for TICKET-9)

- **Admin-token model.** `HOST_TOKEN` env secret. Host enters it once at `/admin` → `POST /api/host/login` verifies it (timing-safe compare) and sets an **httpOnly** cookie holding an **HMAC-derived session value**, never the raw secret. Every host route calls `requireHost(req, room)`.
- **Locked-safe.** Production with no `HOST_TOKEN` → host controls denied (login 503, all routes 401). Development with no token → a well-known dev fallback token (`cantai-dev-host`, a non-secret constant, dev-only) is accepted so the app + e2e boot with zero secrets, mirroring the store's zero-credential default.
- **Room-scoped from day one** (`resolveRoomToken(roomId)`). TICKET-9 swaps only that lookup to per-room codes; call sites are unchanged.
- Token never reaches the client bundle (`lib/host-auth.ts` is `server-only`; the admin page imports only pure helpers). Verified: `grep` of `.next/static` for token/auth strings is empty (AC #6).

### Routes (`app/api/host/**`, all token-guarded)

`POST /login` (set cookie), `GET/POST /session` (auth probe / logout), `POST /skip` (`advance`), `POST /remove` (`removeEntry`), `POST /reorder` (`reorder`), `POST /pause` (`setPaused`). Each 401s without a valid session cookie; input-validated with body-size caps.

### `/admin` page (`app/admin/**`, `components/host/stats.ts`)

Login gate → dashboard: inert "em breve" mode-switcher placeholder (verbatim design copy, TICKET-10 fills it), queue panel (position/now-playing marker, per-row ▲▼ reorder + ghost-danger **remover** with inline two-step confirm), ⏸ Pausar / ▶ Retomar + ⏭ Pular controls, three stat cards (na fila hoje / cantores / mesas ativas, derived from queue — no new storage) + join-link card. Paused state shows a chip in the top bar. Polls `/api/queue` (3s) like the other surfaces.

### Cross-boundary edits (flagged for sequential merge)

- `app/api/queue/route.ts` GET gains an **additive** `paused` field — the public poll is where every view reads pause. No wave owner conflict.
- `.env.example` appends the `HOST_TOKEN` block (TICKET-6's file, now on main).

## Deferred (coordination — needs #9)

`/tv` **player-pause consumption** of the new `paused` flag is the one-line follow-up the ticket anticipated ("land pause-consumption after #18 merges"). `app/tv/**` is owned by the in-gate TV PR (#9); editing it here would collide. Backend + public `paused` flag are shipped and e2e-verified. The remaining TV edit (freeze the YT player + show a "pausado" overlay when `data.paused`) lands after #9 merges. AC #4's "submits keep working while paused" is already satisfied (pause gates playback only, not intake) and is asserted in e2e.

## Self-verification (local — CI billing-broken, known needs-user)

- **Build:** `npm run build` → ✓ Compiled + type-check + lint clean; `/admin` + 6 `/api/host/*` routes present.
- **Unit:** `npx jest` → `Test Suites: 6 passed`, `Tests: 109 passed` (added host-auth 16, host-stats 3, host-api 15).
- **E2e:** `npx playwright test` → `3 passed` (submit-song + host login→remove→reorder→pause + unauthenticated-401 guard).
- **Token leak:** `grep -rl 'cantai-dev-host|HOST_TOKEN|cantai_host' .next/static` → empty.

## Friction / finding (for the record)

Under `next dev` with the in-memory store, **first-compilation of a route re-evaluates the shared `lib/store` module and resets the singleton** — so state seeded before an as-yet-uncompiled route is hit gets wiped. Reproduced directly: seed 3 via `/api/queue` → 3; then hit the (cold) host routes → `/api/queue` returns 0. This is the documented memory-driver caveat (durable only under Upstash), not a code bug, but it makes cross-route e2e order-sensitive. Fixed in the spec with a `warmUp()` that compiles every route before seeding. Worth a class-level note: memory-driver e2e must warm all routes first (candidate for a shared test helper once more suites need it).

## Acceptance criteria

1. `/admin` no token → login gate only; host APIs 401 without cookie — ✓ (e2e + unit).
2. Remove asks confirm, entry disappears within a poll — ✓ (e2e).
3. Reorder up/down, views converge — ✓ (e2e asserts new order via public poll).
4. Pause freezes TV + visible paused state; submits keep working — **partial:** pause state + flag shipped and reflected in admin + public poll; submits-while-paused ✓; TV player-freeze deferred to post-#9 follow-up (see above).
5. Skip advances mid-video — ✓ (thin `advance` wrapper; e2e + unit).
6. Token never in client JS/source/logs — ✓ (server-only + grep verified; never logged).
7. Mode-switcher inert placeholder — ✓ (disabled, "em breve", no dead controls).
