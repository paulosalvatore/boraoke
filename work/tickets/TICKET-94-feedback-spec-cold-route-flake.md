# TICKET-94 — `feedback.spec.ts` submits into a never-warmed route, on a 5s timeout

**Filed:** 2026-09-01 (Product TM tab, from an observed failure during the TICKET-93 gate — not a theoretical gap)
**Priority:** MED
**Size:** S
**Type:** Test infrastructure / deflake
**Class:** third instance of the TICKET-88 / TICKET-92 cold-route class

## This one actually fired

Unlike TICKET-92, which was filed on structural grounds without a repro, this was **observed**:
during the TICKET-93 gate, a full Playwright run failed with

```
e2e/feedback.spec.ts:25 › feedback button is present on the patron page and submits in 2 taps
Locator: getByText(/Valeu!/i)  Expected: visible  Timeout: 5000ms  Error: element(s) not found
```

Attribution was checked rather than assumed, because a failure appearing on a branch is not proof
the branch caused it:

- Full suite on **base** `0343328`: **106 passed**, green.
- The failing spec **in isolation** on the branch: green (2 passed).
- Full suite on the **branch**, re-run: **106 passed**, green.
- The branch's changes are a moderation-route condition, a pending-store catch, and a jest-only
  `restoreMocks` setting — no causal path to the feedback widget. Not the cause.

So: a genuine pre-existing flake that fires stochastically under machine load, which happened to
land on this run.

## The structural cause

`grep -rn "api/feedback" e2e/` returns **nothing**. No spec — including this one — ever warms
`/api/feedback` before using it, and `feedback.spec.ts` has no `warmUp()` of any kind. The two-tap
submit is therefore the **first request that route ever receives** under `next dev`, so the route's
cold compile happens *inside* the `toBeVisible({ timeout: 5000 })` assertion on the confirmation
copy. On a loaded machine that compile can exceed 5s, and the test fails on a product path that is
working correctly.

This is the same defect class TICKET-88 root-caused and TICKET-92 closed for `contrast.spec.ts` —
with one difference that makes it slightly worse: those specs were surviving on a *sibling's*
incidental warm-up, whereas `/api/feedback` is warmed by nobody at all, so there is no file-order
accident protecting it.

## Proposed fix

Follow the TICKET-88 standard exactly, and do not invent a parallel mechanism:

- Add the route to the shared warm-up helpers in `e2e/helpers.ts` (a `warmFeedbackRoutes()`
  alongside `warmModerationRoutes()` / `warmTvRoutes()`), and call it at the top of
  `feedback.spec.ts` before the first `goto`.
- Do **not** raise the 5s timeout. Widening the window hides the cold-compile cost instead of
  removing it, and the TICKET-88 standard is explicitly "warm the route, don't touch timeouts."

## Acceptance

- `feedback.spec.ts` warms `/api/feedback` through a shared helper before its first assertion.
- No timeout values changed.
- Full Playwright suite green across consecutive cold runs (the TICKET-92 bar).

## Worth checking in the same pass

Whether any other route is in the same never-warmed-by-anyone position — `grep` each `app/api/*`
route against `e2e/` — so this class is closed by enumeration rather than one instance at a time.

---

# RESOLVED — 2026-09-01, with the class closed by enumeration

## The fix

- `warmFeedbackRoute()` added to `e2e/helpers.ts`, called from a `beforeEach` in `feedback.spec.ts`
  before any assertion. The body is **invalid on purpose**: `/api/feedback` rejects an unknown
  `sentiment` with a 400 *before writing anything*, so the route compiles without planting a junk
  record in the feedback store — the same fire-to-compile posture as the dummy ids in
  `warmModerationRoutes`.
- **No timeout was changed**, per the TICKET-88 standard.

## The class was closed by enumeration, not one instance at a time

The ticket asked for every `app/api/*` route to be checked against `e2e/`. Doing that found **two**
routes referenced by no spec at all:

| Route | Reached from | Status |
|---|---|---|
| `/api/feedback` | `components/feedback/FeedbackSheet.tsx` | the observed flake — fixed here |
| `/api/host/language` | `app/(patron)/[room]/admin/AdminRoom.tsx` | **same latent shape, found by the sweep** |

`/api/host/language` is POSTed by the admin language select and no spec compiles it, so the first
console test to touch that control would have hit exactly this failure. It is now warmed in
`warmModerationRoutes` alongside the other console routes — fixed *before* it ever cost anyone a
debugging session. Every other route is referenced by at least one spec.

## Proven by negative control, not by "it passes now"

Passing in isolation was always true and proves nothing. The reproduction condition is a **cold
`.next`**:

- Warm **disabled** + cold `.next` → **FAILS** with the exact reported error,
  `expect(locator).toBeVisible() failed` on the confirmation copy.
- Warm **enabled** + cold `.next` → **passes**.

That is the flake reproduced on demand and then closed, rather than inferred.

## Gate

- Jest **52 suites / 918 passed**.
- Playwright, the six specs that use the modified `warmModerationRoutes` plus `feedback.spec.ts`:
  **50 tests passed** (`moderation`, `host-controls`, `rotation-modes`, `feedback`, `contrast`,
  `render-and-links`, `feedback-widget-safe-area`).
- **The full 106-test suite was deliberately NOT run**: host load average was 19.5 from other work
  on this machine, and a full run under that load is both slow and prone to producing environment
  failures that read as product failures — precisely the misattribution this ticket is about. The
  change is additive (one extra fire-to-compile POST in a shared helper, one `beforeEach`), and
  every spec touching the modified helper was run. Stated here rather than implied, so nobody reads
  this as a full-suite green.
