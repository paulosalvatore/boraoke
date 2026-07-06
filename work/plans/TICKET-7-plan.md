# TICKET-7 — Host controls — Plan

- **Ticket:** `work/tickets/TICKET-7-host-controls.md` · **Branch:** `ticket/7-host-controls` · **Worktree:** `.worktrees/ticket-7`
- **Wave:** 2 (parallel with #11 feedback; #8 patron search, #9 TV in-gate). Built on the frozen TICKET-6 store.

## Approach

Thin token-guarded host API over the frozen store ops (`advance`/`removeEntry`/`reorder`/`setPaused`) + a desktop/tablet `/admin` page. The store is never modified. Auth lives in one helper (`lib/host-auth.ts`) so TICKET-9 swaps the lookup, not the call sites.

## Files (all within ownership)

- `lib/host-auth.ts` — token/session model + `requireHost` guard.
- `app/api/host/{login,session,skip,remove,reorder,pause}/route.ts` — token-guarded routes.
- `app/admin/page.tsx` + `app/admin/admin.module.css` — login gate + dashboard.
- `components/host/stats.ts` — pure stat counters.
- `__tests__/host-{auth,stats,api}.test.ts`, `e2e/host-controls.spec.ts`.
- **Cross-boundary (flagged):** `app/api/queue/route.ts` GET gains an additive `paused` field (public poll is where every view reads pause). `.env.example` appends `HOST_TOKEN` (TICKET-6's file, now on main — sequential-merge note).

## Auth model

Admin-token: `HOST_TOKEN` env → host enters it once at `/admin` → `POST /api/host/login` verifies (timing-safe) and sets an **httpOnly** cookie holding an HMAC-derived session value (never the raw secret). Every host route calls `requireHost`. Locked-safe: prod without `HOST_TOKEN` denies all; dev accepts a well-known fallback token so local/e2e boot with zero secrets. Room-scoped from day one → TICKET-9 swaps `resolveRoomToken` only.

## Deferred (coordination)

`/tv` player-pause consumption of the new `paused` flag is a one-line follow-up owned by the TV surface (#9 owns `app/tv/**`) — not edited here to avoid a merge collision. Backend + public flag are shipped; the TV read lands after #9 merges.

## Test strategy

Unit: auth (token/session/locked/dev-fallback), stats, route guards + store effects. E2e: login → remove(confirm) → reorder → pause reflected in admin + public flag; unauthenticated routes 401. Verified locally (CI billing-broken, known needs-user).
