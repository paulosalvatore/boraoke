---
ticket: TICKET-143
product: boraoke
status: in_progress
---

# TICKET-143 — Title parser: song, artist, kind

**Filed:** 2026-10-15, by the boraoke Tech Manager, from `work/plans/EPIC-song-catalogue-plan.md` (section (e) and its "Independent verification (2026-10-15)" table). TL decisions 2026-10-15 (Global TM, prompt 022): epic approved, file 141-149 in the plan order after #90 and TICKET-140; patron-facing parts need a TL OK (via the Global TM) before merge.
**Priority:** MEDIUM
**Type:** Search / pure function
**Size:** S–M
**Patron-facing:** no. No storage change.

## What

A pure function over `(title, channelTitle)` that extracts `song`, `artist` and `kind` with `kind` in `{karaoke, playback, original, lyric, live, cover, unknown}`. Per-channel templates are allowed. Index rows today hold only the raw YouTube title and `artist` appears nowhere in `lib/` or `app/`.

Per 141, a parsed song only becomes a permanent song entity when a non-YouTube source or a patron's typing corroborates it. The parser itself stores nothing.

## Acceptance

- Hand-labelled sample of 300 index rows: **kind precision >= 95%**, **song+artist exact >= 85%**.
- Mutation-proof tests (prove-your-test-can-fail).
- Nothing about storage or the matcher changes.

## References

- `lib/karaoke-index/matcher.ts`, `lib/karaoke-index/types.ts`, `lib/karaoke-index/channels.json`.
