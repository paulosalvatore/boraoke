# TICKET-72 — Feedback-widget discoverability tradeoff on mobile (from TICKET-71 F3)

**Status:** OPEN — needs a TL product call, not decided
**Filed:** 2026-08-08, interactive TM session (TL present)
**Priority:** MEDIUM
**Type:** Product/UX tradeoff. Source: TICKET-71's second Reviewer pass, finding F3 (deliberately
deferred there, filed here so it isn't lost to a PR comment thread).

## Why this exists

PR #51 (TICKET-71, merged as `de9e98c`) fixed the mobile feedback pill overlapping queue rows and
the CANTAR button by dropping `position: fixed` on mobile and rendering the pill in normal
document flow, at the true end of the page. That is a geometric guarantee against overlap (2205
checks across 35 rows × 21 scroll positions, 0 overlaps, vs. 68 on `main` before the fix) — but it
trades away the pill's old always-on-screen reachability.

## The tradeoff

On a long queue, a guest now has to scroll all the way to the bottom of the page to find "Enviar
feedback" — the second Reviewer's own 35-row probe measured ~2430px of scroll on a 3274px page to
reach it. The old fixed pill was always one tap away, bug and all. Feedback volume may drop as a
result. This matters more than a typical UX nit because the feedback loop is a **founding product
pillar** (see TICKET-39, "automated feedback loop," demoted to wave-7 in the 2026-07-15 roadmap
sweep but never de-prioritized as a value) — a quiet drop in feedback volume would undercut it
silently, with no error or alert to surface the regression.

## Options to weigh (not decided here)

1. **Accept as-is.** The geometric guarantee is worth more than the reachability cost; ship it and
   watch feedback-submission volume for a real signal before changing anything.
2. **Shrink to an icon-only circle that stays fixed** but is sized/positioned to clear the badge
   column and queue rows it used to overlap — keeps always-on-screen reachability, needs a new
   collision-safe footprint (the TICKET-71 investigation showed a *full-size* fixed pill cannot be
   made collision-free against an unbounded-length queue by geometry alone; a much smaller fixed
   target might have enough margin, but that needs its own proof, not an assumption).
3. **Auto-hide during scroll, reveal at rest** (a scroll-direction or scroll-idle heuristic) —
   keeps the fixed pill's reachability when the guest stops scrolling, without the persistent
   overlap risk while actively scrolling past queue rows.

## Acceptance criteria

Not applicable yet — this ticket is a decision request, not a scoped fix. Once the TL picks a
direction, this file (or its replacement) gets acceptance criteria matching that option.

## Not in scope

Re-opening whether the in-flow fix itself was correct — TICKET-71's geometric-guarantee approach
is settled and merged; this ticket is only about the discoverability cost that approach
introduced.
