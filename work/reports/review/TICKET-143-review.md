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

---

# Re-review (D-022 opus), head `d4821a1`, 2026-10-15

**Verdict:** REQUEST-CHANGES. The blocking data item is fixed and all 3 earlier survivors are killed. The new review-fix code (the `shortExtra` guard and the number-segment tag hand-back) brings 3 new real-gap survivors and a small regression on titles the pre-review parser read correctly. Under the `prove-your-test-can-fail` severity floor, a SURVIVED-real-gap mutant is blocking. The fix is a few tests plus one guard tweak.

## TM decision recorded (not relitigated)

83.0% song+artist is accepted for this PR. The 85% bar moves to TICKET-145. Reviewed on that basis.

## What I checked (evidence)

- `git pull`: up to date. The worktree HEAD and `origin/ticket/143-title-parser` are both `d4821a1`. The fix commit is `54f723a`.
- **Sample off main: confirmed.** `git ls-tree -r HEAD --name-only | /usr/bin/grep -a 'ticket-143/'` lists only `RESULTS.txt`, `measure.ts` and `score.ts`, so `labelled-sample.json` is not in the tree. The same grep found these 3 files, which is the positive control. `git diff --stat origin/main...HEAD` lists 12 files and the sample is not one of them. The 13 `labelled-sample` hits in the full diff are paths and prose in `.gitignore`, tests, `measure.ts` and reports, not the file itself. `git check-ignore -v` gives `.gitignore:49:/work/measurements/ticket-143/labelled-sample.json`.
- **Skip and exit 2: confirmed.** With the sample moved aside, targeted jest gave `Tests: 3 skipped, 39 passed, 42 total` and `npm run measure:t143` gave `measure exit=2` with the regenerate note. The sample was then restored. With the sample present, jest gave `Tests: 42 passed, 42 total` and measure gave `300/300 = 100.0%` for kind and `240/289 = 83.0%` for song+artist. The 240 floor holds.
- **test.failing cases are honest.** On the new parser, `classifyKind("Paul McCartney - Live and Let Die (Official Video)", "Some Channel")` returns `live`. `parseTitle` returns song `Paul McCartney` and artist `Live and Let Die`. Both bodies fail for the stated reason, so `test.failing` passes for the right reason.
- **TICKET-141 record:** line 36 of the main-checkout file has the dated 2026-11-01 deletion and the accepted `refs/pull/93/head` leftover. The record exists, but see tracking item T1.

## Mutation table (re-run by me on `d4821a1`, sample present, targeted jest)

| Mutant | Result |
|---|---|
| R6 bracket noise no longer matches "by" | KILLED (1 failed) |
| R6b `(by X)` cue removed | KILLED (1) |
| R10 FEAT_RE without `with` | KILLED (1) |
| R10b `with the` lookahead removed | KILLED (1) |
| R11 number segment never dropped | KILLED (1) |
| R11b number never restored | KILLED (1) |
| N1 `keepNumeric` `< 2` to `< 3` | KILLED (1) |
| N2 a dropped number no longer hands its tag back | **SURVIVED, real gap** (42 passed). `Signos - 01 (Karaoke) - Soda Stereo`: real Signos / Soda Stereo, mutant Soda Stereo / Signos. The same happens with `Hold My Hand - 03 (Karaoke Version) - Hootie and the Blowfish`. |
| N3 `shortExtra` guard removed | KILLED (1) |
| N4 `shortExtra` word cap 4 to 100 | **SURVIVED, real gap** (42 passed). `Hello by Adele (Recorded At The Royal Albert Hall)`: real Hello / Adele, mutant `Hello by Adele` / null. |
| N5 `shortExtra` reads the first extra, not the last | **SURVIVED, real gap** (42 passed). This needs two non-noise extras that fall on different sides of the cap, e.g. `Hello by Adele (Recorded At The Royal Albert Hall) (Acoustic)`. |

The dev report says "a tag after a dropped number still marks the part before it, as before". That claim is right, but no test checks it, which is why N2 survives.

## Regression introduced by the `shortExtra` guard

I diffed the pre-review parser (`0a79677`) against the new one. Both regressions below come from the `shortExtra` guard:

- `Hello by Adele (feat. Drake)` was Hello / Adele and is now `Hello by Adele` / null.
- `Hello by Adele (Acoustic)` was Hello / Adele and is now `Hello by Adele` / `Acoustic`. The same happens with `(Acoustic Cover)`.

Any short bracket that is not recognised as noise now blocks the "X by Y" split. A featuring bracket is the clearest case. Brackets that are recognised as noise, such as (Live), (Cover), (Remix), (Lyrics), (Male Key), (Female Version) and (2015 Remaster), still split correctly. None of these titles is in the sample, so the sample score did not move.

## Items

### Blocking

