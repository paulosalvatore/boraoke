---
ticket: TICKET-130
product: boraoke
status: filed
---

# TICKET-130 — An empty karaoke index is cached for the full hourly reload interval

**Filed:** 2026-10-15, observed during the karaoke index rollout.
**Priority:** LOW — the index is full now, so nothing is affected today.
**Type:** Bug / resilience
**Size:** S

## What

When the karaoke index loads EMPTY, `lib/karaoke-index/store.ts` caches that empty state for the full hourly reload interval. A failed load, by contrast, retries after 60 seconds.

The effect: after a first fill or a refill of the index, warm instances keep serving no index answers for up to an hour, and searches fall through to billed live search. Observed during the 2026-10-15 rollout and worked around with a redeploy.

## Fix

Treat an empty load like a failed one: short retry (the same 60 s path), not the hourly interval.

## Acceptance

- An empty load schedules the short retry, and the next load after a fill is picked up within that window, with no redeploy.
- A test that fails on the current behaviour (empty load followed by a fill is not seen until the hourly interval) and passes after the fix.
- A non-empty load still reloads hourly.

## References

- `lib/karaoke-index/store.ts` (reload interval and failed-load retry).
