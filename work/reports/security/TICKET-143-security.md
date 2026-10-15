# TICKET-143 security gate (D-011, light) — PR #93

**Verdict: PASS-WITH-NOTES** (no BLOCKER/HIGH). Audited head d4821a1 (branch tip now 81a63fb, review-only commits on top). Scope: `git diff origin/main...HEAD`, focused on ReDoS, no-throw, data compliance, runtime importers.

**CI caveat (S1):** `verify-green-local.sh` was NOT run (light gate, host load extreme, no builds). Neither the Dev nor the Reviewer ran it either. The TM must run it before merge; this verdict covers security only.

## Findings

### M1 (MEDIUM) quadratic regex on uncapped `channelTitle`
- Location: `lib/karaoke-index/title-parser.ts` `channelKey()` (line ~243): `.replace(/\s+/g, " ").replace(/[.\s]+$/, "")`. `MAX_TITLE = 300` (line 62) is applied only to the title (line 335, inside `segment`). `channelTitle` is never length-capped, and `parseTitle` also runs `decodeEntities` + `classifyKind` on the full uncapped title before the cap (linear, harmless: 1M chars = about 12 ms).
- Repro: `parseTitle("a - b", ". ".repeat(n/2) + "x")`. Isolated: the `[.\s]+$` replace alone shows 4x time per doubling (4000 chars 217 ms, 8000 chars 875 ms, 16000 chars 2.4 s). Through `parseTitle` (host load heavy): 10k chars 3.1 s, 20k 8.1 s, 40k 23.8 s, 80k 61 s. Same shape with ` .` and ` .`.
- Impact: real YouTube channel titles are at most about 100 chars (where this costs well under 1 ms), so there is no exploit path with API-sourced data today. It becomes a DoS vector only if TICKET-144/145 feed channel titles from a source not bounded by YouTube. Not exploitable now, hence MEDIUM, not blocking.
- Remediation direction: apply the same length cap to `channelTitle` (and to the title before `decodeEntities`/`classifyKind`) at the top of `parseTitle`, so the cap precedes every regex; optionally replace the `[.\s]+$` trim with a manual end-scan. Add a test with a 20k `". "` channel.

### M2 (MEDIUM/LOW) labelled sample is in PR branch history
- `work/measurements/ticket-143/labelled-sample.json` (300 YouTube titles and channel titles, YouTube API data under 30-day retention, captured 2026-10-02, delete by 2026-11-01) was ADDED in b1c6a49 and DELETED in 54f723a. It is gitignored now (`.gitignore:49`, verified with `git check-ignore -v`) and absent from the tip tree (`git ls-tree -r HEAD`) and from the net diff (`git diff --stat origin/main...HEAD` has no entry). But it remains in the pushed branch history (`origin/ticket/143-title-parser`) and PR refs.
- Impact: private repo, no videoIds, inside the retention window, so exposure is small. It matters only if the PR is merged with a merge commit (history would land on main).
- Remediation direction: merge with squash only, delete the branch after merge; and/or the Dev rewrites the branch history to drop b1c6a49's copy (TM call). Delete the local file by 2026-11-01 as already documented.

### L1 (LOW) timing numbers are load-noisy
Single-shot outliers up to 85 to 305 ms on 100 to 440 char inputs did not reproduce (re-run of the 305 ms case: 0.99 ms); host load was extreme. No input of 300 chars or less showed super-linear behaviour in the title path.

## 1. ReDoS
- Static pass over every regex (about 45): no nested quantifiers or overlapping alternations under a quantifier. The title path is bounded by the 300-char cap before `segment`'s regexes (`slice(0, MAX_TITLE)` at line 335), so even O(n^2) shapes (`FEAT_RE` `\s*` runs, bracket-group strippers) stay at 300^2. Title scaling confirmed flat: 1k, 10k, 100k, 1M-char adversarial titles cost 0 to 6 ms (45 ms for 1M `"(a "`).
- Probed about 40 adversarial shapes at 100k chars in title, channel and both positions (separator runs, spaces, tabs, nbsp, unclosed and nested brackets, 【】, emoji, combining marks, ZWJ, NUL, entities, `&`+letters, `&#`+digits, feat/by/style chains, hashtags, colons, dots) plus 20k random short fuzz strings.
- Worst case (title path, capped): below 1 ms steady, 1 to 2 ms with GC noise. Worst case overall: the channel path above (M1).
- Other channel-path shapes are linear: 1M-char channel = 0.5 to 1.7 s (`" - "`, `"A "`, `"a: "`, `"feat "`), i.e. about 1 us per char.

## 2. No exceptions
- `parseTitle` coerces non-strings to `""` (lines 471 to 472). Verified no throw for null, undefined, 0, `{}`, `[]`, Symbol, BigInt, boolean, function (both args).
- No throw on 100k-char NUL, lone combining marks, ZWJ, astral emoji, huge numeric entities (`&#99999999999;` is left unchanged by the range check), `&#x110000;`, unpaired surrogates not tested but `String.fromCodePoint` is range-guarded (code > 0 and <= 0x10ffff; lone-surrogate code points are valid input to it).
- 20k random fuzz strings: zero throws.

## 3. Data compliance
- Tip tree: `git ls-files work/measurements/ticket-143` = RESULTS.txt, measure.ts, score.ts only. No `labelled-sample.json`, no other `.json` in the diff other than `package.json`.
- Net diff: no API data. `grep` for API keys, googleapis, videoId in the branch's new files: none.
- `.gitignore` rule `/work/measurements/ticket-143/labelled-sample.json` is correct and effective. History caveat: see M2.
- RESULTS.txt content is aggregate scores (not reviewed row-by-row for titles beyond a skim; no raw title list expected).

## 4. Runtime importers (proof by absence)
- `grep -rIlE 'title-parser|parseTitle|classifyKind'` over `app/` (44 files), `components/` (18), `scripts/`, `pages/`/`src/` (absent), and `lib/` (44): only hit is `lib/karaoke-index/title-parser.ts` itself (positive control: the scan does see the file). Whole-tree `title-parser` hits: the test file, `work/measurements/ticket-143/{measure,score}.ts`, plans and reports only. `package.json` adds only the `measure:t143` script. The module has no imports of its own. Not reachable from any runtime path today.

## Dependencies / secrets
No new packages. No secrets or credentials in the diff.

## Friction
Pure parsers that take two caller strings tend to cap only the "primary" one; propose a house note: cap every string argument at function entry, before any regex.
