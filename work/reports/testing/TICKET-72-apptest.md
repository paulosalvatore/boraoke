# TICKET-72 App Tester report — feedback header trigger discoverability

Date: 2026-08-08
Branch: ticket/72-feedback-discoverability
Port: 3184 (worktree .worktrees/ticket-72)

## Summary

The header entry point works and is genuinely discoverable at first paint on a long queue, on the landing page, and correctly absent on desktop. **However, it has a real horizontal-clipping defect on the patron room specifically**, at both 320px and (to a lesser degree) 390px viewport widths — the exact class of failure this ticket's own history (TICKET-71's first attempt) warns about, and it slipped past the shipped regression suite because that suite only asserts the header trigger's *vertical* bounds on the patron room, never horizontal.

## PASS/FAIL per capture area

| Area | Result |
|---|---|
| Patron room 390×844, 25-row queue, scroll sweep 0/0.25/0.5/0.75/1.0 — no row overlap | PASS (geometrically — no queue row/badge overlap at any scroll fraction) |
| Patron room 390×844 — header trigger fully within viewport | **FAIL** — clipped ~15px off the right edge |
| Patron room 390 — feedback sheet opens on trigger click | PASS |
| Patron room 320×844 — header not overflowing/trigger not clipped | **FAIL** — trigger entirely off-screen, not visible at all |
| Patron room 320×844 — mid-scroll, no row overlap | PASS |
| Landing page 390×844 and 320×844, multiple scroll positions | PASS — trigger visible, unclipped, wraps to its own row at 320px |
| Desktop 1280×900 — header trigger absent on landing and patron room | PASS |
| Desktop 1280×900 — fixed pill unchanged | PASS (`position: fixed`, "Enviar feedback" visible bottom-right) |

## The defect (found by deliberately hunting for it, per the ticket's own methodology)

**The patron room's header — not the landing page's — overflows horizontally at typical phone widths, clipping or fully hiding the new trigger.**

- At **320px** (`iPhone SE`-class width): the trigger is **completely invisible**, pushed off-canvas to the right. Screenshot: `work/evidence/TICKET-72/04-patron-320x844-scroll-0.png` and the tight crop `05-patron-320-header-closeup.png`. The header's `scrollWidth` (389px) exceeds its `clientWidth` (288px) by 101px — the header content (brand h1 is fine, but the `LanguageSwitcher` + "Oi, ‹nickname›" greeting + nickname-edit button, all crammed into a `justify-content: space-between` flex row with the portalled trigger) does not wrap and overflows the 320px viewport.
- At **390px**: the trigger is only **partially** clipped — its bounding box is `x=365.125, width=40`, so its right edge sits at `405.125`, which is `15.125px` past the 390px viewport edge. Visible in `01-patron-390x844-scroll-0.png` — roughly a third of the circular button is cut off by the screen edge.
- By contrast, the **landing page** header handles the same trigger correctly at both widths — at 320px it wraps to its own row below "PT" (`07-landing-320x844-scroll-0.png`), fully on-screen, unclipped. The landing page and patron room use different header markup, so the same component behaves differently depending on host header — this is a host-header layout problem, not a bug in the trigger's own CSS.

**Why the shipped regression suite (`e2e/feedback-widget-safe-area.spec.ts`) did not catch this:** the "TICKET-72 — header trigger is visible without scrolling..." test (patron room, line ~293) only asserts vertical bounds (`triggerBox.y >= 0`, `triggerBox.y + triggerBox.height <= viewportHeight`) and a minimum 40×40 size — it never checks `triggerBox.x + triggerBox.width <= viewportWidth`. The separate "landing page" test (line ~367) *does* assert full horizontal containment (`box.x + box.width <= width`) — but only for the landing page, never the patron room. So the one geometry check that would have caught this defect exists in the suite, just scoped to the wrong page.

This is exactly the kind of gap the ticket's own doc comments describe learning from on TICKET-71 (evidence/tests that "systematically avoided the failure mode"): the assertion that would refute the patron-room case was written, but only applied where the defect doesn't occur.

## No other defects found

