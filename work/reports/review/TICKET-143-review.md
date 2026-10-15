# TICKET-143 review: title parser (D-022 opus pass)

**Verdict:** REQUEST-CHANGES. One blocking item (YouTube API data must not reach main). Reviewed head `0a79677`, PR #93, 2026-10-15.

## TM decision recorded (not relitigated)

The TM accepted 83.0% song+artist exact for this PR (measured 240/289; holdout 77.1%). The parser is imported nowhere, and per TICKET-141 parsed fields only aid matching until a non-YouTube source corroborates them. The 85% song+artist bar moves to TICKET-145 (known-artists list from the song spine). Reviewed on that basis.

## What I checked (evidence)

- Diff read locally: `git diff origin/main...origin/ticket/143-title-parser` (11 files). Remote tip `0a79677` equals the worktree HEAD.
- Targeted jest: `npx jest __tests__/karaoke-index-title-parser.test.ts` gave `Tests: 36 passed, 36 total` (host load 322, single run).
- `npm run measure:t143` reproduced `kind 300/300 = 100.0%` and `song+artist exact: 240/289 = 83.0%`.
- Runtime leak: `/usr/bin/grep -arln "title-parser" lib app components scripts packages __tests__ work`. The only importers are the test, `score.ts` and `measure.ts`. Positive control: the same grep for `karaoke-index/matcher` finds `lib/search-prefix.ts` and two tests.
- Independent mutation pass: 11 hand mutants, 8 KILLED and 3 SURVIVED. See the table below.
- Compliance precedent: `.gitignore` lines 41-46 and PR #92 (`17d53f2`, same day). Main is squash-merged (no merge commits on `origin/main`).

## Mutation table (mine, separate from the dev's 23)

| Mutant | Result | Exposing input |
|---|---|---|
| R1 drop the all-caps song-first rule | KILLED (2 failed) | |
| R2 drop the lowercase-start penalty | KILLED (1) | |
| R3 drop the `&` artist cue | KILLED (1) | |
| R4 drop the backward modifier extension | KILLED (1) | |
| R5 entity `code > 0` to `>= 0` | KILLED (1) | |
| R6 a bracket with "by" is no longer noise | **SURVIVED, real gap** (sample also unchanged, 240/289) | `Hello (by Adele) Karaoke` gives artist `null` today |
| R7 ignore `aTagged` | KILLED (2) | |
| R8 extras word cap 4 to 8 | KILLED (2) | |
| R9 Topic channel not original | KILLED (2) | |
| R10 FEAT_RE without `with` | **SURVIVED, real gap** (sample unchanged) | `Hootie with the Blowfish - Hold My Hand (Karaoke)` gives artist `Hootie` today |
| R11 drop the all-digits segment noise | **SURVIVED, real gap** (sample unchanged) | a lone number segment, e.g. `Song - 12 - Artist` |

Triggered mutation pass: not strictly triggered (this parses YouTube titles, not money, quantity or identity input). It was run anyway. The survivors are low severity because nothing imports the parser.

## Items

### Blocking

1. **Keep the labelled sample out of main.** `work/measurements/ticket-143/labelled-sample.json` holds 300 YouTube titles plus labels derived from them. That is API Data under III.E.4. The house rule since #92 (same day) says "YouTube API data: local only, never committed" (`.gitignore`). Once it is on main, "delete by 2026-11-01" leaves it in history, and only a rewrite could remove it. Main is squash-merged, so the fix is cheap and complete for main:
   - Add `/work/measurements/ticket-143/labelled-sample.json` to the `.gitignore` YouTube block and `git rm --cached` it on the branch.
   - Make the `labelled sample` describe block skip when the file is absent. The precedent is `existsSync` in `__tests__/search-prefix.test.ts`.
   - Make `measure.ts` exit 2 with a "regenerate locally" note when the file is absent, as the 108/124 replays do.
   - Residual: GitHub keeps the blob under `refs/pull/93/head`. Record that in TICKET-141 as an accepted residual (private repo), or ask GitHub support to purge it.

### Tracking (the answer to "is the 2026-11-01 deletion durable?")

2. **Not durable today.** The deletion deadline lives only in the TICKET-145 acceptance, and TICKET-141 through 149 are untracked (`??`) in the main checkout. TICKET-145 also contradicts itself: it asks to reach 85% "on the 143 labelled sample", which must be gone by 11-01, probably before 145 lands. Where it should go:
   - Commit the 141-149 ticket files.
   - Add a dated line to TICKET-141 "House mitigations": "143 samples (labelled-sample.json, the holdout and the non-karaoke sample, all local) deleted or re-derived by 2026-11-01". Also add it as a dated item in the `## CURRENT STATE` of `work/status/MANAGER-LOG.md`, so a resume sees it. Do not leave it as a clause inside an M-size feature ticket.
   - In TICKET-145, measure the 85% bar on a freshly derived sample labelled before any tuning (plus a holdout), not on the 143 file.

### Non-blocking

3. **Behaviour cases for 145/144** (none ship, since nothing imports the parser). Probe outputs:
   - `Stand by Me (Ben E. King) Karaoke` gives song `Stand` and artist `Me`. The single-segment "X by Y" cue splits song titles that contain "by".
   - `Paul McCartney - Live and Let Die (Official Video)` gives the song and artist swapped and kind `live`. The duo-credit cue fires on "Live and Let Die", and `LIVE_RE` matches a song word.
   - The R6 and R10 cases from the table above.
4. **Kind ≥95% says little on this sample.** A constant `karaoke` classifier scores 292/300 = 97.3% and passes the sample assertion (the unit tests do kill it). The informative kind number is the non-karaoke sample's 78%. Cite that when 144/137 wire the parser.
5. **Holdout methodology.** The design is sound: separate seed, disjoint from the 300, labelled after freeze, sha recorded. Two limits apply. It cannot be reproduced, because the file is not in any repo path. Templates were read off "other uploads", but the holdout excluded only the 300, so overlap between template-source rows and holdout rows cannot be ruled out. Any overlap would inflate the holdout, so 77.1% is an upper bound. 83.0% is a training-set figure. The regression floor (≥240 hits) is the right guard against a silent regression on a tuned set, but after item 1 it runs locally only. That is acceptable for a module nothing imports.
6. **Code quality.** Good: pure, never throws, bounded input, documented rules, and templates sourced away from labelled rows. Optional: `fold` is exported but used only internally.
7. **Runtime:** no leak. `tsconfig` `**/*.ts` type-checks `work/measurements/ticket-143/*.ts` during build, the same as the existing 108/124 replays. Nothing is bundled.
8. **PR body.** The numbers are accurate (reproduced). It needs the TM decision. The claim of a mutation pass "over every rule" is overstated (see R6, R10, R11).

## Gates still open (TM)

- Cyber Security PASS: absent.
- App Tester: no recorded `app-tester-waived` row. The diff touches no UI.
- `verify-green-local` and the full jest suite plus `next build`: not run (host load).
