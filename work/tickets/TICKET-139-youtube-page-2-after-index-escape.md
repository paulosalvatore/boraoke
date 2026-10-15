---
ticket: TICKET-139
product: boraoke
status: filed
---

# TICKET-139 — YouTube page 2 is unreachable after "load more" escapes from the free list

**Filed:** 2026-10-15, by the boraoke Tech Manager, from `work/plans/SCOPE-search-cache-pagination.md` section 3.
**Priority:** LOW
**Type:** Bug / search paging
**Size:** XS–S
**Overlaps:** TICKET-138. Fold into 138 if 138 ships first.

## What

The escape from an index answer to live results (`IDXLIVE`) is sent as `page=2`. That uses up the client's `pagesFetched` budget (`MAX_SEARCH_PAGES = 2`), so the live page's real `nextPageToken` (YouTube's page 2) can never be requested. The patron sees "refine your search" after one live page, while a patron who skipped the index gets two (`components/SongSearch.tsx` load-more and the refine hint, `app/api/search/route.ts` page/token agreement checks).

## Change

Count live depth, not taps. The escape is live page 1, so its cursor is allowed as live page 2. The server keeps the cap at 2 billed live pages per query.

## Acceptance

- Index answer, then escape, then a deep page all work.
- Live page 3 is still refused.
- A test that fails on today's code.

## Notes

- Patron-facing: yes (one more page of results). Any copy follows the TICKET-138 copy rule.
- At most one extra billed call per escaped query, and only on a deliberate tap. Matches the non-index path's cap.

## References

- `work/plans/SCOPE-search-cache-pagination.md` sections 2 and 3.
