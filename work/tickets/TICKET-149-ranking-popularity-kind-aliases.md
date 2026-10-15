---
ticket: TICKET-149
product: boraoke
status: filed
---

# TICKET-149 — Ranking: popularity, kind preference, alias and typo help

**Filed:** 2026-10-15, by the boraoke Tech Manager, from `work/plans/EPIC-song-catalogue-plan.md` (section (e) and its "Independent verification (2026-10-15)" table). TL decisions 2026-10-15 (Global TM, prompt 022): epic approved, file 141-149 in the plan order after #90 and TICKET-140; patron-facing parts need a TL OK (via the Global TM) before merge.
**Priority:** LOW–MEDIUM
**Type:** Search / ranking
**Size:** S
**Patron-facing:** yes (result order). **TL OK before merge.** Depends on 144, 137.

## What

Order grouped results by the mode-preferred kind, then our own queue popularity, then specificity. Add artist-name aliases for typo classes ("soda stete"). A hashed videoId on `song_queued` (TICKET-134) can supply the popularity signal; hashes only.

## Acceptance

- hit@1 up on the 142 harness; no rise in false-confident results (<= 3/18).

## References

- `lib/karaoke-index/matcher.ts`, `lib/telemetry-types.ts`, 134, 137, 142, 144.
