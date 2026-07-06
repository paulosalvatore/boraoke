# Dev Report — TICKET-6: Durable persistence

- **Ticket:** TICKET-6 — durable persistence (store swap under `lib/store.ts`)
- **Product:** cantai · **Wave:** 1 (parallel with TICKET-8, TICKET-18)
- **Branch:** `ticket/6-persistence` · **Worktree:** `.worktrees/ticket-6`
- **App port:** 3040 (product default)
- **Status:** Implemented, self-verified green (build + 78 unit + e2e + live smoke). Ready for gates.

## Approach / driver design

Queue state now lives behind a **frozen async, room-scoped store interface** (`QueueStore` in `lib/store/types.ts`) with two interchangeable drivers selected by env, so no wave-2 ticket ever edits `lib/store.ts` again:

- **`lib/store/types.ts`** — `QueueStore` interface (all 9 frozen ops: `getQueue`, `addEntry`, `removeEntry`, `advance`, `nowPlaying`, `reorder`, `setPaused`/`isPaused`, `clear`), `QueueEntry` (+ reserved `graceRequeue?: boolean` for TICKET-10), `Mode`, `QUEUE_MAX`, `DEFAULT_ROOM = "default"`, and the room-scoped `keys` schema (`room:<roomId>:queue`, `room:<roomId>:paused`).
- **`lib/store/memory.ts`** — `MemoryStore`, a `Map<roomId, {queue, paused}>` in-process driver. Default for local dev & CI; boots with zero credentials.
- **`lib/store/upstash.ts`** — `UpstashStore` over `@upstash/redis`. Redis-native model: hot patron path uses atomic `RPUSH`; `advance` uses atomic `LPOP`; low-frequency host ops (`removeEntry`, `reorder`) do read-modify-write. The Redis client is **injected** (constructor takes a `RedisLike`), so unit tests drive a fake with no network/creds. `createUpstashStore()` builds it from env, throwing if creds are absent.
- **`lib/store.ts`** — the single import point. Re-exports the types (keeps `app/page.tsx` / `app/tv/page.tsx` `import type { QueueEntry, Mode }` stable) and exposes the `store` singleton. Driver resolution: `STORE_DRIVER=upstash|memory` forces; unset → `upstash` when `UPSTASH_REDIS_REST_URL` present, else `memory`.

API routes updated to `async`/awaited store calls, room-scoped to `DEFAULT_ROOM`, **no behavior change**: `app/api/queue/route.ts` (GET → `Promise.all` of getQueue+nowPlaying; POST → `addEntry` returns false at cap → 429) and `app/api/queue/advance/route.ts` (`advance`).

## Exploration notes

Small codebase, read directly (no Explore subagent needed): only `app/api/queue/**` and the two tests imported store *functions*; `app/page.tsx` / `app/tv/page.tsx` import store *types* only (must stay re-exported — done). Nothing else touches the store. Confirmed via `grep -rn "lib/store"`.

## Files touched

| File | Change |
|---|---|
| `lib/store.ts` | Rewritten as single import point (driver selector + singleton + type re-exports) |
| `lib/store/types.ts` | NEW — frozen `QueueStore` interface, entry shape, key schema |
| `lib/store/memory.ts` | NEW — in-process driver (default) |
| `lib/store/upstash.ts` | NEW — Upstash Redis driver (injectable client) |
| `app/api/queue/route.ts` | GET/POST → async, room-scoped store calls |
| `app/api/queue/advance/route.ts` | POST → async `store.advance` |
| `__tests__/store.test.ts` | NEW — conformance suite run against BOTH drivers (memory + fake-Redis Upstash) + room-scoping + QUEUE_MAX + key schema + singleton |
| `__tests__/api-queue.test.ts` | Updated to async store API |
| `__tests__/queue.test.ts` | REMOVED — superseded by `store.test.ts` (old sync API gone) |
| `.env.example` | NEW — `STORE_DRIVER`, `UPSTASH_REDIS_REST_URL/TOKEN` (I own this file; wave peers append) |
| `README.md` | Replaced "in-memory resets/diverges" limitation with a Persistence section |
| `package.json` / `package-lock.json` | Added `@upstash/redis@^1.38.0` |

## Self-verification (real output)

- **`npx tsc --noEmit`** — no errors in `lib/` or `app/` sources. (Pre-existing `__tests__` jest-global noise: project ships no `@types/jest`; `next build`'s type-check passes regardless.)
- **`npm test`** — `Test Suites: 3 passed, 3 total · Tests: 78 passed, 78 total`.
- **`npm run build`** — `✓ Compiled successfully`, `✓ Generating static pages (7/7)`, type-check clean.
- **`npx playwright test`** (CI=1, port 3040) — `1 passed (8.2s)`.
- **Live smoke** (dev server, curl): empty → POST 201 → second curl session sees the entry + nowPlaying → advance → empty. Server stopped after.

## Acceptance criteria

1. Two sessions see the same queue — verified live (two curl sessions, shared state). Cross-*lambda-instance* durability is the Upstash driver's guarantee (unit-tested via fake Redis); live cross-instance check needs provisioning (see needs-user).
2. Survives redeploy/restart with `STORE_DRIVER=upstash` — by-design + unit-tested; live check blocked on provisioning.
3. No creds → memory driver, all tests green — verified (singleton `instanceof MemoryStore` test + full suite runs credential-free).
4. `removeEntry`/`reorder`/`setPaused` work through the interface — unit-tested on both drivers, no UI caller yet.
5. All ops room-scoped (`room:default:*`), no global-unscoped key — verified (key-schema test + room-isolation test).
6. No store import outside `lib/store.ts` — verified by grep; type re-exports keep `app/**` importing from `@/lib/store` only.

## Needs-user (blocks live durability verification only, NOT this PR)

- Provision **Upstash Redis** via the Vercel Marketplace on `paulosalvatores-projects/cantai`; pull `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` into Vercel env (+ local `.env` for local upstash runs). Account-level dashboard action. Until then the app runs on the memory driver everywhere; the durability ACs (1 cross-instance, 2) are satisfied by-design + unit tests and will be live-verifiable once creds exist.

## Security gate follow-up (PASS-WITH-NOTES, folded in)

Per the security gate on PR #7: added `import "server-only"` to `lib/store.ts` and `lib/store/upstash.ts` (+ `server-only@^0.0.1` dependency) so any future client-component import of the store fails at build time instead of silently bundling credential-reading code. Jest runs under plain node where `server-only` throws by design, so `jest.config.ts` maps it to an empty stub (`__mocks__/server-only.ts`) — the guard stays active in Next.js builds. Re-verified: `npm test` 78/78 green, `npm run build` compiled + 7/7 pages. Remaining findings (non-atomic host ops, roomId validation) recorded as acceptable-now / TICKET-9-scoped — no action per TM.

## Friction

- Framework `emit-event.sh` / `heartbeat.sh` live in the framework repo, not the product repo; had to invoke by absolute framework path. `heartbeat.sh` rejected `--ticket` (arg mismatch) — skipped (live-UX only, non-blocking).
