# TICKET-109 — Plan

## Approach

`.chrome` (the auto-hiding "Pular"/"Tela cheia" bar) is `position: fixed; right: 3vw;
bottom: 2.5vw`, independent of `.tv`'s own flex flow. `.rail` (up-next cards + the
join/QR card) is the LAST item in that flow, and with `.tv`'s symmetric `padding:
2.5vw 3vw`, the rail's bottom edge sits flush with the exact same 2.5vw inner edge
`.chrome` floats in — so the two z-index-stacked layers collide squarely on the
join card's text at 1920x1080 (work/evidence/TICKET-103/t103-1-normal-1080p.png).

Fix: widen `.tv`'s bottom padding only (2.5vw → 7vw) so the rail's bottom edge
clears `.chrome`'s rendered footprint (~3.3vw) plus a margin, before `.chrome`'s
own `bottom: 2.5vw` anchor point. Since every value involved is `vw`-relative and
all three target resolutions (1280x720, 1920x1080, 3840x2160) share the same 16:9
aspect ratio, the clearance holds proportionally at all three.

The FOCUS STATE's own `padding: 1vw 1.5vw` rule (TICKET-103, later in the same
file, same element) overrides all four sides of `.tv`'s padding outright — so this
change is normal-state only and does not touch focus, where `.rail` is already
repositioned into its own absolute overlay.

## Files touched

- `components/tv/tv.module.css` — widen `.tv`'s bottom padding, documented inline.
- `e2e/tv.spec.ts` — new geometry regression test (chrome vs join bounding-box
  non-intersection) at 1920x1080.
- `work/evidence/TICKET-109/` — before/after captures at 720p/1080p/4K + a focus
  capture.

## Risks

- A vw-based fix could look right at one resolution and wrong at another — hence
  captures at all three ticket-mandated resolutions, not just 1080p.
- The chrome bar's rendered height could grow (longer i18n button labels wrapping
  to two lines) and eat into the reserved margin — the new geometry test is the
  backstop: it fails loud on any future regression, at any resolution the suite
  runs at.
- Reserving extra bottom space shrinks `.main` (video + meta) by the same amount
  via `flex: 1` — purely proportional, no breakage, confirmed visually.

## Test strategy

- New Playwright geometry assertion (`tv-chrome` vs `tv-powered-by` bounding boxes
  must not intersect) at 1920x1080 — proven to FAIL against the pre-fix CSS
  (verbatim output in the dev report) before being proven to pass against the fix.
- Full `e2e/tv.spec.ts` suite (17 tests, including both TICKET-103 focus-state
  tests) re-run green to confirm no regression to focus behavior.
- Manual captures at 1280x720, 1920x1080, 3840x2160 (normal state) + 1080p focus
  state, before and after.
- Full gate chain: `npm test`, `npm run test:e2e`, ES2019 bundle check,
  `scripts/check-css-target.mjs`.

## Anything needing user input

None — this is a pure CSS layout fix within an existing, already-approved design
system (TICKET-18/TICKET-103), no product/design decision required.
