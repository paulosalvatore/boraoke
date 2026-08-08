# TICKET-72 — Make feedback discoverable on mobile without reintroducing the overlap

- **Status:** delivered (PR open, not merged)
- **Branch:** `ticket/72-feedback-discoverability` · **Worktree:** `.worktrees/ticket-72` · **Port:** 3184
- **Filed:** 2026-08-08, from TICKET-71's second Reviewer pass, finding F3.

## Why this exists

PR #51 (TICKET-71, merged as `de9e98c`) fixed the mobile feedback pill covering queue rows and the CANTAR button by dropping `position: fixed` on mobile and rendering the pill in normal document flow, at the true end of the page. That is a geometric guarantee against overlap (2205 checks across 35 rows × 21 scroll positions: 0 overlaps, vs. 68 on `main` before the fix) — but it traded away the pill's always-on-screen reachability.

On a long queue a guest now has to scroll ~2430px of a 3274px page to reach "Enviar feedback". The feedback loop is a founding product pillar (TICKET-39, "your suggestion shipped"), and a quiet drop in feedback volume would undercut it silently, with no error to surface the regression.

## The constraint this ticket had to respect

`e2e/feedback-widget-safe-area.spec.ts`'s 25-row / 5-scroll-fraction sweep is the test that refuted TICKET-71's first attempt. It stays green, unmodified. Nothing below weakens, skips, or rewrites it — the only edit to that file is **added** coverage.

## Approach — decided on measurement, not preference

A throwaway probe (written, run, deleted) swept **21 scroll positions** and counted how often each candidate *fixed* footprint would intersect interactive content, on a 35-row patron room and on the landing page:

| candidate footprint (fixed, bottom-right) | room, 35 rows (390px) | landing (390px) | landing (320px) |
| --- | --- | --- | --- |
| 178×48 pill (the original) | 39 | 12 | 9 |
| 48px circle | 19 | 8 | 5 |
| 40px circle | 16 | 7 | 5 |

**"Just make it smaller" does not work.** A queue row measures `x=16 … 374` in a 390px viewport and the landing page's CTAs are equally full-bleed — there is no horizontal gutter for a fixed target to live in at mobile widths. This is the same structural fact TICKET-71 found, re-measured against the smaller footprints this ticket was asked to weigh.

### Chosen: a second entry point, also in normal document flow, at the OTHER end of the page

A compact icon-only (40×40) trigger is rendered into the page's own `<header>` via a React portal, mobile-only. It is `position: static` — normal-flow content occupying its own box in the header's layout — so it carries **exactly the same geometric guarantee as the in-flow pill**: it cannot spatially coincide with a queue row at any scroll position, by construction, for any queue length. And because it lives in the header it is on screen at first paint, with zero scrolling, on every page that has a header — the patron room and the landing page included.

