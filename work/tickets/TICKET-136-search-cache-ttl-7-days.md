---
ticket: TICKET-136
product: boraoke
status: filed
---

# TICKET-136 — Keep non-empty search pages cached for 7 days instead of 12 hours

**Filed:** 2026-10-15, by the boraoke Tech Manager, from `work/plans/SCOPE-search-cache-pagination.md` section 3.
**Priority:** LOW-MEDIUM — 12 h only covers one evening, and busy nights so far have been weeks apart.
**Type:** Search / cache
**Size:** XS–S
**May ship with:** TICKET-135, in one PR.

## What

Non-empty search pages live 12 h in the Upstash L2 cache (`SEARCH_CACHE_TTL_MS`, `lib/search-cache.ts`). A song searched on one night is billed again the next night.

## Change

- Raise `SEARCH_CACHE_TTL_MS` to 7 days. If TICKET-134 has numbers by then, pick the value from its repeat curve instead.
- Hard ceiling: the 30-day API-data retention the index already enforces (`INDEX_MAX_AGE_MS`, `lib/karaoke-index/types.ts`). Never longer.
- Empty pages stay at 10 minutes. Errors stay uncached.
- Check what happens when a video deleted or made non-embeddable after caching is picked from a stale page. The embeddability check runs only on the paste path, so for search picks the TV watchdog (TICKET-41) is the backstop. The Dev confirms that path and notes it in the route header.

## Acceptance

- The TTL constant is changed and covered by a test.
- A guard test asserts the TTL is at most `INDEX_MAX_AGE_MS` (30 days).
- A test covers a cached page-2 cursor that Google no longer accepts: the route fails soft, as today.
- The PR states the Upstash footprint (about 9 KB per page × at most 90 pages a day × 7 days, roughly 5–6 MB, inside the free tier).

## Notes

- Patron-facing: no. Budget/abuse: none.
- Staleness risk: a new upload can be missed for up to 7 days on a cached query. Low for karaoke.

## References

- `work/plans/SCOPE-search-cache-pagination.md` sections 1, 3, 4.
- `lib/search-cache.ts`, `lib/karaoke-index/types.ts`.
