# TICKET-121 — The e2e suite cannot run in parallel because almost every spec shares one room

**Status:** open
**Opened by:** Dev, from TICKET-116's `workers` experiment
**Size:** medium
**Value:** cuts the slowest gate this product has by roughly half

## What

`playwright.config.ts` pins `workers: 1`. TICKET-116 retired the original reason for that pin (in-memory singletons being reset by `next dev` recompiles — gone now that the suite runs a production build with `globalThis`-pinned singletons) and then tested whether the pin could be lifted. It cannot, because of a **second, independent cause** that the build does not touch.

**17 of the 20 spec files touch the single shared `default` room**, and nine of them seed into it (counted in TICKET-116's dev report §3.5). With the store surviving a whole run, those files now contend on one fixture directly. `POST /api/queue/advance` is additionally capped at 12 per room per 60s (`lib/advance-rate-limit.ts`, hardcoded, no env override), a budget several workers drain much faster than one.

## The measurement (TICKET-116, cold full-suite runs, same machine)

| workers | result | wall clock |
|---|---|---|
| 1 | **126/126 on 5 of 5 runs** | 3m54s – 4m07s |
| 2 | 1 failure on **4 of 4** runs | 2m38s – 2m44s |
| 4 | 2–4 failures on **4 of 4** runs | 2m01s – 2m25s |

Under `workers: 2` the failure is **the same test every run** — `e2e/tv-watchdog.spec.ts:180`, the stall ladder's recreate rung, which asserts on the shared room's TV player. Deterministic, not load noise. (`workers: 4` also drives load average past 26 on a 10-core box, so part of its extra damage is self-inflicted saturation — `workers: 2` is the clean signal.)

## Why it is worth doing

The e2e suite is the slowest gate this product has, it runs on every PR, and parallelism is a measured 1.5–2× win sitting behind a fixture problem rather than a real constraint. TICKET-116 bought determinism; this buys the speed back on top of it.

It also removes a latent correctness trap: a suite where most files mutate one shared room is one careless `beforeEach` away from order-dependent tests even at `workers: 1`. TICKET-116 already had to fix two defects of exactly that shape (`drainQueue` unable to clear an over-advanced queue, and `clearCookies` racing the rolling session cookie).

## Proposed approach

Give each spec file its own room instead of raising the worker count — raising it without this just buys flake.

1. Add a helper that creates a per-file room (the suite already creates rooms; `ROOM_CREATE_LIMIT` is already raised for the test process, so the throttle is not in the way).
2. Migrate the sharing files off `default`, leaving only the specs that are genuinely *about* the legacy `default` room (`served-lang.spec.ts` asserts on it deliberately, for instance).
3. Only then raise `workers`, and re-run the same cold distribution to confirm determinism holds — the bar is what TICKET-116 used: several cold runs, all clean, with `work/measurements/ticket-116/cold-run.sh` as the harness.

## Out of scope

Changing the advance rate limit. It is a real anti-grief control; per-room fixtures make the cap a non-issue without weakening it.