Deliberately hunted for and did **not** find:
- Overlap between the trigger and any queue row title/CANTAR badge, at any scroll fraction, at either 390 or 320px (confirmed both visually and via bounding-box intersection checks — `intersectsAnyQueueRow: false` at both widths).
- Overlap between the trigger and the LanguageSwitcher or the greeting/nickname text specifically (`intersectsH1: false`, `intersectsGreetingSpan: false` — though note the overflow above means at 320px there's nothing to "overlap" because the trigger is pushed fully out of the header's rendered box, not stacked on top of other content).
- Misalignment against the `align-items: baseline` patron header — the trigger sits vertically centered via `align-self: center` as intended; no baseline-hang artifact observed.
- Contrast problems — the gradient pink→amber circle with the 💬 glyph reads clearly against the dark header background in every screenshot.
- The trigger appearing on desktop — confirmed absent (`display: none`) on both landing and patron room at 1280×900; the fixed pill is the only affordance there, `position: fixed` confirmed.
- The sheet failing to open — confirmed it opens correctly via the header trigger (`03-patron-390-sheet-open.png`), same sheet UI as the existing pill.

## Measurements (patron room)

**390×844:**
- `feedback-header-trigger` bounding box: `{ x: 365.125, y: 39, width: 40, height: 40 }`
- `getComputedStyle(...).position`: `static`
- Intersects any queue-row title/badge: `false`
- Intersects header `<h1>` (brand): `false`
- Intersects header greeting `<span>` (LanguageSwitcher + "Oi, ‹nick›"): `false`
- **Right edge overflow: trigger right edge at x=405.125, viewport width 390 → 15.125px clipped off-screen.**

**320×844:**
- `feedback-header-trigger` bounding box: `{ x: 364.671875, y: 39, width: 40, height: 40 }` (same layout position as 390 — header content doesn't reflow with viewport)
- `getComputedStyle(...).position`: `static`
- Intersects any queue-row title/badge: `false`
- Intersects header `<h1>`: `false`
- Intersects header greeting `<span>`: `false`
- Header `<header>` element: `scrollWidth=389`, `clientWidth=288` → **overflows by 101px**
- **Trigger right edge at x=404.67, viewport width 320 → fully off-canvas, not visible at all.**

**Desktop 1280×900:**
- Landing page trigger: not visible, `display: none`
- Patron room trigger: not visible, `display: none`
- Fixed pill (`aria-label` "Enviar feedback"): `position: fixed`, visible bottom-right in both contexts

## Evidence files

All committed to `work/evidence/TICKET-72/` (absolute path `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-72/work/evidence/TICKET-72/`):

- `01-patron-390x844-scroll-{0,0.25,0.5,0.75,1}.png` — 390px scroll sweep (defect visible in `scroll-0`: trigger clipped at right edge)
- `02-patron-390-header-closeup.png` — tight header crop at 390px
- `03-patron-390-sheet-open.png` — feedback sheet open via header trigger
- `04-patron-320x844-scroll-0.png` — 320px, scroll 0 (defect: trigger entirely absent from view)
- `05-patron-320-header-closeup.png` — tight header crop at 320px (defect clearly visible)
- `06-patron-320x844-scroll-0.5.png` — 320px mid-scroll, no overlap
- `07-landing-{390,320}x844-scroll-0.png`, `08-…-scroll-0.4.png`, `09-…-scroll-0.7.png`, `10-…-scroll-1.0.png` — landing page sweeps at both widths
- `11-desktop-1280-landing.png`, `12-desktop-1280-patron-room.png` — desktop, trigger absent, fixed pill present
- `_measurements.json` — raw bounding-box/position/intersection data backing the numbers above

## Recommendation

Do not treat this as ready to ship as-is. The header trigger is a **real regression risk on the exact device class (narrow phones) the ticket exists to serve** — a guest on an iPhone SE (320px, still a meaningfully common width) cannot see the new entry point at all, and even a 390px guest (iPhone 12/13/14 mini-class widths and up) sees it half-cut. Suggest the Dev either:
1. Constrain/truncate the greeting text and/or shrink the LanguageSwitcher on the patron room header at narrow widths so the row's total content fits, or
2. Let the patron header wrap the way the landing page's header already does (add `flex-wrap: wrap` or similar to the inline header style in `PatronRoom.tsx`), or
3. Give the trigger a guaranteed `flex-shrink: 0` slot reserved before the other header content shrinks/truncates.

And separately, file a small regression-suite gap: extend the patron-room "TICKET-72" test in `e2e/feedback-widget-safe-area.spec.ts` to also assert `triggerBox.x + triggerBox.width <= viewportWidth` (mirroring the check that already exists for the landing page), so this class of defect can't recur silently.
