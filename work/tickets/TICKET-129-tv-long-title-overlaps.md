---
ticket: TICKET-129
product: boraoke
status: filed
---

# TICKET-129 — A very long karaoke title on /tv overlaps the singer line, mic banner and QR card

**Filed:** 2026-10-15, from the App Tester pass on PR #88 (TICKET-124), finding 2.
**Priority:** LOW — cosmetic, but it is on the venue's big screen.
**Type:** UI / TV layout
**Size:** S

## What

On `/tv`, a very long karaoke title (observed: "Flagra (No Escurinho do Cinema)- karaokê - MÚSICA ORIGINAL SEM VOZ c/ letra - Rita Lee") wraps into a very tall headline. That pushes the singer line underneath the "vá para o microfone" banner and the QR card, so the three overlap.

The behaviour is pre-existing (PR #88 touches no TV code), but index rows tend to carry long channel-style titles, so it will show up more often now that the karaoke index answers most searches.

## Acceptance

- At 1280x720 (and the other TV sizes the suite checks), a title of at least the length above never overlaps the singer line, the mic banner or the QR card.
- The title stays readable: clamp to a fixed number of lines with an ellipsis, or scale the type down, rather than letting it grow the headline.
- A layout check (e2e or TV runtime check) covers a long title.

## References

- App Tester report: `work/reports/testing/TICKET-124-app-test.md`, "Defects / notes" item 2.
- Evidence: `work/evidence/TICKET-124/apptest/desktop-17-tv-shows-queued.png` (also `mobile-17-tv-shows-queued.png`).
