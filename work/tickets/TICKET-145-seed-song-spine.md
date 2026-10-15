---
ticket: TICKET-145
product: boraoke
status: filed
---

# TICKET-145 — Seed the song spine: MusicBrainz, Wikidata, ListenBrainz, plus the KaraFun catalogue

**Filed:** 2026-10-15, by the boraoke Tech Manager, from `work/plans/EPIC-song-catalogue-plan.md` (section (e) and its "Independent verification (2026-10-15)" table). TL decisions 2026-10-15 (Global TM, prompt 022): epic approved, file 141-149 in the plan order after #90 and TICKET-140; patron-facing parts need a TL OK (via the Global TM) before merge.
**Priority:** MEDIUM
**Type:** Offline data script
**Size:** M
**Patron-facing:** no (feeds 144's songs JSON). No YouTube calls.

## What

An offline script that writes the songs JSON and an artist-to-YouTube-channel-ID map.

- **MusicBrainz core** (CC0) for artists, recordings, aliases, country, and **URL relationships** (artist to official YouTube channel; the verifier confirmed these are core data, CC0). API limit 1 req/s/IP with a contactable User-Agent, or use the core dump.
- **Wikidata** (CC0): `P2397` artist to channel ID (476 Brazilian-citizen musicians measured) and `P1651` song to video ID where present (thin for BR).
- **ListenBrainz** for international popularity. Its CC0 wording is UNVERIFIABLE from a primary page (see 141); keep it optional.
- BR-skewed list: artists with country BR plus an international top-N.
- **KaraFun public catalogue CSV, folded into this ticket as a separate, clearly labelled source** (titles and artists only, no IDs; used as "which songs are karaoke-worthy"). TL, verbatim: "I have their authorization, go ahead and use it". The TL holds the authorization and the house has not seen the document (141). Keep whatever attribution the CSV or KaraFun site asks for, and note the source in the README. The site footer says "Without permission, all uses other than home and private use are forbidden", so keep a pointer to the TL's authorization in the README.
- Excludes MusicBrainz supplementary (non-commercial) data, Spotify, Deezer and Last.fm (not allowed).
- CC0 attribution note in the README.

## Acceptance

- Coverage report: percent of the 28 graded replay songs present in the spine.
- Songs JSON contains no YouTube-sourced data.
- KaraFun rows tagged by source so they can be dropped independently.
- **Moved here from TICKET-143 (TM decision 2026-10-15):** feed a known-artists list from the spine into the title parser (`lib/karaoke-index/title-parser.ts`) and reach **song+artist exact >= 85%** on a FRESH sample labelled before any tuning, plus a disjoint holdout (not the 143 sample, which must be gone by 2026-11-01) (143 measured 83.0%, holdout 77.1%; misses are mostly "A - B" titles with no artist-side signal). The 143 sample is local-only (gitignored) and is deleted by 2026-11-01 per the 30-day rule — tracked in TICKET-141.

## References

- `work/plans/EPIC-song-catalogue-plan.md` (b); 141; 144.
