# TICKET-9 — Multi-room + QR join + table capture

- **Date:** 2026-07-05 · **Product:** cantai · **Author:** Product Owner (TICKET-19 batch)
- **Wave:** 2 (after TICKET-6, TICKET-7 AND TICKET-8 merge — needs room-scoped store; extends #7's `lib/host-auth.ts`; restructures the patron routes #8 just edited)
- **Depends on:** TICKET-6 (room-scoped keys), TICKET-7 (`lib/host-auth.ts` must exist — this ticket swaps its lookup to per-room host codes), TICKET-8 (patron page final form before the route move). Blocks: TICKET-10 (table identity feeds 2-per-table mode).
- **Sizing:** M

## Goal

A bar creates its own room, prints/shows a QR, and patrons land in THAT room with their table number captured — the physical onboarding moment. Ends the single-global-queue prototype: two bars can use cantai the same night.

## Design source

`work/design/design-handoff.md` §1 Patron join (`patron-01-join.html`): venue chip in the top bar, nickname (localStorage prefill), optional numeric table field, sing/listen mode cards, "Bora cantar!" CTA. TV join card + idle state (§4) already specify the QR placement — replace the placeholder pattern with a real QR.

## Room model (this ticket's calls)

- Room = `{ id (slug, short + human, e.g. "bar-do-ze"), name, hostCode, createdAt, settings: { mode } }`, stored via the TICKET-6 persistence layer under the room-scoped key schema it already reserved.
- Creation: minimal `/new` page — venue name in → room created → shows the join URL, QR, and the room's host code (once). No accounts (that's #14); possession of the host code IS venue identity for now.
- Routes: `app/(patron)/[room]/` route group takes over join → pick → queue (moving the current `/` flow); `/` becomes a tiny landing (what cantai is + "create your room" + join-by-code input). `/tv?room=` → `/[room]/tv`; `/admin` → `/[room]/admin`.
- Host auth: extend `lib/host-auth.ts` (TICKET-7) from the global `HOST_TOKEN` to per-room `hostCode` lookup — swap the lookup inside the helper, call sites untouched.
- QR: generate client/server-side with a zero-config lib (`qrcode` npm) — QR of the room join URL, rendered on `/tv` join card, idle screen, and the room-created page.
- Table capture: join form field (optional in full-karaoke; the 2-per-table requirement gate arrives with #10) → stored on each entry (`table`), shown in chips/queue rows/TV per design.

## Scope — in

Room CRUD (create + get; no delete UI yet), route restructure above, QR generation, table capture wiring, localStorage keeps nickname + last room, redirects from legacy paths, e2e: create room → join via room URL → submit → room-scoped TV shows it; second room stays empty.

## Scope — out

Venue accounts/auth (#14), room settings beyond mode placeholder, reusable branded QR (pro candidate), room expiry/cleanup policy (note a TODO: stale rooms are cheap keys — decide at #14).

## File ownership (parallel-dev boundaries)

- **Owns:** `app/(patron)/[room]/**` (new — receives moved code from `app/page.tsx`, `app/tv/`, `app/admin/`), `app/new/**`, `app/page.tsx` (landing rewrite — post-#8 sole owner), `lib/rooms.ts` (new), `components/QrCode.tsx` (new), `lib/host-auth.ts` (the lookup swap only), e2e specs it adds, `package.json` (add `qrcode`).
- **Must not touch:** `lib/store.ts` / `lib/store/**` (room scoping already exists — pass `roomId` instead of `"default"`), `packages/rotation-engine/**`, search internals (`lib/youtube-search.ts`, `app/api/search`) beyond moving imports.
- **Coordination note:** this is the batch's only route-restructure ticket, which is WHY it must run after #7/#8 merge and alone in its slot touching those paths.

## Acceptance criteria

1. Creating a room yields a working join URL + QR + host code; the host code is displayed exactly once and works on `/[room]/admin`.
2. Two rooms run simultaneously with fully isolated queues, TVs, and admin controls.
3. Table number from the join form appears on queue rows, chips, and the TV "get to the mic" metadata.
4. Scanning the TV QR on a phone lands in the correct room's join page.
5. Legacy `/` still works as a landing with join-by-code; no dead links from the old flow.
6. Nickname + table persist per-room in localStorage across refreshes.