1. **Kill N2.** Add a case such as `Signos - 01 (Karaoke) - Soda Stereo` and expect Signos / Soda Stereo.
2. **Narrow the `shortExtra` guard and kill N4 and N5.** At minimum, a featuring bracket must not count as the credit, for example with `!HAS_FEAT_RE.test(extra)`. Better, only count a bracket that looks like a name. Then add these tests:
   - `Hello by Adele (feat. Drake)` gives Hello / Adele.
   - A bracket of 5 or more words still splits, which kills N4.
   - A two-extra case kills N5, or the rule moves to "any extra" and the comment says so.
   - `Hello by Adele (Acoustic)` is fixed, or it is pinned as `test.failing` for TICKET-145.
3. **Refresh the copy after the fix.** The PR body says "3 more mutants on the new rules, 6/6 killed", and that stays true for those six. Add N2, N4 and N5, and re-run the pre-review reverse check for the new tests.

### Non-blocking

- `Hello (By Request) Karaoke` gives artist `Request`, because any bracket that starts with "by" now counts as a credit. This is rare. Note it for TICKET-145.
- `22 - Taylor Swift (Karaoke Version)` now gives song `Taylor Swift` and artist `22`. Before the fix it gave song `Taylor Swift` and artist null. The swap comes from the existing default order, which TICKET-145 already covers. The number-segment change is otherwise an improvement: `Arctic Monkeys - 505` and `Blink-182 - 22` are now right.

### Tracking (TM, main checkout)

- T1: the TICKET-141 record from earlier item 2 is written but still **untracked** (`?? work/tickets/TICKET-141-...`), along with 140 and 142 to 149. It is not durable until it is committed. The untracked `work/tickets/TICKET-143-...md` in the main checkout will also block `git pull` after this PR merges, because an untracked file would be overwritten. Commit or remove it first.

Triggered mutation pass: not strictly triggered (YouTube titles, not money, quantity or identity). It was run anyway, and the table is above.

## Gates still open (TM)

- Cyber Security PASS: absent.
- App Tester: no `app-tester-waived` row is recorded yet. The diff touches no UI. The PR body says "App Tester N/A: no UI".
- `verify-green-local` and the full jest suite: not run (host load about 240). Only targeted jest was run.

# Re-review r3 (D-022 opus), head `db7f98c`, 2026-10-15

**Verdict:** REQUEST-CHANGES, tests only. Every round-2 item and Cyber M1 is fixed, and the code is right on every input I probed. My own mutation pass on the new `looksLikeName()` guard leaves 3 real-gap survivors: two at the "at most four words" boundary that the docstring states, and one on the punctuation-only-word clause. Under the `prove-your-test-can-fail` severity floor that is blocking. No code change is needed, only three test cases.

Part of this is on me. In round 2 I asked for "a bracket of 5 or more words", and a 6-word case meets that wording without pinning the boundary.

## TM decision recorded (not relitigated)

83.0% song+artist is accepted for this PR. The 85% bar moves to TICKET-145.

## What I checked (evidence)

- `git pull`: up to date. HEAD is `db7f98c`, and the fix commit is `ebf7789`.
- Baseline, sample present: targeted jest `Tests: 50 passed, 50 total`. `npm run measure:t143` gives `kind precision (strict, all rows): 300/300 = 100.0%` and `song+artist exact: 240/289 = 83.0%`. The 240 floor holds.
- Reverse check, reproduced. I swapped in the `228205a` parser and got `Tests: 5 failed, 45 passed, 50 total`. The 5 failures are feat, descriptor, two-bracket, the channel-cap timing test (1497 ms) and the cap-behaviour test, which matches the dev report. I then restored the parser, and `git status` was clean.
- The diff matches the dev report and the PR body. Round-2 item 3 (refresh the copy) is done.

## Round-2 items and Cyber M1

| Item | Status |
|---|---|
| 1. Kill N2 (dropped number hands its tag back) | **Done.** The `Signos - 01 (Karaoke) - Soda Stereo` test kills it. |
| 2. Narrow the guard: feat no longer blocks the split | **Done.** `looksLikeName()` rejects `HAS_FEAT_RE`, and N6 is killed. |
| 2. `(Acoustic)` / `(Acoustic Cover)` | **Done**, and fixed in code rather than pinned. N7 and N7b are killed. |
| 2. Kill N4 (word cap 4 to 100) | **Done.** The 6-word case kills it. The boundary survives; see below. |
| 2. Kill N5 (first extra instead of last) | **Done.** N5 and N5b ("any extra") are killed by the two-bracket test. |
| 3. Refresh the copy | **Done.** The PR body and dev report list N2, N4 and N5 and the 10-mutant table. |
| Cyber M1: cap the channel title before any regex | **Done.** Both inputs are capped at the top of `parseTitle`. C1 (cap removed) is killed by both new tests. C4 (title cap removed) and C5 (cap 200 to 100) are killed. |

## Mutation table (mine, `db7f98c`, sample present, targeted jest + measure for every mutant)

