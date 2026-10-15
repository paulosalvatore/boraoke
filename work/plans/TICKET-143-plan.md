# TICKET-143 plan — title parser

**Status:** dispatched by the boraoke Product TM with the scope below (treated as plan approval; written down for the record).

## Approach

- New pure module `lib/karaoke-index/title-parser.ts`: `parseTitle(title, channelTitle) -> { song, artist, kind }`, plus `classifyKind` and `decodeEntities`. No storage, matcher, tier or route change; nothing imports it yet (TICKET-144 wires it).
- Kind: keyword cues with a fixed priority (karaoke > playback > cover > live > lyric > original), then the channel name, then `- Topic` channels as original.
- Song/artist: strip emoji, hashtags and boilerplate brackets; turn boilerplate word runs into separators; split; drop noise segments; explicit cues ("by", "in the style of"), then per-channel order templates, then generic order cues, default artist-first.
- Templates come only from each channel's other uploads, never from labelled rows.

## Measurement

- Fixture absent and no YouTube key in the vault, so no harvest. Sample source: the gitignored 2026-10-02 production search capture (`work/measurements/ticket-108/production-search-results.json`, present in the t118 worktree), karaoke/playback-named channels only.
- 300 rows hand-labelled before the parser existed (committed, titles + channel titles only). A 100-row holdout labelled after freezing the parser, plus a 100-row non-karaoke kind-only sample (both local only).

## Tests

- `__tests__/karaoke-index-title-parser.test.ts`: unit cases per rule, plus the labelled-sample floor. Mutation pass over every rule (prove-your-test-can-fail).

## Risks

- Labelled titles are YouTube API Data (30-day rule): the sample is capped at 300 rows and must be deleted or re-derived by 2026-11-01.
- Song+artist order is ambiguous without an artist lexicon; the 85% bar may not be reachable from title shape alone.
