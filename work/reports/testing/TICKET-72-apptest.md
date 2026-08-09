# TICKET-72 App Tester report — feedback header trigger discoverability

Date: 2026-08-08 (initial pass); re-tested same day after the fix landed
Branch: ticket/72-feedback-discoverability
Port: 3184 (worktree .worktrees/ticket-72)

**STATUS: initial pass found a real clipping defect (below); the Dev fixed it in commit `79aa53d` and the re-test (see "Re-test after fix" section at the bottom) confirms it is resolved, using a realistic 18-char nickname AND a 24-char stress case, with no regressions in the rest of the suite.**

## Summary (initial pass)

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

## Evidence files (initial pass — "before" the fix)

All committed to `work/evidence/TICKET-72/` (absolute path `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-72/work/evidence/TICKET-72/`). The four screenshots that showed the defect were renamed with a `before-`/`CLIPPED` marker (git-mv, history preserved) once the fix landed, so the defect stays documented rather than silently disappearing:

- `before-01-patron-390x844-scroll-0-CLIPPED.png` (was `01-patron-390x844-scroll-0.png`) — 390px scroll 0, trigger clipped at right edge
- `01-patron-390x844-scroll-{0.25,0.5,0.75,1}.png` — 390px mid/end-scroll, unaffected by the defect (kept as-is, no row overlap either before or after the fix)
- `before-02-patron-390-header-closeup-CLIPPED.png` (was `02-patron-390-header-closeup.png`) — tight header crop at 390px showing the clip
- `03-patron-390-sheet-open.png` — feedback sheet open via header trigger (unaffected by the defect, kept as-is)
- `before-04-patron-320x844-scroll-0-CLIPPED.png` (was `04-patron-320x844-scroll-0.png`) — 320px, scroll 0, trigger entirely absent from view
- `before-05-patron-320-header-closeup-CLIPPED.png` (was `05-patron-320-header-closeup.png`) — tight header crop at 320px, defect clearly visible
- `06-patron-320x844-scroll-0.5.png` — 320px mid-scroll, no overlap (unaffected, kept as-is)
- `07-landing-{390,320}x844-scroll-0.png`, `08-…-scroll-0.4.png`, `09-…-scroll-0.7.png`, `10-…-scroll-1.0.png` — landing page sweeps at both widths (unaffected — the landing page never had this defect)
- `11-desktop-1280-landing.png`, `12-desktop-1280-patron-room.png` — desktop, trigger absent, fixed pill present (unaffected)
- `_measurements.json` — raw bounding-box/position/intersection data from the initial pass (short nicknames — this is exactly what hid the defect from the original ticket evidence; see re-test section)

## Recommendation (initial pass)

Do not treat this as ready to ship as-is. The header trigger is a **real regression risk on the exact device class (narrow phones) the ticket exists to serve** — a guest on an iPhone SE (320px, still a meaningfully common width) cannot see the new entry point at all, and even a 390px guest (iPhone 12/13/14 mini-class widths and up) sees it half-cut. Suggest the Dev either:
1. Constrain/truncate the greeting text and/or shrink the LanguageSwitcher on the patron room header at narrow widths so the row's total content fits, or
2. Let the patron header wrap the way the landing page's header already does (add `flex-wrap: wrap` or similar to the inline header style in `PatronRoom.tsx`), or
3. Give the trigger a guaranteed `flex-shrink: 0` slot reserved before the other header content shrinks/truncates.

And separately, file a small regression-suite gap: extend the patron-room "TICKET-72" test in `e2e/feedback-widget-safe-area.spec.ts` to also assert `triggerBox.x + triggerBox.width <= viewportWidth` (mirroring the check that already exists for the landing page), so this class of defect can't recur silently.

---

## Re-test after fix (commit `79aa53d`)

**Root cause confirmed by the Dev's fix commit:** the patron header was a rigid `justify-content: space-between` row with no wrap and a greeting group that could not shrink. My original repro used a short seeded nickname ("PatronoEvidencia390"/"...320", which happen to be even LONGER than 18 chars, actually — the real reason the defect was found here and not in the original ticket evidence is that the original ticket's own screenshots used short/no nicknames). The fix: `min-width:0` + `flex-shrink:1` + `overflow:hidden` on the greeting group, `text-overflow:ellipsis` + `white-space:nowrap` on the nickname button (`data-testid="patron-nickname-button"`), `flex-shrink:0` on the language switcher and "Oi," label, and `flex-wrap:wrap` on the header itself as a fallback. The regression suite was also fixed: the patron-room TICKET-72 test now asserts horizontal containment at both 390 and 320, asserts header non-overflow, and uses an 18-char nickname ("MariaFernandaSilva") so the assertions have something real to check.

### Method

