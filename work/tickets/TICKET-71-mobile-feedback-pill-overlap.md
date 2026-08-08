# TICKET-71 — Stop the mobile feedback pill covering queue rows and the CANTAR button

- **Status:** delivered (PR open, not merged)
- **Branch:** `ticket/71-mobile-feedback-overlap` · **Worktree:** `.worktrees/ticket-71` · **Port:** 3183
- **Origin:** live app tour, 2026-08-07 (`work/reports/state-of-boraoke-2026-08-07.html`, "The feedback pill covers live queue content").

## Problem

On mobile (390px), the floating "Enviar feedback" pill sits directly on top of the last visible queue row's song title and its CANTAR button — a fixed overlay with no reserved safe area. The obscured control is how a guest actually queues a song, so this hits the product's primary mobile action.

Evidence: `work/evidence/app-tour/patron-room-populated-queue-mobile.png`, `patron-pending-approval-mobile.png`.

## Root-cause investigation

Two distinct failure modes were found, not one:

1. **Long-queue, scrolled-to-true-bottom case.** The pill is `position: fixed` and contributes nothing to document flow, so a page that is exactly as tall as its content has no guaranteed clearance after the true last row. A trailing `<footer>` happens to give ~90px of clearance today, which is why this specific case wasn't independently reproducible with a short synthetic queue — but that clearance is coincidental (tied to footer copy length), not guaranteed, and would break the instant the footer changes or `env(safe-area-inset-bottom)` eats into it on a notched phone.
2. **Short-queue, first-paint case — this is what the evidence screenshot actually shows.** With ~5 songs, the page barely exceeds viewport height, so on the very FIRST paint (scrollTop 0, before any user scrolling) the last *visible* row happens to render exactly where the pill's fixed footprint sits. This is structurally different from (1): a trailing spacer/padding can never move a row that renders *before* it in the document — reserving space at the page's end has zero effect here. Confirmed by direct reproduction (see investigation notes below); this is the row the ticket's own wording ("last visible queue row") describes.

## Fix — REVISED after an independent verifier refuted the first version

**First version (refuted, kept here for the record):** a live JS collision-avoidance lift (`useCollisionLift`) that kept the mobile pill `position: fixed` and measured it against on-screen queue rows each frame, `translateY`-nudging it clear of whatever it currently overlapped (capped at 50% of viewport height). This passed a 5-row smoke test checking only scroll fractions 0.0 and 1.0, and passed an opus review that also only probed those two extremes. An independent verifier swept a **25-song queue across scroll fractions 0.0–1.0** and found it net-negative: from roughly frac 0.2 to 0.9 the required lift saturated the cap and the pill still overlapped 1–2 rows — with the **same** overlap count whether the JS lift was on or off. The nudge never removed an overlap at mid-scroll; it only relocated the same overlap from the bottom-right corner into the screen's vertical center, where it also kept moving as the guest scrolled. Worse than the original bug. The root cause is structural, not a tuning bug: **a `position: fixed` overlay sitting over a scrollable list of unbounded length will coincide with some row at some scroll offset — that cannot be fixed by padding (only helps at the true scrolled-to-bottom rest state) or by nudging (only relocates where the unavoidable overlap lands).**

**Current fix**, scoped to `components/FeedbackWidget.tsx`, `components/feedback/FeedbackWidget.module.css`, and the same two `data-testid`s on `app/(patron)/[room]/PatronRoom.tsx`:

