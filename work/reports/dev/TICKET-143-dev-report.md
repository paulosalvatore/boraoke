# TICKET-143 dev report — title parser (song, artist, kind)

**Status (2026-10-15):** implemented; draft PR open. Acceptance is **partly met**: kind precision 100.0% (bar 95%), song+artist exact **83.0%, under the 85% bar**. Needs a TM decision (see the end).

**Worktree:** `.worktrees/t143-title-parser`, branch `ticket/143-title-parser`, from `origin/main` 4d1940e. No app port: pure lib, nothing imports it, no build or e2e run (host was at load ~160-190 and the dispatch said targeted jest only).

## Picking up from

Fresh start. Read the ticket, EPIC plan (a), (e) and the verification table, and TICKET-141 (a parsed song/artist stays YouTube-derived until a non-YouTube source or a patron corroborates it; the parser stores nothing).

## What changed

- `lib/karaoke-index/title-parser.ts` (new, pure): `parseTitle(title, channelTitle) -> { song, artist, kind }`, `classifyKind`, `decodeEntities`, `TITLE_KINDS`. The module header documents the rules. No storage, matcher, tier or route change.
- `__tests__/karaoke-index-title-parser.test.ts` (new): 36 tests. Unit cases per rule, plus the labelled-sample checks (kind >= 95%; song+artist >= 240/289 as a **regression floor**, not the acceptance).
- `work/measurements/ticket-143/`: `labelled-sample.json` (300 rows), `score.ts`, `measure.ts`, `RESULTS.txt`. `npm run measure:t143` added to `package.json`.
- `work/plans/TICKET-143-plan.md`, and the ticket file copied into the branch.

## Sample provenance (read this before trusting the numbers)

- The index fixture (`work/measurements/ticket-124/index-fixture.json.gz`) is absent everywhere on disk. **No YouTube key is held in the vault** (`vault.sh list` has no boraoke/youtube entry; TICKET-124 used a one-off `vercel env pull`). So I did not harvest: no quota spent, `search.list` 0, playlistItems 0.
- Source used instead: the production search capture from 2026-10-02 (`work/measurements/ticket-108/production-search-results.json`, gitignored on main, present in the `t118-session-revocation` worktree), read only. 3,919 rows, 2,925 distinct videos. I kept only rows whose **channel title matches `/karaok|playback/i`**, the same rule that seeded `channels.json` (925 distinct). These are "index-like" rows, not rows confirmed to be in the 71-channel index, because the capture has channel titles but no channel IDs.
- 300 rows: `random.Random(143)`, at most 6 per channel, 174 channels. **Labelled by hand before the parser existed.** 11 rows are marked `skipSongArtist` (non-Latin script, medleys, ambiguous credits). They are scored for kind only.
- Committed: title + channelTitle + labels only (no videoIds). **This is YouTube API Data: delete or re-derive the file by 2026-11-01** (30 days after capture).
- Holdout: 100 more rows (`random.Random(1430)`, at most 3 per channel, excluding the 300), **labelled after the parser was frozen** (sha1 recorded in RESULTS.txt). Kept local and not committed, because of the 300-row cap.
- Secondary: 100 rows from non-karaoke channels (what a live-search pick looks like for 137), labelled for kind only. Also local only.
- Templates: per-channel order templates were read off each channel's **other** captured uploads (outside the 300 and the holdout), never off labelled rows.

## Measured (verbatim, `npm run measure:t143` and the same script on the local samples)

300-row acceptance sample:
```
rows: 300
kind precision (strict, all rows): 300/300 = 100.0%
  predicted karaoke: 292/292 correct
  predicted playback: 8/8 correct
song+artist exact: 240/289 = 83.0%  (song 245/289, artist 244/289; 11 rows marked skipSongArtist)
```
Holdout (frozen parser):
```
rows: 100
kind precision (strict, all rows): 100/100 = 100.0%
  predicted karaoke: 97/97 correct
  predicted playback: 3/3 correct
song+artist exact: 74/96 = 77.1%  (song 76/96, artist 75/96; 4 rows marked skipSongArtist)
```
Secondary, non-karaoke channels, kind only:
```
rows: 100
kind precision (strict, all rows): 78/100 = 78.0%
  predicted unknown: 29/47 correct
  predicted karaoke: 27/28 correct
  predicted live: 4/7 correct
  predicted original: 11/11 correct
  predicted lyric: 4/4 correct
  predicted cover: 1/1 correct
  predicted playback: 2/2 correct
```

