# TICKET-121 — 17 of 20 e2e spec files share one `default` room, which blocks parallel test execution

**Filed:** 2026-09-28, from the TICKET-116 work. The coupling is **pre-existing**; TICKET-116 only made it visible.
**Priority:** MED — nothing is broken today, but it is the last thing standing between us and a ~2x faster suite.
**Type:** Test architecture
**Size:** M

## What

`playwright.config.ts` pins `workers: 1`. Its old comment said this existed to work around the dev server's in-memory store being wiped between files. **That cause is now gone** (TICKET-116 moved the suite to a production build with `globalThis`-pinned singletons), but `workers: 1` had to stay, because a **second cause underneath it** was exposed:

**17 of the 20 spec files touch the same shared `default` room.** Running them concurrently means they contend for one piece of shared state.

Measured on the TICKET-116 branch:

| workers | clean runs | wall clock |
|---|---|---|
| **1** | **5 of 5** | 3m54s–4m07s |
| 2 | **0 of 4** | 2m38s–2m44s |
| 4 | **0 of 4** | 2m01s–2m25s |

`workers: 2` is the decisive arm: **the same test failed on all four runs** (`tv-watchdog.spec.ts:180`), including at the lowest load of the series. That is a parallel-safety defect, not contention noise.

## Why it is worth fixing

**The prize is roughly halving the suite** — `workers: 2` ran in ~2m40s against ~4m00s serial, and the box has 10 cores. On a suite run repeatedly during gate rounds, that compounds.

There is a second, subtler reason. **The dev server was *hiding* this coupling** by wiping the store between files: every spec got a clean slate by accident, so nothing ever forced specs to own their state. That is the same shape as the defects TICKET-116 catalogued — an environmental artefact masking a real design issue — and it will keep costing until the specs are independent.

## What's needed

Give each spec file its **own room** rather than sharing `default`:

- The room-creation path already exists and is used by several specs (`createRoomWithLanguage` and friends in `e2e/helpers.ts`), so this is mostly mechanical.
- Identify which specs genuinely *need* the `default` room — the host-auth path treats `default` specially (`lib/host-auth.ts` resolves its secret from `HOST_TOKEN`), so some may. Those can stay serialised via a Playwright project or `describe.serial`.
- Then lift `workers` and **prove determinism across several runs**, not one.

## Constraints

- Read **`prove-your-test-can-fail`**: a spec moved to its own room must still fail when the behaviour it covers breaks. Moving a test to fresh state can accidentally make it vacuous.
- **Do not lift `workers` before the rooms are independent.** The measurement above shows exactly what that produces.
- Keep `e2e/_canary.spec.ts` working — it is the harness canary and must remain trivially passing, since its failure is the signal that a run is void.
- Note the `default` room's special host-auth handling before assuming every spec can be moved.

## Acceptance

Specs no longer contend for one room; `workers` is lifted above 1 with determinism shown across several runs; the wall-clock improvement is reported as a measurement.
