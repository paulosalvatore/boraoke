# TICKET-113 — The TV geometry regression test guards only 1080p + the normal state

**Filed:** 2026-09-27, from the TICKET-109 visual gate (PASS-WITH-NOTES follow-up).
**Priority:** LOW-MED — the fix it protects is shipped and verified; this is about keeping it protected.
**Type:** Test coverage
**Size:** S

## Why

TICKET-109 added a geometry assertion to `e2e/tv.spec.ts` — the `tv-chrome` and `tv-powered-by` bounding boxes must not intersect — and it was properly proven to fail against the pre-fix CSS. But the App Tester confirmed by reading the spec that its **coverage is narrower than the bug's blast radius**:

- The file has a single file-scoped `test.use({ viewport: 1920x1080 })`, so the assertion runs at **1080p only**. The overlap was a `vw`-relative layout defect, and the fix was hand-verified at 720p, 1080p and 4K (measured gaps 10.7px / 18.5px / 40px). **CI protects one of those three.**
- The test never enters or waits for the **focus state**, so it covers the normal state only.

The focus-state gap has a subtlety worth writing down rather than leaving for someone to rediscover: in the focus state those two boxes **do** geometrically overlap, and that is currently harmless because the chrome there is measured at `opacity: 0; pointer-events: none`. So a naive "assert they never intersect" test extended to the focus state would **fail on correct code**. Anyone widening this test must assert the harmlessness (invisible and non-interactive) rather than the non-intersection.

## What's needed

- Run the geometry assertion at **720p and 4K** as well as 1080p — a per-test viewport override or a small loop, not a second copy of the spec.
- Add a focus-state assertion that checks the right property: the boxes may overlap **provided** the chrome is `opacity: 0` and `pointer-events: none`. That is the invariant the product actually relies on.

## Constraints

- E2E assertions are class-based web-first polling; **never `waitForTimeout`**.
- Read **`prove-your-test-can-fail`** first. For the resolution sweep, show the assertion failing at 720p and 4K against the pre-TICKET-109 CSS — a sweep that was never proven to catch the original bug at those sizes adds coverage in name only.
- Note the testing friction recorded on TICKET-109: the in-memory queue drains within 1-3s without any browser interaction, which both the Dev and the App Tester hit independently (see TICKET-114).

## Acceptance

The geometry invariant is enforced by CI at all three target resolutions, and the focus state's overlap-but-invisible property is asserted as such, with each new assertion shown capable of failing.