1. **Mobile: drop `position: fixed` entirely** (`components/feedback/FeedbackWidget.module.css`, `.fab` under `max-width: 700px`). The pill renders in normal document flow — the widget mounts once in `app/layout.tsx`, after `{children}`, so it appears once, at the true end of the page. A normal-flow element can never spatially coincide with a queue row at any scroll position, by construction, regardless of queue length — this is a geometric guarantee, not a heuristic. `useCollisionLift` was removed entirely; there is nothing left to measure or nudge.
2. **Mobile: safe-area-only spacer** (`.spacer`, same file): now just `env(safe-area-inset-bottom, 0px)` — a courtesy gap so the in-flow pill isn't flush against an iPhone's home-indicator, not a pill-footprint reservation (no longer needed once the pill isn't floating).
3. **Desktop: unchanged.** Desktop was never reported broken (the fixed pill floats clear in the page margin) and keeps its original `position: fixed` behavior and zero-height spacer, exactly as before this ticket — verified via a dedicated test asserting `getComputedStyle(fab).position === "fixed"` and `spacerHeight === 0` there.

The widget is mounted globally (`app/layout.tsx`, out of this ticket's file scope) so the fix applies to every page it renders on without per-page changes, except the two testids added to `PatronRoom.tsx`.

## Pages that render the widget

Mounted once in `app/layout.tsx`, on every route except `/tv` and `/[room]/tv` (AC7 from TICKET-11, unchanged):
`/` (landing), `/new`, `/admin`, `/admin/analytics`, `/[room]` (patron — **affected**, fixed), `/[room]/admin` (host — mounts the same globally-fixed widget, so gets the same in-flow-on-mobile behavior automatically; the admin queue rows just don't carry the `queue-row-title`/`queue-row-badge` testids, which no longer matters since nothing measures against them any more).

## Explicitly out of scope

- `app/globals.css`, `app/page.tsx`, `components/tv/**`, `e2e/helpers.ts`, `e2e/contrast.spec.ts` — sibling-owned files under parallel tickets; untouched.
- The `main-content-below-the-fold-on-load` root cause more broadly (reducing how much vertical space the "Adicionar música" form consumes above the fold) — moot now; the mobile pill no longer floats over that content at all.

## Regression test

`e2e/feedback-widget-safe-area.spec.ts` — 5 tests, geometry-based (bounding-box intersection between the pill and a row's title/badge, not CSS class names):
1. **The decisive test**, added after the refutation: a **25-row queue**, asserting no overlap swept across scroll fractions **0.0 / 0.2 / 0.5 / 0.8 / 1.0**. This is the test that would have caught the original (refuted) fixed-pill-plus-nudge approach — the earlier 5-row-only, two-scroll-extreme-only spec structurally could not reach the mid-scroll states where that approach failed.
2. Populated queue (short, 5 rows): the ticket's own original evidence scenario (first-paint, no scrolling) — now trivially satisfied since the mobile pill isn't fixed, kept as a cheap smoke test.
3. Pending-approval state: same idea, on that page.
4. Home-indicator safe-area inset (simulated via CDP `Emulation.setSafeAreaInsetsOverride`): the mobile spacer grows by the inset amount, bounded well under the old ~114px pill-footprint reservation (proves the spacer shrank to a safe-area-only courtesy gap, not that it silently kept the old sizing).
5. Desktop: zero dead space at the page bottom, AND the pill is still `position: fixed` there (desktop is unaffected by this ticket).

**Teeth proven twice** — once for the refuted lift-based version, once for the current in-flow version: reverting `components/FeedbackWidget.tsx` + `FeedbackWidget.module.css` (keeping the branch's other changes) turns 4 of 5 tests red (title-overlap / spacer-height-out-of-range); test 5 (desktop) correctly still passes since desktop was never touched by either version of the fix.

## Second Reviewer pass — findings addressed / deferred

A second, independent opus review of the redesigned (in-flow) fix ran its own probe (35 rows, 21 scroll positions every 5%, checking title + badge + the whole row `<li>` = 2205 checks, 0 overlaps; same probe against `origin/main` found 68) and confirmed the geometric-guarantee claim directly (`getComputedStyle(fab).position === "static"` on mobile, not inferred from absence of overlap). Verdict: APPROVE-WITH-FOLLOWUPS. Findings:

- **F1 (MEDIUM, fixed in this branch):** the spacer div was rendered *before* the fab in the DOM, so on mobile the safe-area gap landed above the pill, not below — its stated purpose (clear the iPhone home-indicator) wasn't achieved. Fixed by moving the spacer to render immediately after the fab; the safe-area test now also asserts the spacer's Y-position is below the fab's, not just its height (the exact gap the reviewer noted the old test couldn't catch).
- **F2 (MEDIUM, deferred — out of file-scope boundary):** `app/metadata.ts` doesn't set `viewportFit: "cover"`, so `env(safe-area-inset-*)` resolves to `0` in production regardless of device notch. The safe-area test only demonstrates the CSS is wired correctly (via a CDP inset override), not that it's active in production today. `app/metadata.ts` is outside this ticket's file boundary (mounted globally, shared with every page) — flagged as a follow-up ticket, not fixed here.
- **F3 (MEDIUM, product/TL call, not fixed):** discoverability. The in-flow mobile pill now sits at the true end of the page — on a busy-room queue (the reviewer's 35-row probe: ~2430px of scroll on a 3274px page) a guest has to scroll substantially to reach it. It is not hidden (178×48px, icon+label, confirmed tappable), but feedback volume in busy rooms will likely drop relative to the always-visible-but-buggy original. This is the conscious tradeoff of the geometric-guarantee fix — flagged for the TL/PO to weigh, not something a Dev pass should silently resolve either direction.
- **F4 (LOW, fixed in this branch):** a stale code comment claimed the fab rendered "before the spacer above" (no longer true after the F1 fix); `--pill-gap` was a dead CSS custom property left over from the refuted version's pill-footprint spacer math. Comment corrected, dead token removed.
- **F5 (LOW, fixed in this branch):** the three committed evidence PNGs predated the redesign and depicted the refuted fixed-pill-plus-nudge version. Recaptured against the current in-flow design.
