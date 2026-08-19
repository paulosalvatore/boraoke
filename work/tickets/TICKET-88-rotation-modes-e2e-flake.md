# TICKET-88 — `rotation-modes.spec.ts` e2e flake (and `render-and-links`)

**Filed:** 2026-08-19, interactive TM session (TL present)
**Priority:** MED
**Size:** M
**Type:** Test infrastructure / deflake

## Why this exists

`rotation-modes.spec.ts` fails **roughly 1-in-3** runs against plain **base-commit code** —
proven this session by running it repeatedly against unmodified `main`/base, not assumed from a
single red run. The failing assertion **moves between runs**; it is not the same line failing
every time, which rules out a simple race in one spot and points at the systemic cause instead.

`render-and-links` shows the same class of intermittent failure.

## Root cause (already documented, not newly discovered here)

This is the same defect class TICKET-65 (PR #48, merged) fixed for the TV specs and TICKET-68
filed for `host-controls.spec.ts` / `rotation-modes.spec.ts` specifically: Next.js's dev server
**resets the in-memory store singleton on a route's first compile after a change**. A spec whose
`beforeEach`/warm-up hits a route for the first time in that dev-server lifetime pays a
just-in-time compile, and anything that raced ahead of that compile (or assumed the store's prior
state) sees a reset store — a spurious failure that looks like a product bug but isn't one.

TICKET-68 already proposed the fix for `host-controls.spec.ts` and `rotation-modes.spec.ts`:
adopt the shared warm-up helper + dedicated non-`DEFAULT_ROOM` warm-up room + bounded explicit
timeout pattern TICKET-65 proved out for the TV specs, with the same acceptance bar — **5
consecutive full-suite runs green**, since TICKET-65's own history showed isolated-spec runs do
not surface this class of failure at all.

## Why this is filed again now, not just left to TICKET-68

This session's agents independently re-proved the flake by experiment (not by reading the old
ticket) and reported it "taxing every agent on this product" — every dev/reviewer touching
anything near rotation or admin routes has to first rule out this flake before trusting a red
run, which burns real time and erodes trust in the suite. Recording the experimentally-confirmed
current state (still reproducing, ~1-in-3, moving failure point, base-commit-only) here so the
next driver doesn't have to re-derive it, and so TICKET-68 doesn't quietly go stale as "maybe
fixed by something else since."

## Acceptance criteria

Same bar as TICKET-68 (this ticket supersedes/reinforces it rather than duplicating scope):
shared warm-up helper adopted in `rotation-modes.spec.ts` (and `render-and-links` if the same
root cause is confirmed there — verify before assuming), dedicated warm-up room instead of
`DEFAULT_ROOM`, bounded explicit timeout on the first post-compile assertion, **5 consecutive
full-suite (not isolated-spec) runs green** as the closing proof.
