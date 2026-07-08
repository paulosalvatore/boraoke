# TICKET-43 — Recoverable sessions without login (local room memory + host-session recovery)

- **Product:** boraoke (repo `paulosalvatore/boraoke`)
- **Type:** feature
- **Author:** Tech Manager (from direct TL request)
- **Status:** in progress
- **Branch / worktree:** `ticket/43-session-recovery` / `.worktrees/ticket-43`
- **App port:** 3043

## TL directive (verbatim intent, binding)

> Session needs to be recoverable on local storage even without login, with auto sync after login... user not losing rooms by accident.

## Problem

Today a host who creates a room and loses the tab (or the shown-once host code) can lose access to their room; a patron who joins loses the link on refresh. There is no device-level memory of "rooms I touched". Accounts (wave 4/5, `work/planning/accounts-and-identity.md`) are the durable fix, but they are not built yet. This ticket delivers the anonymous, device-level bridge: remember rooms locally, recover host sessions honestly, and leave a clean seam for the future login auto-sync.

## Scope

### 1. Local room memory (device-level, no login)

Persist to `localStorage` under the existing `cantai_` key family (e.g. `cantai_rooms_v1`):

- Every room the user **creates**: `{ id, name, role: "created", createdAt }` — **NEVER the host code** (shown-once by design; we only persist that *this device* created it).
- Every room the user **joins** as patron: `{ id, name, role: "joined", lastSeen }`.

Landing page gains a **"Suas salas"** section:

- Lists remembered rooms, **most-recent first**.
- Quick links per row: created → patron / admin / tv; joined → patron.
- Small `✕` to forget a single room.
- Subtle honest-limits copy ("salvas neste dispositivo").

### 2. Host-session recovery UX

The host-session cookie already persists ~12h per room. Surface it:

- On a remembered **created** room, probe `/api/host/session` for that room.
- If the host cookie is still valid → the admin link goes **straight in**.
- If expired → route to the admin login with honest pt-BR copy: *"sua sessão expirou — entre com o código da sala"*.
- **NEVER** store or auto-fill the host code itself.

### 3. Login auto-sync groundwork (wave-28 seam — NOT the full build)

Structure the local store so the future accounts wave can sync it:

- A documented store shape + a `claimable` flag per remembered room.
- A stub `syncLocalRooms()` with a clear TODO referencing `work/planning/accounts-and-identity.md` (the claim-on-signup design, I-2 uuid→account link resolved at read time).
- Do **NOT** build auth itself.

### 4. Honest limits (documented in UI copy)

`localStorage` is per-browser/device; clearing site data loses the memory (until accounts land). Say so subtly in the "Suas salas" copy ("salvas neste dispositivo").

## Acceptance criteria

1. Creating a room records it under `cantai_rooms_v1` with `id`, `name`, `createdAt`, `role: "created"` — and **no host code field anywhere in the stored object**.
2. Joining a room as patron records `id`, `name`, `lastSeen`, `role: "joined"`.
3. Landing page shows a "Suas salas" section listing remembered rooms most-recent-first, with role-appropriate quick links and a working `✕` forget control, plus the "salvas neste dispositivo" note.
4. On a remembered created room with a valid host cookie, the admin link enters directly; when expired, it routes to admin login with the honest expired-session copy.
5. The local store carries a `claimable` flag and a documented shape; `syncLocalRooms()` exists as a TODO-stub pointing at the accounts plan. No auth is built.
6. Unit tests (room-memory lib): add / dedupe / forget / order / cap (~50) / **never-stores-hostCode** assertion. E2E: create → landing shows under Suas salas → link works; join → remembered; forget works. Suite green.

## Non-goals / out of scope

- Any authentication / OAuth / accounts build (wave 4/5).
- Server-side identity registry (TICKET-26).
- Storing or recovering the host code itself (shown-once by design).
- Touching `components/SongSearch.tsx`, the patron form, `/api/search` (TICKET-40), or `app/tv/**`, `components/tv/**`, `/api/queue/advance` auth (TICKET-41). Flag any unavoidable overlap in the PR for sequential merge.

## Test strategy

- **Unit:** room-memory lib pure functions (add/dedupe/forget/order/cap/never-stores-hostCode).
- **E2E:** create room → landing "Suas salas" → link works; join room → remembered; forget works.
- Local verify: build + suite + e2e (`PORT=3043`; stop servers after). CI-green via `verify-green-local.sh` where applicable.

## References

- `work/planning/accounts-and-identity.md` — claim-on-signup design (the sync target).
