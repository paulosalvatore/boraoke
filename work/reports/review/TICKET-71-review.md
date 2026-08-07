# TICKET-71 — Reviewer gate

- **Branch:** `ticket/71-mobile-feedback-overlap` (HEAD `821fff4`) · **Base:** `origin/main` `118ad06`
- **Worktree:** `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-71` · **Port:** 3183 (e2e), 3184 (independent geometry probe)
- **Verdict: APPROVE-WITH-FOLLOWUPS**

## Summary

The fix does what the ticket claims, and I re-derived the geometry rather than trusting the code comments or the history. Two complementary mechanisms — a normal-flow reserved-space spacer sized from shared CSS custom properties plus `env(safe-area-inset-bottom)`, and a live `useCollisionLift` that measures the pill's unlifted footprint from layout properties (`getComputedStyle(fab).bottom` + `offsetHeight`) against on-screen `queue-row-title`/`queue-row-badge` rects and iteratively lifts it clear. All gates green, the regression spec has real teeth (proven independently below), scope and boundary lists were respected exactly, and I confirmed empirically that the previously-reported runaway oscillation is gone.

One genuinely misleading artifact remains: the committed "after" evidence screenshot `after-patron-queue-unscrolled.png` *appears* to show the bug unfixed. I chased that down and it is **not** a logic defect — it is a mid-transition capture. Details in Findings; it warrants a follow-up, not a block.

## Verification performed

| Check | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | 2230 lines — **zero** referencing `FeedbackWidget`, `PatronRoom`, or `feedback-widget-safe-area`. Pre-existing baseline (jest-globals untyped test files, e.g. `__tests__/youtube.test.ts(203,5): Cannot find name 'expect'`). |
| Unit | `npm test` | **43 suites / 683 tests passed**, 0 failed (1.7s) |
| Build | `npm run build` | Succeeded, all routes emitted |
| E2E (full) | `PORT=3183 npx playwright test --reporter=list` | **69 passed / 0 failed** (2.9m), 17 files |
| E2E composition | `npx playwright test --list` | `contrast.spec.ts` = **16 tests, all green** (no fallout from the TICKET-66 accent-token rebase); `feedback-widget-safe-area.spec.ts` = **4 tests, all green** |

### Independent geometry probe (my own, not the App Tester's)

Standalone Playwright script against a fresh dev server on :3184, 390x844, 5-song queue, measuring real bounding boxes:

- **Settled unscrolled state:** `transform=translateY(-172.75px)`; pill box `y=607.25..655.25`; nearest row title top `y=667.25`. Clearance = **exactly 12px = `LIFT_GAP`**. The formula is empirically correct to the pixel.
- **Iteration proven live:** the lift skipped past rows 2 and 1 to clear row 0 — i.e. it did *not* stop at the first intersecting row. The stacked-row bug from history is genuinely fixed.
- **Scrolled to bottom:** `transform=none`, pill `y=780..828`, all five rows clear — the spacer alone suffices there, as designed.
- **Oscillation check:** sampled the applied transform 20x over 2s — `["none" × 20]`, perfectly stable. No runaway.

## Teeth-proof result

Reverted **only** `components/FeedbackWidget.tsx` + `components/feedback/FeedbackWidget.module.css` to `118ad06`, kept everything else, re-ran the spec:

```
3 failed, 1 passed (24.2s)
```

- **Test 1** (populated queue, unscrolled + bottom) — FAILED
- **Test 2** (pending-approval) — FAILED: `expect(received).toBe("clear")` → `Received: "title-overlap-row-3"`, "Timeout 3000ms exceeded while waiting on the predicate" (spec line 71, via line 200)
- **Test 3** (safe-area inset) — FAILED: `expect(spacerHeight).toBeGreaterThanOrEqual(113)` → `Received: 0`
- **Test 4** (desktop, no dead space) — passed, as expected: it is a negative control asserting `spacerHeight === 0`, which is trivially true when no spacer exists.

