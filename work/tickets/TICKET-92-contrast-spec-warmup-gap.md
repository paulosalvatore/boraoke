# TICKET-92 — `contrast.spec.ts` carries the same latent warm-up gap TICKET-88 just fixed

**Filed:** 2026-08-20, durable-record update (status docs only, no product code touched by this pass)
**Priority:** MED
**Size:** S–M
**Type:** Test infrastructure / deflake (preventive)

## Why this exists

`contrast.spec.ts` sorts **second** in `e2e/` (`advance-auth.spec.ts`, then
`contrast.spec.ts`, then everything else) and runs before `host-controls.spec.ts`,
`moderation.spec.ts`, `rotation-modes.spec.ts`, and `render-and-links.spec.ts` in Playwright's
sorted, single-worker run order. TICKET-88 (PR #68, merged) just root-caused and fixed exactly
this class of bug: a route's **first compile** under `next dev` resets the in-memory store
singleton, so any spec whose warm-up doesn't actually hit a given route first pays that reset
mid-test and fails in a way that looks like a product bug but isn't.

`contrast.spec.ts` has its own `warmUp()` (`e2e/contrast.spec.ts:236`) — a separate warm-up path
from the shared `warmModerationRoutes()` helper TICKET-88 hardened. Whatever routes
`contrast.spec.ts`'s `warmUp()` happens to touch are, by file-sort accident, warmed **before**
any later file needs them — the exact same "one file's warm-up silently protects a sibling file"
shape TICKET-88 found and fixed for `rotation-modes`/`render-and-links` (which were themselves
riding on three *earlier* files' incidental warm-ups). This ticket has not been proven to reproduce
a failure yet — it is filed on the strength of the identical structural gap, not a repro.

## Why this matters now, not just eventually

The bug is currently **masked, not absent**. `contrast.spec.ts` running early and warming
whatever it warms is plausibly doing the same accidental protective work for later specs that the
three files ahead of `rotation-modes` were doing before TICKET-88. The moment file order changes,
`contrast.spec.ts` is renamed, skipped, `.only`'d, or reordered — any of which is a one-line,
easy-to-miss change — whatever it was incidentally warming goes cold again and the same class of
intermittent failure TICKET-88 just closed can reopen in a different file, presenting as a fresh
mystery flake rather than a known, already-solved class.

## Root cause (same as TICKET-88, apply without re-deriving)

Next.js dev server resets the in-memory store singleton on a route's first compile. Any spec that
needs a route warm before its own timing-sensitive assertions must warm it explicitly through the
shared helper — never rely on file-sort order or another spec's side effects to do it.

## Fix

Same pattern TICKET-88 applied: audit which routes `contrast.spec.ts` actually needs warm, warm
them explicitly through the existing shared helper (`warmModerationRoutes()` in `e2e/helpers.ts`,
extended by TICKET-88 to also warm `GET /api/host/session` and `GET /api/queue`) before any
seeding or timing-sensitive assertion in `contrast.spec.ts`, rather than depending on incidental
compile order. Do not invent a second parallel warm-up helper — reuse the one TICKET-88 already
extended.

## Acceptance criteria

- `contrast.spec.ts` warms every route it depends on explicitly, before seeding, through the
  shared helper — not through file-sort luck.
- **5 consecutive full-suite (not isolated-spec) runs green.** Explicitly stated because this
  product has already been burned once by this exact substitution: a deflake fix on this repo
  that was verified only in isolation was later refuted by a full-suite run finding a real branch
  failure a changed-file-only run couldn't see (TICKET-65's round 1). Isolated-spec runs on
  `contrast.spec.ts` alone do **not** satisfy this bar, even if green.
- No timeout inflated or added as a substitute for warming the right route first (TICKET-88's own
  diff had zero timeout changes — same standard applies here).

## Notes

Filed defensively, from reading the ordering mechanism TICKET-88 documented, not from an observed
failure — verify the actual warm-up gap in `contrast.spec.ts` before implementing; the exact
routes it needs warm may differ from `rotation-modes`/`render-and-links`.
