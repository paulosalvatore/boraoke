# TICKET-71 — Reviewer gate (RE-REVIEW after refutation)

- **Verdict: APPROVE-WITH-FOLLOWUPS**
- **Branch:** `ticket/71-mobile-feedback-overlap` · base `be59814` · worktree `.worktrees/ticket-71` · port 3183
- **Date:** 2026-08-08
- **Scope of this review:** this file OVERWRITES the earlier review on this branch. I am aware a prior version of this fix (a `position: fixed` mobile pill plus a `useCollisionLift` JS nudge) passed an earlier opus review and was then REFUTED by an independent verifier. I inherited none of that verdict: I re-read the ticket, the diff and the spec from disk, and re-verified every load-bearing claim with my own probes rather than trusting the spec file or the ticket's prose.

## Gates run (all by me, in this worktree)

| Gate | Result |
| --- | --- |
| `npm run build` | PASS (clean Next production build) |
| `npm test` (jest) | PASS — 43 suites, **683/683** tests |
| `PORT=3183 npx playwright test --reporter=list` (full suite, foreground) | PASS — **73/73**, 3.9m, zero flakes |
| `npx tsc --noEmit` | 2230 errors, **all pre-existing baseline noise** — jest/playwright globals are not declared in `tsconfig.json` (`__tests__/**`, `e2e/**`), and the repo has no `typecheck` npm script, so tsc-clean is not a project gate. **Zero** errors mention `FeedbackWidget.tsx`, `FeedbackWidget.module.css`, `PatronRoom.tsx` or `feedback-widget-safe-area.spec.ts`. Not a regression; flagged only for the record. |

## 1. Independent verification of the geometric-guarantee claim (my own probe, not the spec)

Throwaway probe (`e2e/zz-reviewer-probe.spec.ts`, written, run, then deleted — tree left clean), deliberately harder than the committed spec:

- **35 queue rows** (spec uses 25), own room, 390x844.
- **21 scroll samples** — every 5% from 0% to 100% (spec uses 5 fractions).
- Intersection checked against **three** boxes per row — `queue-row-title`, `queue-row-badge`, **and the whole `<li>` row** (the spec only checks title+badge; a pill overlapping row chrome but missing both would slip past it).
- 35 rows x 21 positions x 3 boxes = **2205 intersection checks**.

**Result: 0 overlaps.** Page was 3274px tall, maxScroll 2430px — a real long-queue page, not a synthetic short one.

**Structural (not symptom) confirmation, as required:** `getComputedStyle(fab).position === "static"` on mobile, read directly. The claim is confirmed at the CSS level, not inferred from a lucky bounding-box sweep.

**My probe has teeth too.** Run against the reverted (base `be59814`) implementation, the same probe reports `position = fixed` and **68 overlap hits** across the same 21 scroll positions. 68 -> 0 is the measured delta of this fix; the sweep is not vacuous.

**Breakpoint sweep (my probe):** widths 640 / 699 / 700 -> `position: static`, spacer `display: block`; widths 701 / 760 -> `position: fixed`, spacer `display: none`. Clean switchover at exactly 700/701 — no width where both rules apply, no width where neither does. The mobile block is later in the source than the base `.fab` rule, so specificity/order is unambiguous.

**Desktop regression check (my probe, independent of spec test 5):** at 1280x900, `position: fixed`, `bottom: 16px`, `right: 16px`, spacer `display: none`, spacer height **0**. The "a previous draft accidentally added dead space to desktop" mistake is **NOT present** in the committed version — verified directly, not inferred.

## 2. Teeth-proof of the committed regression spec

Reverted ONLY `components/FeedbackWidget.tsx` + `components/feedback/FeedbackWidget.module.css` to `be59814`, kept everything else, re-ran `e2e/feedback-widget-safe-area.spec.ts`:

**4 failed, 1 passed** — exactly as the ticket claims.

- Test 1 (25-row sweep): RED — `row 2 title overlaps the pill`, `expect(rectsIntersect(...)).toBe(false)` received `true`.
- Test 2 (5-row short queue): RED — `row 2 title overlaps the pill`.
- Test 3 (pending-approval): RED — `row 3 title overlaps the pill`.
- Test 4 (safe-area spacer): RED — `expect(spacerHeight).toBeGreaterThanOrEqual(33)`, received `0`.
- Test 5 (desktop fixed + zero spacer): GREEN — correct, desktop is untouched by either version of the fix.

Restored with `git checkout HEAD -- <both files>`; `git status` clean, probe file and `test-results/` removed.

## 3. Scope

`git diff be59814..HEAD --name-only` is exactly: `app/(patron)/[room]/PatronRoom.tsx`, `components/FeedbackWidget.tsx`, `components/feedback/FeedbackWidget.module.css`, `e2e/feedback-widget-safe-area.spec.ts`, `work/events/by-branch/ticket-71-mobile-feedback-overlap.jsonl`, `work/evidence/TICKET-71/*.png` (3), `work/reports/review/TICKET-71-review.md`, `work/tickets/TICKET-71-mobile-feedback-pill-overlap.md`. Nothing else.

Declared boundary (`app/globals.css`, `app/page.tsx`, `components/tv/**`, `e2e/helpers.ts`, `e2e/contrast.spec.ts`) — **0 files touched**. Clean.