Fix restored via `git checkout HEAD -- <2 files>`; `git status --porcelain` is **empty** — worktree clean, no stray changes.

## Assertion quality (spec read closely)

Meaningful, not vacuous:

- Real bounding-box intersection arithmetic (`rectsIntersect`), not class-name or CSS-property assertions.
- Returns a **descriptive string** (`"clear"` / `"title-overlap-row-N"` / `"missing-geometry"`) rather than a boolean, so a missing element fails loudly instead of passing as "no overlap" — a common vacuous-pass trap, correctly avoided.
- `expect.poll` with a 3s timeout tolerates the rAF/transition settle without masking a broken build (a broken build never converges — confirmed by the teeth-proof timing out).
- Every awaited call is awaited; selectors match the testids actually added to `PatronRoom.tsx`.
- Checks **all** visible rows via `findRowsAboveFold`, not just the last — which is exactly what caught row 3 under revert.

## Scope / boundary

- `git diff 118ad06..HEAD --name-only` = the 5 expected files + 3 evidence PNGs under `work/evidence/TICKET-71/` + `work/events/by-branch/ticket-71-mobile-feedback-overlap.jsonl` (framework event log, auto-committed). **Nothing sibling-owned.**
- Boundary list `app/globals.css`, `app/page.tsx`, `components/tv/**`, `e2e/helpers.ts`, `e2e/contrast.spec.ts` — **all untouched**.
- `app/layout.tsx` untouched; verified read-only that `<FeedbackWidget />` is still mounted once (line 27) and the `/tv` exclusion lives in the component's own `pathname` guard, unmodified.

## Findings

**MEDIUM — misleading committed evidence (`after-patron-queue-unscrolled.png`).** The screenshot shows the pill sitting on Song 2's row, which reads as "the bug is not fixed". I reproduced and diagnosed it: at t+0 the DOM transform is *already* the correct `translateY(-172.75px)`, but `.fab` carries `transition: transform 0.12s ease`, so the paint captured at that instant is mid-flight (`boundingBox y=772` en route to the settled `607`). By t+1s it is fully clear. The App Tester captured before the 120ms animation settled. The behaviour is correct; the artifact is not. Recommend recapturing that one screenshot after a settle delay so the evidence trail doesn't read as a failure to a future reader.

**LOW — a ~120ms entrance overlap flash on every mobile load.** The same transition means the pill visibly sweeps up across a queue row on first paint. Cosmetic and it reads as a normal entrance animation, but if it is ever unwanted, suppressing the transition for the *initial* lift (or scoping `transition` to hover/active only) removes it. Not worth blocking.

**LOW — the lift can park the pill over untagged content.** Clearing tagged rows moved the pill to `y=607`, adjacent to the "Fila ao vivo (5 músicas)" / "Modo: Karaokê completo" block; it happens to miss it horizontally (text ends x≈190, pill starts x≈195). The mechanism only knows about the two testids, so clearance from anything else is coincidental. Acceptable for this ticket's scope; worth remembering if the layout shifts.

**LOW — already self-declared by the ticket, agreed as follow-ups:** admin queue rows (`AdminRoom.tsx`) carry no testids so the lift does not actively protect that view; `--pill-size: 48px` is a fixed assumption that would drift if the pill ever wraps to two lines in another locale (spacer would under-reserve, though the collision lift still covers mobile).

**Cap sanity:** `MAX_LIFT_RATIO = 0.5` (422px at 844 tall) with the loop guarded by both `newLift < cap` and `MAX_LIFT_ITERATIONS = 6`, then clamped by `Math.min`. Cannot run away. Target rects are read once outside the loop, which is correct — the fixed pill's transform cannot reflow them.

## Verdict

**APPROVE-WITH-FOLLOWUPS.** Correct, stable, well-tested, in-scope. The only item I would like actioned is recapturing `after-patron-queue-unscrolled.png` post-settle so the committed evidence stops contradicting the fix; the remaining items are genuine low-severity follow-ups, none of which should hold the merge.
