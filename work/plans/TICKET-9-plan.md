# TICKET-9 — Plan (multi-room + QR join + table capture)

- **Status:** self-approved under autonomous delegation (spawned Dev, full ticket brief from TM). Record-only.
- **APPROVED-BY:** auto-approved (no plan-gate escalation) — validated downstream by gates + TL merge of PR #13.
- **Branch:** `ticket/9-rooms-qr` · worktree `.worktrees/ticket-9` · app port 3013.

## Approach

### Room model & persistence — `lib/rooms.ts` (new)
- `Room = { id, name, hostCode, createdAt, settings: { mode } }`.
- Cannot extend the frozen `QueueStore` (must-not-touch `lib/store/**`), so rooms get a **parallel** persistence module using the SAME key namespace (`room:<id>:meta`) and the SAME driver-selection logic (memory | upstash) as `lib/store.ts`. Imports `@upstash/redis` directly — deliberate parallel to the queue store, documented in the file.
- `slugify(name)` → lowercase, strip accents, `[a-z0-9]`+`-`, collapse, + 4-char base32 suffix for uniqueness → short + human (e.g. `bar-do-ze-k7q2`).
- `generateHostCode()` → 8-char Crockford base32 (~40 bits). Shown once at creation; possession = venue identity (accounts are #14). Combined with #7's per-IP login throttle. Follow-up: stronger entropy / rotation at #14.
- `isValidRoomId(s)` → `^[a-z0-9-]{1,64}$` — **security-critical**: roomId flows into Redis keys; every route validates before use.
- `getRoom(id)` returns the record; `getPublicRoom(id)` strips `hostCode` for client responses.

### Host auth swap — `lib/host-auth.ts` (lookup seam only)
- `resolveRoomToken(roomId)` becomes **async**: look up `room.hostCode`; fall back to env `HOST_TOKEN`, then dev fallback (non-prod), else `null` (locked). This keeps the legacy `default` room (no record) working on env token.
- Cascades: `verifyHostToken`, `issueSession`, `verifySessionValue`, `requireHost`, `isHostConfigured` become async (routes already async).
- **Per-room cookie names** (opus review heads-up): `hostCookieName(roomId)` → `cantai_host_<roomId>`. One browser can host multiple rooms simultaneously (distinct cookies + distinct session values, since hostCodes differ). Tradeoff documented in-file.

### Route restructure
- `app/(patron)/[room]/page.tsx` — patron flow (moved from `app/page.tsx`), room-scoped fetch + venue chip + per-room localStorage.
- `app/(patron)/[room]/tv/page.tsx` — TV (moved from `app/tv/page.tsx`), passes roomId to `TvScreen`.
- `app/(patron)/[room]/admin/page.tsx` + `admin.module.css` — admin (moved), room-scoped API calls (`?room=<id>`).
- `app/page.tsx` — landing rewrite: what-is-cantai + "create room" (→`/new`) + join-by-code input (→`/<code>`).
- `app/new/page.tsx` — create room → shows join URL + QR + host code (once) + admin/tv links.
- Legacy redirects: `app/tv/page.tsx` → `/{room||default}/tv`; `app/admin/page.tsx` → `/default/admin`.

### Room-scoped API
- `app/api/rooms/route.ts` (new): `POST` create, `GET ?id=` fetch public room.
- Thread `roomId` (query `?room=` / body `room`, default `DEFAULT_ROOM`) through `app/api/queue/route.ts`, `app/api/queue/advance/route.ts`, and host routes. Validate with `isValidRoomId`.

### QR — `components/QrCode.tsx` (new)
- Client component; `qrcode` npm → data URL → `<img>`. Used on `/tv` join card + idle, and `/new` room-created page.

### localStorage (per-room)
- Global: `cantai_patron_uuid`, `cantai_last_room`, `cantai_nickname` (prefill).
- Per-room: `cantai:<room>:nick`, `cantai:<room>:table`.

## Files
New: `lib/rooms.ts`, `app/api/rooms/route.ts`, `app/new/page.tsx`, `app/(patron)/[room]/{page,tv/page,admin/page}.tsx`, `app/(patron)/[room]/admin/admin.module.css`, `components/QrCode.tsx`, tests.
Modified: `lib/host-auth.ts`, `app/page.tsx`, `app/tv/page.tsx`, `app/admin/page.tsx`, `app/api/queue/route.ts`, `app/api/queue/advance/route.ts`, `app/api/host/**`, `components/tv/TvScreen.tsx`, `package.json`, `__tests__/host-auth.test.ts`, `__tests__/host-api.test.ts`.
No `.env.example` change (rooms need no new env; QR uses `window.location.origin`).

## Risks
- Async auth chain ripples into #7 tests (owned change; updated here).
- roomId key-injection — mitigated by `isValidRoomId` on every route.
- #12 telemetry rebases last (additive one-line `track()`); no structural conflict expected.

## Test strategy
- Unit: `lib/rooms.ts` (slug/hostCode/validation/CRUD), async host-auth per-room + cookie names, queue/host routes with `?room=` isolation.
- e2e: create room → join via `/<room>` → submit → `/<room>/tv` shows it; second room stays empty; legacy `/` landing join-by-code.
</content>
</invoke>