The portal is what makes this work on the landing page without editing `app/page.tsx` (out of this ticket's file boundary, owned by a sibling ticket). The target is resolved by a plain `document.querySelector("header")`, re-armed on route change and by a presence-guarded `MutationObserver` (the patron room only renders its `<header>` after the nickname gate). **That is DOM-presence detection, not measurement:** nothing added by this ticket reads a scroll offset, a bounding box, or runs per frame. The v1 failure mode is not reintroduced in any form.

Accessible name is deliberately different from the pill's (`Feedback.title` — "Como tá sendo? 🎶" — rather than `Feedback.trigger` — "Enviar feedback"), so the existing spec's `getByRole("button", { name: /enviar feedback/i })` never ambiguously resolves to two elements. No new locale strings were added; both keys already exist in `pt-BR`, `en` and `es`.

### Rejected

- **Icon-only circular button, still fixed on mobile.** Rejected on measurement: 16 overlaps in the room and 7 on the landing page at 390px, for the smallest (40px) variant tested. Smaller does not clear the content column because the content column is the full width.
- **Auto-hide during scroll, reveal at rest.** Rejected twice over: the at-rest positions *are* among the 21 sampled offsets, so it still overlaps exactly where the guest stops; and it would reintroduce per-frame scroll math — the precise pattern an independent verifier refuted in TICKET-71 v1.
- **Bounding the queue's scroll region (an app-shell layout with an inner scroller and a fixed bottom bar).** This would genuinely work geometrically, but it restructures the patron room's scrolling wholesale, cannot help the landing page (out of file scope), and would silently make the committed 5-fraction sweep vacuous by reducing `maxScroll` to 0 — a bad trade for a discoverability fix.
- **Accept as-is.** Fails the acceptance criteria.

## App Tester gate found a real defect — fixed, with the test gap closed

The first pass of this fix shipped a clipped control and a test that could not see it. The App Tester (`work/reports/testing/TICKET-72-apptest.md`) measured, on the **patron room only**:

- **320px:** trigger **fully off-canvas**, not visible at all. Header `scrollWidth 389` vs `clientWidth 288` — a 101px overflow.
- **390px:** trigger right edge at `x=405.125` against a 390px viewport — ~15px clipped, a half-cut circle.
- The **landing page** header handled the same trigger correctly at both widths.

**Root cause (measured, not guessed).** The patron header was a rigid `justify-content: space-between` flex row with no `flex-wrap`, whose greeting group (`LanguageSwitcher` + "Oi," + nickname button) had no `min-width: 0` and no text truncation. With a short nickname it fits (a probe with "Carla" measured `scrollWidth == clientWidth == 288` at 320px — no overflow); with a realistic-length nickname the un-shrinkable greeting grows and pushes the **last** item — the trigger — past the viewport edge. So the trigger was the victim, not the cause: the header could already not absorb its own content.

**Fix (`app/(patron)/[room]/PatronRoom.tsx`, in this ticket's file scope).** The greeting now degrades gracefully instead of shoving the trailing control off screen: `min-width: 0` + `flex-shrink: 1` + `overflow: hidden` on the greeting group, `text-overflow: ellipsis` on the nickname button, `flex-shrink: 0` on the language switcher and the "Oi," label so they never collapse, and `flex-wrap: wrap` + a `gap` on the header as a fallback for extreme text-zoom.

**Test gap closed — this is the more important half.** The App Tester correctly identified that the suite asserted horizontal containment (`x + width <= viewportWidth`) **only on the landing page**, never on the patron room, which checked vertical bounds alone — the same "the test avoided its own failure mode" pattern that refuted TICKET-71 v1, reappearing inside the ticket created to fix it. The patron-room test now:

- runs its discoverability assertions at **both 390px and 320px**;
- asserts containment in **both axes** (left edge, right edge, top, bottom);
- asserts the header itself does not overflow (`scrollWidth - clientWidth <= 1`) — the actual mechanism;
- asserts the nickname stays inside the viewport (proving it ellipsizes rather than overflowing);
- uses a deliberately **long nickname** ("MariaFernandaSilva", 18 chars) so the assertions have something to bite on. With a short nickname the row fits at any width and the test proves nothing.

**Negative control for this specific fix:** `git stash` of `PatronRoom.tsx` alone (spec kept) → **RED**, on exactly the new assertion: `Error: w=390: trigger not clipped off the RIGHT edge / expect(received).toBeLessThanOrEqual(390)`. Green after restoring the fix.

## What changed

- `components/FeedbackWidget.tsx` — portalled header trigger + the `useEffect` that resolves the portal target. No change to the pill, the spacer, the sheet, or the `/tv` exclusion.
- `components/feedback/FeedbackWidget.module.css` — `.headerTrigger`, `display: none` by default and `inline-flex` only under `max-width: 700px`. Uses a literal gradient rather than `var(--g-stage)` because the portalled node is not a DOM descendant of `.root` and would not inherit tokens scoped there.
- `app/(patron)/[room]/PatronRoom.tsx` — header made able to absorb its own content (see above). No behavioural change beyond layout; one `data-testid` added to the nickname button so the test can assert its containment.
- `e2e/feedback-widget-safe-area.spec.ts` — three tests **added**. The five pre-existing tests are byte-for-byte unchanged.

## New regression coverage (and its teeth)

1. **Header trigger visible without scrolling AND never overlaps a 25-row queue.** Asserts both halves, because either alone is satisfiable by a bad implementation: (a) at scroll 0 the trigger is inside the viewport, ≥40×40px, and the pill it supplements is provably off-screen (so the test cannot pass by the page being short); (b) `getComputedStyle(...).position === "static"` read directly, plus the same 5-fraction × 25-row geometric sweep the pill is held to; and it opens the sheet when clicked.
2. **Landing page at 390px and 320px** — trigger on screen without scrolling, not clipped horizontally at either width, `position: static`.
3. **Desktop unchanged** — on a page that genuinely renders a `<header>`, the trigger exists (`toHaveCount(1)`) but computes `display: none`, and the desktop pill is still `position: fixed`.

**Negative control (implementation reverted, spec kept):** `git stash` of `FeedbackWidget.tsx` + `FeedbackWidget.module.css` → **3 failed, 5 passed**. The three new tests go red (`element(s) not found` / `toHaveCount` received `0`); all five TICKET-71 tests stay green, confirming the new coverage is what fails and the old guarantee is independent of it.

**Second teeth-proof — the sweep catches a `fixed` re-implementation on its own.** With `.headerTrigger` temporarily forced to `position: fixed; right: 16px; bottom: 16px` *and the CSS-level `position` assertion disabled*, the test still fails on pure geometry: `Error: row 2 badge overlaps the header trigger`. So the geometric assertion is load-bearing, not a decoration on top of a CSS check.

## Dev verification (observed)

- `npm test` → `Test Suites: 43 passed, 43 total` · `Tests: 683 passed, 683 total`
- `npm run build` → clean production build
- `npx tsc --noEmit` → 2230 lines of pre-existing baseline noise (jest/playwright globals undeclared for `__tests__/**` and `e2e/**`; no `typecheck` npm script exists, so tsc-clean is not a project gate). **Zero** lines mention `FeedbackWidget.tsx`, `FeedbackWidget.module.css` or `feedback-widget-safe-area.spec.ts`. Identical to the baseline recorded in TICKET-71's review.
- `PORT=3184 npx playwright test e2e/feedback-widget-safe-area.spec.ts` → **8 passed (35.0s)**
- `PORT=3184 npx playwright test` (full suite, foreground) → **80 passed (3.7m)**, exit 0, zero flakes

**A note on a misleading intermediate run.** An earlier full-suite run reported `22 failed / 58 passed (18.1m)`, spread across `tv.spec`, `telemetry.spec`, `search.spec` and others with no connection to this change. Cause: `npm run build` had been run while a reused `next dev` server was still serving from the same `.next` directory, corrupting it mid-flight. After killing the port and clearing `.next`, the same commit ran **80 passed (8.8m)**, and again **80 passed (3.7m)** after the header fix. Recorded here so nobody re-derives it: never run `npm run build` against this worktree while a dev server is live on the same port.

## Not in scope

- Re-opening whether TICKET-71's in-flow fix was correct — it is settled, merged, and preserved intact here.
- `app/page.tsx`, `app/metadata.ts`, `app/globals.css`, `components/tv/**`, `messages/*.json` — sibling-owned (TICKET-74). No new user-facing strings were needed.
- TICKET-71 F2 (`viewportFit: "cover"` missing from `app/metadata.ts`, so `env(safe-area-inset-*)` is inert in production) — still open, still out of file scope, unaffected by this ticket.
