# TICKET-9 — Dev Report (multi-room + QR join + table capture)

- **Status:** security-gate fixes landed (FAIL → re-verdict requested): HIGH-1 (creation throttle + ROOM_MAX ceiling) fixed, MEDIUM-2 (hash hostCode at rest) fixed. Build + unit (233) + e2e (14) green locally. App Tester PASSED earlier; CI was green pre-fix — re-confirming on the tip.

## Security-gate fixes (2026-07-06, second pass)

- **HIGH-1 (BLOCKING — fixed):** `POST /api/rooms` now has (a) a per-IP creation throttle — `lib/room-create-throttle.ts` (new), house dual-bucket/LRU pattern, default **3 rooms/hour/IP** (env `ROOM_CREATE_LIMIT`), counting successful creations only, 429 with pt-BR copy; skipped in `next dev` unless the env var is set (zero-config local dev/e2e, enforced in prod + jest); and (b) a **global ROOM_MAX ceiling** (default 500, env-tunable) — `createRoom` returns null at the ceiling → 503 "Estamos lotados por enquanto…". Counter: memory = map size; Upstash = monotonic `rooms:count` INCR. (c) Room TTL/idle-expiry documented as a **#14 follow-up** — NOT cheap now because expiring `room:<id>:meta` must be coordinated with the frozen queue store's `room:<id>:{queue,paused}` keys, which this ticket must not touch.
- **MEDIUM-2 (fixed):** hostCode is no longer stored plaintext. `Room.hostCode` → `Room.hostCodeHash` (HMAC-SHA256, `hashHostCode` in `lib/rooms.ts`); `createRoom` returns `{ room, hostCode }` — the raw code exists only in the one-time 201 response. `resolveRoomToken` returns the stored hash as the room secret; `verifyHostToken` hashes the submitted raw code before the constant-time compare (default room's env token still compared raw). Session values derive from the hash. Pass-the-hash is rejected (test-covered). Ripple stayed inside `lib/rooms.ts` + `lib/host-auth.ts` + tests.
- **MEDIUM-1 / LOW-1:** no action per the gate — MEDIUM-1 (per-room throttle budget rotation) already ticketed to #14; LOW-1 accepted.
- New tests: `__tests__/room-create-throttle.test.ts` (limit/expiry/LRU), api-rooms abuse-guard suite (429 at limit, per-IP isolation, explicit limit, 400s don't consume budget, 503 at ceiling), rooms hash-at-rest + ceiling + `roomMax` tests, host-auth hash-verify + pass-the-hash rejection. Suite: **233 passed / 15 suites**; e2e **14/14**; build green.
- `.env.example`: appended `ROOM_CREATE_LIMIT` / `ROOM_MAX` (append-only per wave rule).
- **Branch:** `ticket/9-rooms-qr` · worktree `.worktrees/ticket-9` · app port **3013**.
- **Product:** cantai (public repo).

## Exploration summary

- TICKET-6 store is room-scoped already (`room:<id>:*`, `keys.queue/paused`), frozen interface — I must NOT touch `lib/store/**`, so callers just pass a real `roomId` instead of `DEFAULT_ROOM`.
- TICKET-7 `lib/host-auth.ts` centralizes host auth; `resolveRoomToken` is the designated swap seam. Opus heads-up confirmed: session value didn't encode roomId and there was a single shared cookie name → I added per-room cookie names.
- TICKET-8 patron flow lived in `app/page.tsx`; TICKET-18 TV in `app/tv` (`components/tv/TvScreen.tsx`) with placeholder QR divs (`.qr`/`.idleQr`) ready to swap.
- TICKET-11 feedback widget (`components/FeedbackWidget.tsx`) excluded only `/tv` — my TV route move required extending that exclusion.

## Design decisions (room + cookie model)

1. **Rooms persistence — parallel store, not the frozen `QueueStore`.** `lib/rooms.ts` (new) persists `room:<id>:meta` using the SAME driver selection (memory | upstash) and key namespace as the queue store, importing `@upstash/redis` directly (documented as the one deliberate exception outside `lib/store*`). Reason: the store contract is frozen and off-limits; rooms are a new domain.
2. **Per-room host codes.** `resolveRoomToken(roomId)` is now **async**: a created room authenticates with its own 8-char Crockford-base32 `hostCode`; the legacy `default` room (no record) still falls back to env `HOST_TOKEN` → dev token → locked. An **unknown non-default room is LOCKED even if a global env token is set** (a global token governs `default` only). Cascade: `verifyHostToken`/`issueSession`/`verifySessionValue`/`requireHost`/`isHostConfigured` became async (routes already async → just `await`).
3. **Per-room cookie names.** `hostCookieName(roomId)` → `cantai_host_<roomId>` (bare `cantai_host` kept for `default`). Two effects: a session minted for room A can't authenticate room B (different code → different session value), AND one browser can host multiple rooms at once (independent cookies). Tradeoff: N cookies for a multi-room host — acceptable, documented in `lib/host-auth.ts`.
4. **roomId is a Redis-key input → SECURITY-CRITICAL validation.** `isValidRoomId` (`^[a-z0-9-]{1,64}$`) is enforced on EVERY route (`queue`, `queue/advance`, `rooms`, all `host/*`) before any store call; malformed id → 400. `roomIdFromRequest`/`resolveRoomId` centralize "absent = default (back-compat), present-but-bad = 400".
5. **Route restructure.** `app/(patron)/[room]/{page,tv,admin}` (route group, no URL segment). Server components resolve the venue name + validate the room, then hand off to colocated client components (`PatronRoom`, `AdminRoom`) — needed because Next 15 client pages get `params` as a promise. `app/page.tsx` → landing (what-is-cantai + create + join-by-code, prefills `cantai_last_room`). `app/new` → create flow (shows join URL + real QR + hostCode ONCE). Legacy `app/tv` → redirect to `/{room||default}/tv`; `app/admin` → redirect to `/default/admin`. No dead links (AC5).
6. **QR.** `components/QrCode.tsx` (new, client) uses `qrcode` npm → data-URL `<img>`. Wired into TV join card + idle (replacing the placeholder divs), `/new` room-created page, and the admin join card. QR encodes `${origin}/${roomId}` so scanning lands in the right room (AC4).
7. **Table capture + per-room localStorage.** Table stored on each entry already (store) and shown on patron rows, admin rows, and TV metadata (AC3). Nickname + table persist PER ROOM (`cantai:<room>:nick` / `:table`) with the global `cantai_nickname` as a first-visit prefill (AC6).
8. **Cross-ticket edit (justified by the restructure):** `components/FeedbackWidget.tsx` (TICKET-11-owned) exclusion widened from `=== "/tv"` to also cover `/<room>/tv` (path ends with `/tv`) so the widget never leaks onto a room TV (TICKET-11 AC7).

## Files

**New:** `lib/rooms.ts`, `app/api/rooms/route.ts`, `components/QrCode.tsx`, `app/new/page.tsx`, `app/(patron)/[room]/page.tsx`, `app/(patron)/[room]/PatronRoom.tsx`, `app/(patron)/[room]/tv/page.tsx`, `app/(patron)/[room]/admin/page.tsx`, `app/(patron)/[room]/admin/AdminRoom.tsx`, `app/(patron)/[room]/admin/admin.module.css`, tests: `__tests__/rooms.test.ts`, `__tests__/api-rooms.test.ts`, `__tests__/api-queue-rooms.test.ts`, `e2e/rooms.spec.ts`.
**Modified:** `lib/host-auth.ts`, `app/page.tsx`, `app/tv/page.tsx`, `app/admin/page.tsx`, `app/api/queue/route.ts`, `app/api/queue/advance/route.ts`, `app/api/host/{login,session,pause,remove,reorder,skip}/route.ts`, `components/tv/TvScreen.tsx`, `components/FeedbackWidget.tsx`, `package.json` (+`qrcode`, `@types/qrcode`), `__tests__/host-auth.test.ts`, `__tests__/host-api.test.ts`, existing e2e specs repointed to `/default*`.
**Removed:** `app/admin/admin.module.css` (moved into the room admin dir).
No `.env.example` change (rooms add no env; QR uses `window.location.origin`).

## Verification

- **Build:** `npm run build` → ✓ compiled, 18 routes generated (incl. `/[room]`, `/[room]/admin`, `/[room]/tv`, `/new`, `/api/rooms`, legacy `/tv` & `/admin` redirects).
- **Unit:** `npm test` → **220 passed / 14 suites** (adds rooms, api-rooms, api-queue-rooms; host-auth/host-api updated for async + per-room).
- **e2e:** `PORT=3013 npm run test:e2e` → **14 passed / 14** (serial; adds `rooms.spec.ts`, repoints legacy specs to `/default*`). Pinned `workers: 1` — the in-memory store/rooms singletons live in one Next dev process and reset on each route's first compile; parallel workers raced those resets and wiped seeded state. `rooms.spec` warms the room routes before creating rooms.
- **Evidence:** `work/evidence/ticket-9/` (8 shots: landing, /new, room-created QR+host-code, patron mobile join+queue 390px, room TV playing w/ Mesa 7 + room QR, room admin gate, second empty room TV).
- **CI:** the required build-and-test run must be terminal-green before gates — `gh pr checks 13` output pasted in the PR thread.

## Scope-out / follow-ups (as ticketed in the spec)

- Venue accounts/auth (#14) — hostCode is the only venue identity for now; note stronger entropy / rotation + a global (Upstash-backed) login throttle at #14.
- Room settings beyond the `mode` placeholder, reusable branded QR, room expiry/cleanup (stale `room:<id>:meta` keys are cheap; decide at #14).
- No room-list index persisted (no listing UI in scope); add if a "my rooms" view is needed.

## Friction

- `tsc --noEmit` surfaces jest-global errors across `__tests__` (project relies on ts-jest + `next build` for the real typecheck) — filter to non-test files when using it as a gate.
</content>
