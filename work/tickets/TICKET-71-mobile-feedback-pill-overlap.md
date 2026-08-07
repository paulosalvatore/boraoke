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

## Fix

Two complementary mechanisms, both scoped to `components/FeedbackWidget.tsx`, `components/feedback/FeedbackWidget.module.css`, and two new `data-testid`s on `app/(patron)/[room]/PatronRoom.tsx`:

1. **Static reserved-space baseline** (`components/feedback/FeedbackWidget.module.css`): a normal-flow spacer `<div>`, rendered as the widget's own DOM (mounted once in `app/layout.tsx`, after `{children}`), sized to `--pill-offset + --pill-size + --pill-gap + env(safe-area-inset-bottom, 0px)`. Only active under `max-width: 700px` (phones/small tablets) so desktop gets zero added space. The fab's own `bottom` offset now also adds `env(safe-area-inset-bottom, 0px)` so it floats clear of a home-indicator gesture bar. This handles failure mode (1) robustly, independent of footer copy.
2. **Live collision-avoidance lift** (`components/FeedbackWidget.tsx`, `useCollisionLift`): on mount, scroll (rAF-throttled), resize, and layout changes (`ResizeObserver` on `<body>`, catching queue-poll re-renders), measure the fab's *unlifted* bounding box against every `[data-testid="queue-row-title"]` / `[data-testid="queue-row-badge"]` element currently on screen. If any intersects, `translateY` the pill up just enough to clear the nearest offender (capped at 50% of viewport height as a runaway guard). This handles failure mode (2) — the actual evidence scenario — and generalizes to "never covers interactive content at any scroll position," not just the literal scrolled-to-bottom state.

The widget is mounted globally (`app/layout.tsx`, out of this ticket's file scope) so the fix applies to every page it renders on without per-page changes, except the two testids added to `PatronRoom.tsx` for the collision check to key off.

## Pages that render the widget

Mounted once in `app/layout.tsx`, on every route except `/tv` and `/[room]/tv` (AC7 from TICKET-11, unchanged):
`/` (landing), `/new`, `/admin`, `/admin/analytics`, `/[room]` (patron — **affected**, fixed), `/[room]/admin` (host — **affected via the same mechanism**, not independently verified beyond the shared widget fix since `admin.module.css`/`AdminRoom.tsx` weren't touched; the collision-avoidance lift is DOM-generic and reacts to the same testids if ever present there, but the admin queue rows currently don't carry them — out of scope, see below).

## Explicitly out of scope

- `app/globals.css`, `app/page.tsx`, `components/tv/**`, `e2e/helpers.ts`, `e2e/contrast.spec.ts` — sibling-owned files under parallel tickets; untouched.
- Adding the same `data-testid="queue-row-title"`/`"queue-row-badge"` markers to the **admin** queue rows (`app/(patron)/[room]/admin/AdminRoom.tsx`) so the collision-lift also actively protects that view — the admin dashboard's queue rows sit in a two-column desktop-oriented layout and weren't in the evidence; flagged as a low-risk follow-up rather than silently expanding scope.
- The `main-content-below-the-fold-on-load` root cause more broadly (reducing how much vertical space the "Adicionar música" form consumes above the fold) — out of scope; the collision-avoidance lift addresses the symptom generically instead.

## Regression test

`e2e/feedback-widget-safe-area.spec.ts` — 4 tests, geometry-based (bounding-box intersection between the pill and a row's title/badge, not CSS class names):
1. Populated queue: pill clear of the last visible row, both unscrolled (first paint — the evidence scenario) and scrolled to true document bottom.
2. Pending-approval state: same, on that page.
3. Home-indicator safe-area inset (simulated via CDP `Emulation.setSafeAreaInsetsOverride`): reserved space grows correctly, pill floats clear of the inset.
4. Desktop: confirms zero dead space is introduced at the page bottom.

**Teeth proven:** reverting `components/FeedbackWidget.tsx` + `FeedbackWidget.module.css` (keeping the branch's other changes) turns tests 1–3 red (title-overlap / spacer-height-zero), confirming the assertions genuinely exercise the fix rather than passing vacuously.
