---
ticket: TICKET-154
product: boraoke
status: backlog
---

# TICKET-154 — Host admin page scrolls sideways on phones; move/remove buttons partly off-screen

**Filed:** 2026-10-15, by a Dev agent, from the TICKET-140 App Tester run (`work/reports/testing/TICKET-140-app-test.md`).
**Priority:** MEDIUM (the host runs the night from a phone).
**Type:** Bug (layout, pre-existing)
**Size:** S
**Patron-facing:** no (host-facing). **Gates:** App Tester (390 / 320 / 1280 px, all 3 locales), Reviewer.

## What was seen

At 390 px and 320 px wide, `/<room>/admin` scrolls horizontally. The queue section is about 470 px wide, so each row's move-up, move-down and remove buttons sit partly off-screen.

The App Tester measured it with a short fallback row (`youtu.be/<id>`) and with a long title row. Both rows are the same width, so the cause is not TICKET-140's `Title · Channel` label, which still ellipsizes. It predates TICKET-140.

Evidence: `work/evidence/ticket-140/apptest/*-m390-host-admin.png` and `*-m320-host-admin.png` (en, es, pt-BR), against `*-d1280-host-admin.png` on desktop.

## Acceptance

- [ ] No horizontal page scroll on the host admin page at 390 and 320 px, in all 3 locales.
- [ ] Every row's move and remove buttons are fully on-screen and tappable.
- [ ] An e2e check asserts `document.documentElement.scrollWidth <= innerWidth` on the admin page at 320 px with a seeded queue.
