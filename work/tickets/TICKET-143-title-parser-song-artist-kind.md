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

- Hand-labelled sample of 300 index rows: **kind precision >= 95%**. Met (300/300 = 100.0%). The sample is karaoke-heavy, so this is a weak bar (a constant `karaoke` classifier scores 97.3%); on non-karaoke channels kind is 78%.
- **Song+artist exact >= 85%: moved to TICKET-145** (known-artists input). TM decision 2026-10-15. Measured 83.0% (240/289) on the tuning sample and 77.1% (74/96) on the holdout.
- Mutation-proof tests (prove-your-test-can-fail). Dev pass: 23 hand mutants, all killed. The opus Reviewer's separate 11-mutant pass left 3 survivors (a bracket with "by", "with" as featuring, a number-only segment); tests that kill them were added after review, and each was shown to fail on the pre-review parser.
- The labelled sample is YouTube API data: local only, gitignored, never on main. It stays in PR #93's own GitHub history as an accepted leftover, recorded in TICKET-141.
- Nothing about storage or the matcher changes.

## References

- `lib/karaoke-index/matcher.ts`, `lib/karaoke-index/types.ts`, `lib/karaoke-index/channels.json`.