| Mutant | Jest | Measure (song+artist) | Result |
|---|---|---|---|
| N2 the dropped number's tag is not handed back | 1 failed | 240 | KILLED |
| N4 word cap 4 to 100 | 1 failed | 240 | KILLED |
| **N4b word cap 4 to 5** | 50 passed | 240 | **SURVIVED, real gap.** `Hello by Adele (Live At Madison Square Garden)`: real Hello / Adele, mutant `Hello by Adele` / null. |
| **N4c word cap 4 to 3** (the `>` to `>=` flip) | 50 passed | 240 | **SURVIVED, real gap.** `Stand by Me (Florence And The Machine) Karaoke`: real `Stand by Me` / `Florence And The Machine`, mutant `Stand` / `Me`. The same happens with `(Earth Wind And Fire)`. |
| N5 reads the first extra | 1 failed | 240 | KILLED |
| N5b reads any extra | 1 failed | 240 | KILLED |
| N6 featuring check removed | 1 failed | 240 | KILLED |
| N7 descriptor words removed | 2 failed | 240 | KILLED |
| N7b noise words removed from `looksLikeName` | 1 failed | 240 | KILLED |
| N7c `every` to `some` | 2 failed | 240 | KILLED |
| **N7d `!lw \|\|` clause dropped** | 50 passed | 240 | **SURVIVED, real gap.** `Hello by Adele (Acoustic - Piano)`: real Hello / Adele, mutant `Hello by Adele` / `Acoustic - Piano`. |
| N8 guard removed (always split) | 2 failed | 240 | KILLED |
| N8b guard always blocks | 4 failed | 240 | KILLED |
| N9 `words.length === 0` check dropped | 50 passed | 240 | SURVIVED, equivalent. With zero words, `every` on `[]` is true, so the function returns false anyway. |
| C1 channel cap removed | 2 failed | 240 | KILLED |
| C2 trim back to `/[.\s]+$/`, cap kept | 50 passed | 240 | SURVIVED, equivalent (see below) |
| C4 title cap removed in `parseTitle` | 1 failed | 240 | KILLED |
| C5 MAX_CHANNEL 200 to 100 | 1 failed | 240 | KILLED |
| C5b MAX_CHANNEL 200 to 205 | 50 passed | 240 | SURVIVED, equivalent in purpose. 200 is a safety bound with no product meaning: any cap above real channel lengths (about 100) and small enough to bound the work does the same job. Not a finding. |
| C6 end scan ignores dots | 1 failed (floor) | **239** | KILLED by the sample floor |
| C7 end scan ignores spaces | 1 failed (floor) | **239** | KILLED by the sample floor |
| C8 end scan removed | 1 failed (floor) | **239** | KILLED by the sample floor |

No mutant pushed `kind` off 300/300. Song+artist dropped below 240 only under the trim mutants C6 to C8, and the floor test caught each of them. The real code is at 240.

### The C2 survivor: acceptable

I accept it as SURVIVED-equivalent:

- **The output is identical.** `channelKey` first runs `.replace(/\s+/g, " ")`, so the only whitespace left is `" "`. The regex and the end scan then both strip the same maximal trailing run of `.`/`" "`.
- **The cost is bounded.** The 200-char cap runs first, so the regex's worst case is about 200²/2 steps, well under a millisecond.
- **The real control is tested.** The cap is what fixes M1, and C1, the old code (my reverse check above, where the timing test fails at 1497 ms) and C5 kill it. The end scan is defence in depth. A test that told the two apart could only be a timing test on input the cap already forbids.

## Items

### Blocking (tests only, no code change)

1. **Pin the upper word-count boundary (kills N4b).** Add a case with a bracket of exactly 5 words that splits: `Hello by Adele (Live At Madison Square Garden)` gives Hello / Adele.
2. **Pin the lower word-count boundary (kills N4c).** Add a case with a 4-word name that blocks the split: `Stand by Me (Florence And The Machine) Karaoke` gives `Stand by Me` / `Florence And The Machine`. This is the case that matters more, because real 4-word band names are common.
3. **Pin the punctuation-only word (kills N7d).** Add `Hello by Adele (Acoustic - Piano)`, which gives Hello / Adele.

Then re-run those three mutants and show each one KILLED, and update the PR body's "0 real gaps" line.

### Non-blocking (for TICKET-145)

- `Hello by Adele (feat.Drake)`, with no space after the dot, gives `Hello by Adele` / `feat.Drake`. `HAS_FEAT_RE` needs whitespace after the marker. This regex already existed and `artistCues` uses it too, so it is not a regression.
- `Hello (By Request) Karaoke` is correctly pinned as `test.failing`.
- optional: on a heavily loaded runner, the `< 200 ms` timing test has headroom. The real code takes about 1 ms, and C1 failed at 396 ms even at a host load of about 165.

Triggered mutation pass: not strictly triggered (YouTube titles, not money, quantity or identity). It was run anyway, and the table is above.

## Gates still open (TM)

- `verify-green-local.sh` and the full jest suite: not run. Host load was about 165, so I ran only targeted jest. Both are owed before merge.
- App Tester: the diff touches no UI. The `app-tester-waived` row is still a TM item.
- Cyber: PASS-WITH-NOTES. M1 is resolved, as verified above. M2 (the sample in branch history) stays a squash-merge-only condition for the TM.
