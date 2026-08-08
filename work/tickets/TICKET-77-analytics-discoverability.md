---
ticket: TICKET-77
title: Surface the analytics link in the admin header (authorised hosts only)
status: in-review
---

## Background

The Tech Lead asked where the analytics page was, expecting it to be linked from
the product. A prior read-only investigation established:

- `app/admin/analytics/page.tsx` exists and is live in production (HTTP 200).
- It is completely unlinked — no `<Link>`, no `<a>`, no nav entry anywhere in
  the UI. Reachable only by typing the URL.
- The admin header (`AdminRoom.tsx`) links to the patron room and the TV, but
  not to analytics.
- Analytics auth is global, not per-room: gated on the site-wide `HOST_TOKEN`
  env var via `requireHost(req, DEFAULT_ROOM)`. A real room's `hostCodeHash`
  can never authenticate the `default` room, so a venue host can never reach
  analytics — their own included. This is a separate, out-of-scope product
  gap (see "Known follow-up" below).

## Change

Added an **Analytics** link to the admin header in `AdminRoom.tsx`, shown
conditionally: a fire-and-forget probe against `GET /api/host/session?room=default`
on mount. The link renders only when that probe returns 200 — so the Tech
Lead (who holds `HOST_TOKEN`) sees it, and a venue host is never shown a link
that would 401 them.

- Reused the existing `.tvLink` header-link styling — no CSS change needed.
- The probe is independent of the room's own auth flow: it never blocks or
  delays the dashboard render, has no retry loop, and any failure (401,
  network error) silently leaves the link hidden — no console noise, no error
  surfaced.
- Label is hardcoded `"Analytics"` (not localised) per explicit ticket
  direction: identical across pt-BR/en/es, and the destination page is
  English by documented decision. A sibling agent owns all `messages/*.json`
  files during this cycle — not touched.
- Link is a plain `<a>`, keyboard-reachable, using the same focus/hover
  affordances as the sibling header links.

## Out of scope (flagged, not implemented)

The real product gap: venue hosts have no analytics of their own — the
dashboard shows only current-queue counters, no history. Filing that
separately as a follow-up ticket. Did not touch `app/admin/analytics/**`,
`app/api/host/analytics/route.ts`, or `lib/host-auth.ts`, and did not weaken
`requireHost` in any way.

## Verification

- `npm test` — 43 suites / 683 tests passed.
- `npx tsc --noEmit` — 2190 pre-existing errors (documented baseline,
  missing `@types/jest`); delta vs `main` is 0 — no new errors, none in
  `AdminRoom.tsx` or the modified spec file.
- `npm run build` — succeeds; `/[room]/admin` route compiles clean.
- `npx playwright test` — full suite, 78/78 passed on a clean, uncontended
  run (3.7m). Two tests directly cover TICKET-77:
  - `/[room]/admin: login → controls + mode switcher + customer-screen links`
    — asserts the Analytics link is ABSENT (count 0) for a room authenticated
    with its own hostCode (not the site HOST_TOKEN). The browser context's
    cookies are explicitly cleared first, because `warmUp` pre-authenticates
    the `default` room for route-compilation purposes and would otherwise
    give this room a false-positive default-room session.
  - `/[room]/admin: HOST_TOKEN-authed session (default room) shows the
    Analytics link` — asserts the link is present with `href="/admin/analytics"`
    once the `default` room's HOST_TOKEN session is live.
- Evidence: `work/evidence/TICKET-77/{authorised,unauthorised}-{1440,390}.png`,
  captured with Playwright directly against `npx next dev -p 3189`. The
  capture script asserted `getByTestId("admin-analytics-link")` count is 0 in
  the unauthorised state before taking the screenshot.
