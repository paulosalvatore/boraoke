---
ticket: TICKET-77
title: Surface the analytics link in the admin header (authorised hosts only) + host logout control
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

## Addendum — host logout control (added mid-cycle, blocking sibling PR)

Sibling PR #53 (TICKET-76) raises the host session from 12h to a rolling
30-day window. Its own security review found `POST /api/host/session` (the
logout endpoint) had **zero callers anywhere in `app/` or `components/`** —
no logout UI existed at all — and the roll is partly driven by the public
landing page, so a shared venue tablet that keeps visiting boraoke.com keeps
re-arming the window indefinitely. A logout control is the mitigation PR#53
was waiting on.

Added to the same admin header (`AdminRoom.tsx`):

- A muted, text-only "Sair" button (`.logoutBtn`, new CSS) — deliberately NOT
  styled like the `.tvLink` pills, so it reads as a secondary meta-action, not
  something to fat-finger mid-service.
- Confirm-before-act: clicking "Sair" reveals the same two-step
  confirm/cancel pattern already used for "Remover" on a queue row
  (`styles.confirm`/`confirmYes`/`confirmNo`, reusing the existing `t("confirm")`/
  `t("cancel")` i18n keys — no new translation needed). Justification: ending
  a session is disruptive on a shared venue tablet (re-entry requires the host
  code), so a single accidental click should not do it.
- On confirm, `POST /api/host/session?room=<roomId>` (the room-scoped variant
  of the existing endpoint) is called; the UI only flips back to the login
  gate when the response is genuinely `res.ok` — a network failure leaves the
  host client-side-authed rather than falsely claiming logout succeeded.
- Label `"Sair"` is hardcoded, not localised — same constraint and rationale
  as "Analytics" (sibling agent owns `messages/*.json` this cycle).
- Verified **on the wire**, not just in the client: `GET /api/host/session`
  returns 200 before confirm and 401 after — see
  `work/evidence/TICKET-77/after-logout-gate-1440.png` and the e2e test
  `logout control clears the session on the wire`.
- Negative control added (`logout negative control`): stubs the POST to fail
  and asserts the dashboard stays up and the real session probe still 200s —
  proves the res.ok gating actually matters, not just that happy-path works.

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
- Evidence: `work/evidence/TICKET-77/{authorised,unauthorised}-{1440,390}.png`
  plus `logout-confirm-1440.png` and `after-logout-gate-1440.png`, captured
  with Playwright directly against `npx next dev -p 3189`. The capture script
  asserted `getByTestId("admin-analytics-link")` count is 0 in the
  unauthorised state, and independently probed `GET /api/host/session` on the
  wire (200 pre-logout, 401 post-logout) before taking screenshots.
- Full e2e re-run after the logout addition: 81/81 passed (3.6m), including
  the 3 new logout tests (absent-on-gate, wire-verified clear, negative
  control).
