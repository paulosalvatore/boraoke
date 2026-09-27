# TICKET-111 — Ship the search-measurement instrumentation so the next quota question is answerable in minutes, not by archaeology

**Filed:** 2026-09-27, from the TICKET-108 delivery.
**Priority:** MED — small, and it pays for itself the next time anyone asks "how are we doing on quota?"
**Type:** Observability
**Size:** S

## Why

Two measurements this week — the TICKET-106 spike and the TICKET-108 fix — both had to **reconstruct** figures that should have been directly readable:

- **The cache hit rate had to be derived**, not read: `search_performed` counts minus billed calls, plus a UTC-boundary reconstruction. TICKET-85 specified a `cached: true|false` telemetry flag and it was **never shipped**. It is roughly two lines, and its absence turned both measurements into archaeology.
- **The 40% call reduction is a single evening's number.** TICKET-108's local-narrowing only spends a call when narrowing "starves" (fewer than 3 held rows still match), and the starvation rate was measured at 16 of 48 calls on one dataset. Whether that holds across real venue nights is unknown, and right now unknowable without repeating the whole exercise.

There is also a live decision waiting on exactly this data. TICKET-108 ships ~2.25 billed calls per queued song against a 100/day cap, which at the demonstrated ~24-25 songs/day is roughly 54 of 90 calls. **Whether that is enough headroom is meant to be answered by watching the counter over two real venue nights** — and that observation is much weaker if the only instrument is the aggregate budget counter.

## What's needed

1. **Ship the `cached: true|false` flag** on the search telemetry event (TICKET-85's original spec). This is the item that makes every future cache question a query instead of a reconstruction.
2. **Record the `planSearch` decision reason** — why a call was or wasn't spent (first call for a query family, local narrowing sufficed, narrowing starved). That turns "40% on one evening" into a continuously measured number and shows immediately if the real-world starvation rate diverges from the 16/48 seen in testing.
3. Make the daily picture readable without pulling production credentials to disk — see **TICKET-107** (boraoke has no Credential Vault entry, which is why the last two measurements had to `vercel env pull`).

## Constraints

- Telemetry already exists (`lib/telemetry-store.ts`); extend it rather than adding a parallel mechanism.
- **Do not log the query text** in anything that widens exposure of patron input beyond what is already stored — the existing event hashes the query, and that property must hold.
- The `QueueStore` interface and `lib/store/types.ts` are frozen; this is telemetry, so it should not need either.
- TICKET-108 committed a re-runnable fixture (`npm run measure:t108 -- --controls`) that works with **no credentials**. Keep that property — a measurement that needs secrets gets run once and then never again.

## Acceptance

Cache hit rate and the call/no-call decision mix for a given day are readable from telemetry without deriving them from counter arithmetic, and without pulling any production secret to disk.
