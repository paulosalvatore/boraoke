---
ticket: TICKET-147
product: boraoke
status: filed
---

# TICKET-147 — Originals: harvest official artist channels

**Filed:** 2026-10-15, by the boraoke Tech Manager, from `work/plans/EPIC-song-catalogue-plan.md` (section (e) and its "Independent verification (2026-10-15)" table). TL decisions 2026-10-15 (Global TM, prompt 022): epic approved, file 141-149 in the plan order after #90 and TICKET-140; patron-facing parts need a TL OK (via the Global TM) before merge.
**Priority:** MEDIUM
**Type:** Search / harvest
**Size:** M
**Patron-facing:** yes (listen/dance results come from the catalogue). **TL OK before merge.** Depends on 144, 145.

## What

Use the 145 artist-to-channel map, ranked by popularity and patron picks, to harvest official artist channels (`playlistItems.list` + `videos.list`, no `search.list`). Run a spike first on "Artist - Topic" channels: does the `UU` uploads playlist work, are art tracks embeddable?

## Acceptance

- On the 142 harness: listen/dance billed/song drops, measured; hit@10 for listen/dance reported vs live search alone.
- hit@10 overall does not drop below 89%.
- Topic spike result recorded; if not embeddable, they are excluded.

## References

- `lib/karaoke-index/harvest.ts`, 142, 144, 145.