Re-ran with an 18-char realistic nickname ("MariaFernandaSilva", matching the regression spec exactly) at 390 and 320, PLUS a 24-char stress case ("AnaBeatrizFernandesCosta") at both widths — deliberately longer than what the spec checks, to probe past the fix's own boundary. Also re-ran the full `e2e/feedback-widget-safe-area.spec.ts` file (all 8 tests, including the original TICKET-71 coverage and both TICKET-72 tests) to confirm no regressions. All runs on PORT=3184, foreground, real dev server.

### Measured numbers

| Case | width | trigger `x` | trigger `x+width` | viewport width | clipped right? | header `scrollWidth` | header `clientWidth` | overflow | header rows |
|---|---|---|---|---|---|---|---|---|---|
| 18-char nick | 390 | 334 | **374** | 390 | **NO** | 358 | 358 | **0** | 2 |
| 18-char nick | 320 | 264 | **304** | 320 | **NO** | 288 | 288 | **0** | 2 |
| 24-char stress | 390 | 334 | **374** | 390 | **NO** | 358 | 358 | **0** | 2 |
| 24-char stress | 320 | 16 | **56** | 320 | **NO** | 288 | 288 | **0** | 3 |

(`getComputedStyle(trigger).position` is `static` in all four cases, matching the ticket's structural requirement — never `fixed`.)

Compare against the ORIGINAL (pre-fix) numbers documented above: 390px trigger right edge was 405.125 (15px over); 320px trigger right edge was 404.67 (85px over, fully off-canvas); header overflow was 101px at 320. All three are now zero/contained.

**Nickname truncation:** at both widths and both nickname lengths, `nickComputed.textOverflow` is `ellipsis` and `whiteSpace` is `nowrap`, but in every measured case `scrollWidth === clientWidth` — i.e. the nickname never actually needed to truncate, because the header's `flex-wrap` fallback kicked in first (2 rows for the 18-char case, 3 rows for the 24-char stress case at 320px) and gave the nickname its own line with enough room. So the ellipsis CSS is present and correct but wasn't exercised by these specific strings — it would trigger on an even longer single unbroken token, which is an acceptable residual (the 30-char DB field limit combined with 3-row wrap leaves very little room for that to actually clip in practice, but see "new observations" below).

**Row/badge overlap sweep (18-char nickname, 25-row queue, scroll fractions 0/0.25/0.5/0.75/1, both widths):** zero overlaps at any fraction, either width — `rowOverlapByScrollFraction` is `false` for all 10 (width × fraction) combinations measured.

**Full regression suite** (`e2e/feedback-widget-safe-area.spec.ts`, all 8 tests): **8 passed**, including the original TICKET-71 25-row sweep, the short/pending-queue tests, the safe-area-inset test, both TICKET-72 tests (patron room + landing page), and the desktop tests. No regressions.

### New observations from hunting again (post-fix)

- **The patron header now wraps to 2 rows at 390px and up to 3 rows at 320px under stress**, where pre-fix it never wrapped at all (it overflowed instead). Visually inspected both — `work/evidence/TICKET-72/14-patron-390-header-closeup-longnick.png`, `14-patron-320-header-closeup-longnick.png`, `16-patron-320-header-closeup-stressnick.png` — all read cleanly: brand row, then language-switcher+greeting+nickname+trigger row (2-row case), or switcher+greeting on their own row above nickname+trigger (3-row stress case at 320). Nothing overlaps, nothing is clipped, alignment reads fine given the row is genuinely wrapping now rather than a single baseline row.
- Full-page screenshots (`13-patron-{390,320}x844-longnick-scroll-0.png`, `15-patron-{390,320}x844-stressnick-scroll-0.png`) confirm the extra header height pushes the "Fila ao vivo" queue list down slightly but does not cause any new overlap; the room's `venue-chip` and "Adicionar música" card are unaffected.
- Did not find: the language switcher collapsing/losing its flag+"PT" content, the trigger losing its 40×40 tap-target size, any new left-edge clipping, or any new overlap with queue rows/badges introduced by the taller wrapped header.
- Genuinely nothing to flag as new house debt — the fix's own `flex-wrap` fallback is doing exactly the job its doc comment claims, at least up to a 24-char nickname, which comfortably covers realistic names within the 30-char DB limit.

### Verdict

**PASS.** The clipping defect is fixed and verified with numbers at both the exact case the regression suite checks (18-char) and a deliberately harsher case the suite does not check (24-char). No regressions found anywhere else in the suite. Recommend proceeding to merge review.

### Evidence files added in re-test

- `13-patron-{390,320}x844-longnick-scroll-{0,0.25,0.5,0.75,1}.png` — full scroll sweep, 18-char nickname, both widths
- `14-patron-{390,320}-header-closeup-longnick.png` — header crops, 18-char nickname
- `15-patron-{390,320}x844-stressnick-scroll-0.png` — 24-char stress case, scroll 0, both widths
- `16-patron-{390,320}-header-closeup-stressnick.png` — header crops, 24-char stress case
- `_measurements-retest.json` — raw bounding-box/overflow/overlap data backing the numbers above
