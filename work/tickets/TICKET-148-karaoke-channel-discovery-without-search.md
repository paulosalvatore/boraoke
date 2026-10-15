---
ticket: TICKET-148
product: boraoke
status: filed
---

# TICKET-148 — Karaoke channel discovery without search

**Filed:** 2026-10-15, by the boraoke Tech Manager, from `work/plans/EPIC-song-catalogue-plan.md` (section (e) and its "Independent verification (2026-10-15)" table). TL decisions 2026-10-15 (Global TM, prompt 022): epic approved, file 141-149 in the plan order after #90 and TICKET-140; patron-facing parts need a TL OK (via the Global TM) before merge.
**Priority:** LOW–MEDIUM
**Type:** Search / harvest
**Size:** S
**Patron-facing:** no.

## What

- From 137's patron picks, resolve unseen channel IDs with `videos.list` (1 unit per 50). Promote karaoke/playback-named channels into `lib/karaoke-index/channels.json` via PR.
- Gap audit for the 106 long-tail misses (reggaeton, funk, e.g. "Bandoleros", "Cerol na Mão", "Na Boca da Garrafa", "banderille(ros)", "soda stete").
- Lift `REFRESH_MAX_PAGES` (14, 700 newest uploads) for channels truncated at 700 if 146 allows.

## Acceptance

- New channels listed with evidence of how they were found; no `search.list` calls (`assertNoSearchList()` holds).
- 142 harness: no regression; long-tail misses re-measured.

## References

- TICKET-137, 146, `work/reports/TICKET-106-spike.md`.