"Kind precision" is strict accuracy over all rows (predicted == label). The per-class lines give precision per predicted class. "Song+artist exact" means both fields equal after folding case, diacritics and punctuation.

**Caveat on kind:** the index-like samples are 97% karaoke, so 100% there says little about the other classes. The secondary sample is the real test of `original/lyric/live/cover`. There the classes the parser *predicts* are precise (original 11/11, lyric 4/4), but it falls back to `unknown` often (18 of 47 `unknown` predictions were really original, live or cover).

## Why song+artist is under 85%

Most misses are **order**: "<a> - <b>" with no cue for which side is the artist. Channels disagree, and many appear once. The second class is titles with no separator at all ("Zé Ramalho Chão de Giz Karaokê"). Neither can be solved from title shape alone. Tuning on these 300 rows would only overfit, and the holdout (77.1%) already shows the out-of-sample number is lower. Options for the TM:
1. Accept as-is for 144 (the parsed fields are only a matching aid until corroborated, per 141) and move the 85% bar to after 145.
2. Add an optional known-artists input fed by the TICKET-145 song spine (MusicBrainz/Wikidata artist names). This is the principled fix for the order class.
3. Write templates for all 71 index channels from their own uploads (needs the fixture regenerated, which needs the YouTube key).

## Prove-your-test-can-fail

(a) **Mutation pass:** 23 hand mutants over every rule, each applied to the parser, followed by a run of the suite. Final run: **23/23 KILLED**, e.g. `M1 swap karaoke/playback priority => Tests: 3 failed, 33 passed, 36 total`, `M4 default order flipped => 7 failed`, `M5 templates ignored => 4 failed`, `M16 channel-name segment kept => 1 failed`, `M20 emoji not separator => 1 failed`, `M21 cover before playback => 1 failed`, `M22 lyric before live => 1 failed`. The first pass had 3 real-gap survivors (M16, M21, M22) and one false-equivalent (M20: the spaces around an emoji already form a 2+-space separator). All four got targeted tests and were re-run KILLED. The mutant list is M1-M23 in this report's history. The script lives in the session scratchpad and was not committed.
(b) **Reverse check:** the module does not exist on `origin/main`. With `title-parser.ts` moved aside, the suite fails verbatim: `Test Suites: 1 failed, 1 total` / `Tests: 0 total`. Restored, verified with `cmp`.
(c) Hollowing-out: `no primitive beneath existing assertions changed` (new module, no existing assertion depends on it).
(d) Triggered mutation pass: done anyway (above), though the trigger does not strictly apply: this parses YouTube titles, not money, quantity or identity input.

## Self-verification

- `jest __tests__/karaoke-index-title-parser.test.ts`: `Tests: 36 passed, 36 total`.
- `tsc --noEmit -p .`: no errors in `lib/karaoke-index/title-parser.ts` or `work/measurements/ticket-143/*`. The test file shows only the repo-wide jest-globals noise that every existing test file also shows (e.g. 72 lines for `karaoke-index-matcher.test.ts`).
- Not run: e2e, `next build`, the full jest suite (host load, and the change is a pure lib that nothing imports). `verify-green-local.sh` is the framework's Docker gate. Not run here (host process limit); **the TM/Reviewer should run the product's verify-green before merge**.

## Implementation log

- b1c6a49: parser, tests, labelled sample, scorer, measure script, plan, ticket copy, this report.
- PR: https://github.com/paulosalvatore/boraoke/pull/93 (draft).

## Friction

- No YouTube Data API key in the vault, so any agent that needs the harvest fixture has to pull production env from Vercel by hand. Suggest enrolling it (read-only use, playlistItems/videos.list only).

## Review fixes (2026-10-15, picking up from the opus Reviewer's REQUEST-CHANGES at 0a79677)

Picked up from `work/reports/review/TICKET-143-review.md` and PR comment 6201310862, head 758e78d.

