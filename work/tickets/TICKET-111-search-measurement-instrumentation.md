---
ticket: TICKET-111
title: Record the planSearch decision reason in search telemetry
product: boraoke
status: filed
---

# TICKET-111 — Record the `planSearch` decision reason in search telemetry

**Filed:** 2026-09-27, from the TICKET-108 delivery.
**Rescoped:** 2026-10-15 backlog cleanup (`work/cleanup/2026-10-15/LEDGER.md`). This card originally had three items:

- Item 1 (cache/no-cache flag on the search event) shipped in #88 (`c8de70e`): `search_performed` now carries `source: cache | index | live` (`app/api/search/route.ts:170,191,273`).
- Item 3 (read the daily picture without pulling production secrets) belongs to **TICKET-107**, which is blocked on a test YouTube key.

**Priority:** MED. **Size:** S. **Type:** Observability.

## The one open item

Record why a call was or wasn't spent. `planSearch` runs client-side (`components/SongSearch.tsx:223,542`) and decides between first call for a query family, local narrowing sufficed, or narrowing starved (fewer than 3 held rows still match). None of that reason reaches telemetry today. TICKET-108's ~40% call reduction is a single evening's number (starvation 16 of 48 calls on one dataset), and it can't be re-checked over real venue nights without repeating the whole exercise.

## Constraints

- Extend the existing telemetry (`lib/telemetry-store.ts`); no parallel mechanism.
- Do not log the query text. The existing event hashes the query, and that must hold.
- `QueueStore` and `lib/store/types.ts` are frozen; this is telemetry and should not need either.
- Keep `npm run measure:t108 -- --controls` runnable with no credentials.

## Acceptance

The call/no-call decision mix (first call, narrowing sufficed, narrowing starved) for a given day is readable from telemetry without deriving it from counter arithmetic.
