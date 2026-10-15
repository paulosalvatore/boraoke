---
ticket: TICKET-137
product: boraoke
status: planned
---

# TICKET-137 — Save every live YouTube result a patron queues into the karaoke catalogue

**Filed:** 2026-10-15, by the boraoke Tech Manager, from `work/plans/SCOPE-search-cache-pagination.md` section 3.
**Revised:** 2026-10-15 — the TL promoted this from "conditional on TICKET-134" to **wanted**.
**Priority:** MEDIUM
**Type:** Search / index
**Size:** M–L
**After:** TICKET-130 (an empty index must not be cached for an hour before this adds rows to it).
**Epic:** will be folded into the song-catalogue epic being planned. The epic is not filed yet.

## What

The free karaoke index (TICKET-124) only knows the harvested channels. When a patron finds a song through live YouTube search and queues it, that knowledge is thrown away: the next patron who looks for the same song, with a different phrasing, a prefix or a typo, pays for another live search. The exact-key search cache (12 h, or 7 d after TICKET-136) only helps with the exact same text.

## Change

- When a song picked from **live** YouTube results is queued, add that row (videoId, title, channel, thumbnail, duration if known) to an "observed" index shard. Dedupe by `videoId` against the existing index.
- Each row is stamped with its fetch time and dropped at 30 days, the same retention rule the index already follows for API-derived data (`lib/karaoke-index/store.ts`, `ki:shard:*`).
- Instances pick the new rows up through the stamps hash on the next reload.
- Optional phase 1 that needs no new storage: answer from a cached sing-mode page whose key is a prefix of the new query, narrowing the rows the way `planSearch` does for a patron's own held page (`lib/search-prefix.ts`).
- Whether to also fold un-picked rows from sing-mode live pages is a design call for the plan. Picked-and-queued rows are the required part.

## Acceptance

- Queue a live-search pick, then search the same song with a different phrasing: it is answered by the free index, 0 billed calls (test).
- Under the 124/125 replay with a "yesterday's queued picks folded" scenario, billed calls per song and hit@10 are reported, and the long-tail false-confident count does not rise above 3/18 at threshold 0.8.
- A row cap (e.g. 20k observed rows), a 30-day retention test, and a test that listen-mode picks follow whatever rule the plan sets.
- Pasted links (TICKET-140) are not folded unless the plan shows how their title is obtained without trusting client text.

## Notes

- Patron-facing: not directly (more free answers).
- Abuse: whoever queues chooses which rows enter a shared index. Moderation (TICKET-44) and the submit rate limit bound it, but the plan needs a per-day cap, and it must take the title from the server's own search result, never from the client's request body (`app/api/queue/route.ts` accepts a client `title` today).
- TICKET-134 is no longer a gate, but it measures what this saves.
- In-process scan cost grows linearly with rows (91 ms at 36k rows per the 106 spike).

## References

- `work/plans/SCOPE-search-cache-pagination.md` sections 3 and 4.
- `lib/karaoke-index/store.ts`, `lib/karaoke-index/tier.ts`, `lib/search-prefix.ts`, `app/api/queue/route.ts`.
