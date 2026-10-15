---
ticket: TICKET-138
product: boraoke
status: filed
---

# TICKET-138 — Page the free karaoke list, then roll over into YouTube results on "load more"

**Filed:** 2026-10-15, by the boraoke Tech Manager, from `work/plans/SCOPE-search-cache-pagination.md` section 3.
**Revised:** 2026-10-15 — the TL is fine with an automatic YouTube fallback. The separate "Buscar no YouTube" button requirement is dropped.
**Priority:** MEDIUM
**Type:** Search / UX
**Size:** S–M
**Patron-facing:** yes. **TL OK before merge.**
**Overlaps:** TICKET-139 (the page-2 dead end) and TICKET-128 (silent load-more failure). Fix 139 here if this ships first.

## What

The free karaoke list (index tier) returns at most 16 rows with no cursor (`lib/karaoke-index/tier.ts`). After those rows, "load more" sends `IDXLIVE` as page 2 and the server answers with the live first page (`app/api/search/route.ts`). So a patron never sees free rows past 16, and the escape uses up the only live page-2 slot (TICKET-139).

## Change

- Page the free list with a cursor (e.g. `IDX:<offset>`), answered from the index and never billed, up to a cap (e.g. 48 rows). Index cursor pages go in the free-tier rate bucket (`indexRateLimitOk`) and are allowed on `live=0`.
- When the free list runs out, the next "load more" rolls over into YouTube results without a separate control. This keeps the merge-and-dedupe the client already does.
- Keep TICKET-125's behaviour unchanged: live search fires on Enter or after the idle pause, never per keystroke.
- Count live depth, not taps, so the roll-over is live page 1 and its cursor is still reachable as live page 2 (that is TICKET-139; note the overlap in the PR).

## Copy rule (TL, 2026-10-15)

Patron copy must **never** mention billing, quota, cost, or limits framed as money. The TL: "I dont know what is the paid youtube search." Any new string, and any string this touches, follows that rule in pt-BR, en and es.

Check the existing limit copy against it while here: `dailyLimit` ("Chegamos ao limite de buscas de hoje…", `messages/*.json`) and #90/TICKET-126's `personalLimit` ("As buscas ao vivo de hoje acabaram neste aparelho ou nesta rede…", on `origin/ticket/126-search-limits`). Neither mentions money, but both are "limit" copy, so the TL confirms they pass.

## Acceptance

- Index cursor pages cost 0 billed calls (test).
- Free rows past 16 are reachable through "load more", up to the cap.
- After the free list ends, "load more" brings YouTube rows, deduped against what is shown.
- Live page 3 is still refused. The `MAX_SEARCH_PAGES = 2` billed live pages per query cap holds.
- Copy in all three catalogs, passing the copy rule above.
- The 125 replay shows no rise in billed calls per song.

## References

- `work/plans/SCOPE-search-cache-pagination.md` sections 2 and 3.
- `components/SongSearch.tsx` (load-more), `app/api/search/route.ts` (IDXLIVE escape, page checks), `lib/karaoke-index/tier.ts`, `lib/karaoke-index/matcher.ts`.
