---
ticket: TICKET-144
product: boraoke
status: filed
---

# TICKET-144 — Catalogue schema v2: songs (ours) plus links (YouTube, 30 days)

**Filed:** 2026-10-15, by the boraoke Tech Manager, from `work/plans/EPIC-song-catalogue-plan.md` (section (e) and its "Independent verification (2026-10-15)" table). TL decisions 2026-10-15 (Global TM, prompt 022): epic approved, file 141-149 in the plan order after #90 and TICKET-140; patron-facing parts need a TL OK (via the Global TM) before merge.
**Priority:** MEDIUM
**Type:** Search / data model
**Size:** M
**Patron-facing:** yes (results grouped per song, original-version links served in listen/dance). **TL OK before merge.** Depends on 143; gated by 142.

## What

- `ChannelShard` v2 rows gain `songId` and `kind`.
- Songs table as build-bundled JSON (our data, no YouTube data in it, no retention clock).
- Matcher indexes `title` plus parsed `song`, `artist` and aliases, and groups links per song (karaoke first in sing mode, original first in listen/dance).
- `decideTier` serves `kind=original` links in non-sing modes.
- **Batched MGET** (`store.ts:119`): ~9 MB would sit near Upstash's 10 MB request limit.
- Per the TL ruling in 141: patrons see our song name and artist; the YouTube side is the embed/link only, never presented as YouTube's metadata.
- Open question to settle here: should the catalogue be asked before the 12 h cached live page on sing/listen first pages (cache shadowing, `app/api/search/route.ts:177-198`)?

## Acceptance

- Retention guard test: no link is served past `INDEX_MAX_AGE_MS`; parsed-only songs expire with their links.
- 142 harness: no regression, plus heap and build-time numbers at ~150k rows (UNVERIFIED today).
- Copy rule below.

## Copy rule (TL, 2026-10-15)

Patron copy must never mention billing, quota, cost, or limits framed as money. Any new or touched string follows it in pt-BR, en and es.

## References

- `lib/karaoke-index/{store,types,matcher,tier}.ts`, `app/api/search/route.ts`, 141, 142, 143.