`PatronRoom.tsx` changes are three `data-testid` additions only — no behavioral change.

## 4. Usability of the now-in-flow mobile pill (does this cross into "hidden"?)

Measured, not assumed. On the 35-row page: pill is **178 x 48 px**, `display: flex`, `visibility: visible`, `opacity: 1`, text `"💬Enviar feedback"` — full icon + label, centered (`margin: 24px auto 0`), full brand gradient. Scrolled to page bottom it is on screen and I **clicked it and confirmed the feedback sheet opens**. It is a real, tappable, clearly-affordanced button — this is **not** functionally equivalent to hiding it, and the ticket's "do not simply hide the widget on mobile" constraint is respected.

The honest tradeoff, flagged for the TL (F3 below): the pill now sits at document offset 3226 of a 3274px page, so on a long-queue room a guest scrolls ~2430px to reach it, where before it was always on screen. That is inherent to the in-flow design and is the price of the geometric guarantee. It is a standard footer-CTA pattern, and I judge it clearly better than a pill that covers the CANTAR button — but feedback volume in busy rooms will likely drop, and that is a product call worth making consciously.

## Findings

### F1 (MEDIUM) — the safe-area spacer is rendered on the wrong side of the pill

`FeedbackWidget.tsx:83` renders `<div className={styles.spacer}>` **before** the `<button className={styles.fab}>`. On mobile the fab is in normal flow, so the spacer's `env(safe-area-inset-bottom)` gap lands **above** the pill, not below it. Measured with a 34px CDP inset override: `spacerTop 350.4 -> spacerBottom 384.4`, then `fabTop 408.4 -> fabBottom 456.4`, `spacer precedes fab = true`. Its stated purpose in both the TSX and CSS comments — "so the in-flow pill isn't flush against an iPhone's home-indicator" — is therefore **not achieved**; the pill's bottom edge is the document's bottom edge (probe: pill bottom 844.4 in an 844px viewport). Spec test 4 passes because it only asserts the spacer's *height*, never its *position relative to the pill*, so it cannot catch this.

Not a blocker: the ticket's actual defect (pill covering queue rows) is fully fixed, and this is a few-pixels-of-bottom-padding cosmetic issue on notched phones. Fix is one line — move the spacer after the fab, or drop it on mobile and put the inset into the fab's own `margin-bottom`.

### F2 (MEDIUM) — `env(safe-area-inset-bottom)` is inert in production; test 4 is a false assurance

`app/metadata.ts:53` exports `viewport = { themeColor: "#0D0A14" }` with **no `viewportFit: "cover"`**. Without `viewport-fit=cover`, iOS Safari resolves `env(safe-area-inset-*)` to `0`, so on a real notched device both the mobile `.spacer` height and the desktop `.fab`'s `bottom: calc(16px + env(...))` collapse to their zero-inset values. Spec test 4 only passes because Chrome DevTools' `Emulation.setSafeAreaInsetsOverride` injects the inset regardless of `viewport-fit`. So the spec asserts a code path that cannot fire in production. Harmless today (the fix does not depend on it), but combined with F1 the entire safe-area story on this branch is decorative. Either add `viewportFit: "cover"` (out of this ticket's file scope — needs its own ticket) or drop the claim from the comments and the test.

### F3 (MEDIUM, product judgment — TL call, not a code defect)

Feedback discoverability on mobile long-queue rooms drops from "always on screen" to "at the bottom of the page" (~2430px of scroll on a 35-row queue). See section 4. Worth a conscious TL decision; a future ticket could restore always-visible affordance without a fixed overlay (e.g. a sticky element inside a bounded, non-overlapping bottom bar that reserves its own flow space).

### F4 (LOW) — comment contradicts the DOM, and a dead token

- `FeedbackWidget.module.css:97-99` says the mobile pill renders "as the last thing on the page (after `{children}`, **before** the safe-area-only spacer above)". The spacer is actually rendered **first**. The prose is wrong in the same direction as F1 and should be corrected with it.
- `--pill-gap: 16px` (`.root`, line 25) is now referenced nowhere — dead token left over from the reverted footprint math. `--pill-offset` and `--pill-size` are still used.

### F5 (LOW) — committed "after" evidence predates the redesign

All three PNGs in `work/evidence/TICKET-71/` were last written by `345ddcf` / `8d29a6a`, both **before** the redesign commit `ab8070f`. They therefore depict the REFUTED fixed-pill version, not the shipped in-flow one. The PR's own visual evidence is stale and misleading to anyone reading it as proof of the current fix. Recapture before merge, or delete them and point at this report's measurements.

## Assessment

The redesign is the right call and it holds up under adversarial probing. The previous version's failure was structural — a fixed overlay over an unbounded list — and the replacement removes the overlay rather than tuning it, which is why my 2205-check sweep finds zero overlaps where the base finds 68. The structural claim (`position: static` on mobile) is confirmed directly, desktop is genuinely untouched, the breakpoint has no gap or overlap, and the committed spec has proven teeth. All five findings are cosmetic, documentary, or product-judgment; none touches the ticket's actual defect or blocks merge. F1/F4 are a one-line follow-up; F2 and F5 want their own small tickets; F3 wants a TL opinion.

**APPROVE-WITH-FOLLOWUPS.**