**Blocking item: sample off main.**
- `/work/measurements/ticket-143/labelled-sample.json` added to the `.gitignore` YouTube block (next to #92's rule) and untracked with `git rm --cached`. The local file stays on disk.
- The `labelled sample` describe block skips when the file is absent (`existsSync`, same pattern as `__tests__/search-prefix.test.ts`).
- `measure.ts` exits 2 with a "regenerate locally" note when the file is absent.
- The file remains in PR #93's own GitHub history (`refs/pull/93/head`) as an accepted leftover, recorded in TICKET-141 (its dated 2026-11-01 line in the main checkout).

**Reviewer's surviving mutants: parser fixes + tests.**
- R6 (bracket containing "by"): a bracket that STARTS with "by" is now an explicit credit cue (`Hello (by Adele) Karaoke` -> Hello / Adele). A bracket that only contains "by" (`(Produced by Greg Kurstin)`) stays noise; the test pins both.
- R10 ("with" as featuring): `with` no longer cuts before "the" (`Hootie with the Blowfish` kept whole); `Bebe Rexha with Florida Georgia Line` still cuts to `Bebe Rexha`.
- R11 (number-only segment): a number-only segment is dropped as a track number (`01 - Soda Stereo - Signos`), unless dropping it leaves fewer than two parts, when it is the song (`Arctic Monkeys - 505` -> 505 / Arctic Monkeys; before: song `Arctic Monkeys`, artist null). A tag after a dropped number still marks the part before it, as before.
- `Stand by Me (Ben E. King) Karaoke`: fixed cheaply. The single-segment "X by Y" split is skipped when a short (<= 4 words) bracketed name is present, so it reads Stand by Me / Ben E. King.
- `Paul McCartney - Live and Let Die (Official Video)`: not cheap (the duo-credit cue and `LIVE_RE` both fire on song words). Two `test.failing` cases pin the wrong order and the wrong kind, each with a note pointing to TICKET-145.

**Evidence (verbatim).**
- New tests on the PRE-review parser (`title-parser.ts` from 758e78d swapped in): `Tests: 4 failed, 38 passed, 42 total`, the four failures being the by-bracket, with-the, number-segment and Stand-by tests. The two `test.failing` cases pass there too (the behaviour is wrong on both versions).
- Reviewer's mutants re-applied to the new parser, each `Tests: 1 failed, 41 passed, 42 total`: R6 (no "by" bracket noise), R10 (FEAT_RE without with), R11 (number segment never dropped), R11' (number never restored), R12 (`(by X)` cue removed), R13 (Stand-by guard removed). 6/6 KILLED.
- Targeted jest, sample present: `Tests: 42 passed, 42 total`.
- Targeted jest, sample moved aside: `Tests: 3 skipped, 39 passed, 42 total` (the 33 original unit tests + 4 new + 2 `test.failing`; the 36 in the earlier count included the 3 sample tests).
- `npm run measure:t143`, sample absent: prints the regenerate note, `measure exit=2`.
- `npm run measure:t143`, sample present: unchanged, `kind precision (strict, all rows): 300/300 = 100.0%`, `song+artist exact: 240/289 = 83.0%`.
- `tsc --noEmit -p .`: no errors in `lib/karaoke-index/title-parser.ts` or `work/measurements/ticket-143/*`; the test file shows only the repo-wide jest-globals noise.

**Correction to my earlier mutation claim.** "23 hand mutants over every rule" was overstated: the Reviewer's separate 11-mutant pass left 3 survivors. With the tests above, all 3 are now killed.

**Copy.** TICKET-143 acceptance, `RESULTS.txt` and the PR body now read: kind >= 95% met (weak on a karaoke-heavy sample; non-karaoke kind is 78%); song+artist >= 85% moved to TICKET-145 (TM decision 2026-10-15), measured 83.0% tuning / 77.1% holdout.

**Not run / owed.** No app code touched (the parser is imported only by its test, `score.ts` and `measure.ts`), so `next build` was not run. Full jest: see the line below.
- Full jest suite: **still owed**. Host load at 17:25 was `load averages: 192.46 161.77 165.81`, far above the ~40 threshold; only the targeted file was run.
