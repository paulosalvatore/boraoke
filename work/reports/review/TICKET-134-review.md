# TICKET-134 review (D-022 opus pass)

**PR:** #99 · **Reviewed head:** `18576e3` (`origin/ticket/134-repeat-telemetry`, diff read locally against the merge base with `origin/main`) · **Verdict:** REQUEST-CHANGES (two test gaps, no code defects found)

## What I checked

- Story `work/tickets/TICKET-134-measure-cross-day-search-repeats.md`, the full diff (12 files), the dev report `work/reports/dev/TICKET-134-dev-report.md`. The PR thread had no comments yet.
- Targeted jest, re-run by me: `npx jest __tests__/repeat-hash.test.ts __tests__/repeat-report.test.ts`, 18 passed.
- A 13-mutant pass over the hashing, the report math and the three emit sites (table below).
- Not run: full `npm test`, e2e, local-Docker verify-green. The diff touches only server routes, `lib/` and a script, with no UI import, so I skipped e2e as briefed. Verify-green must be GREEN on the fixed head before the approve.

## Findings

**Key hash is the TICKET-135 fold.** `app/api/search/route.ts:365` hashes `ck`, and `ck = cacheKey(q, SEARCH_DEFAULTS.regionCode, livePageToken)` (line 202) is the same string passed to `getCachedSearchPage` / `setCachedSearchPage` / the single-flight lock. So "same hash" means exactly "same cache entry", including region and the deep-page marker. A deep page therefore gets its own hash, which is consistent with what it bills. Only the live branch hashes. Cache and index hits carry no hash, and the test asserts that. Operator forms (`-karaoke`, `|`, quoted phrase) hash apart from the plain form, which is tested. Accent/case variants (`maná`/`mana`/`MANA`, `Cerol na Mão`/`cerol na mao`) share one hash, which satisfies the acceptance test. M13 (replace the fold) kills 4.

**Privacy.** Raw `q` and the raw `videoId` reach only the HMAC input. The diff adds no log line. The report script prints only `err.message` from env or Upstash failures, never event content. The weekly rollup (`lib/telemetry-rollup.ts`) reads only `kind`/`mode`/`action`/`reason`, so hashes never reach the long-lived rollup records. When the salt is unset or blank, `hashWith` returns `undefined`, the spread adds nothing, and the event is byte-identical to before (tested with `toEqual`). There is no constant fallback (M4 kills 3). Domain separation (`kind\0value`) holds (M2 killed). 16 hex = 64 bits: at 10^5 distinct values the birthday odds are about 3e-10, and reversal by enumerating video ids needs the secret salt, so this is adequate.

**Window math** (`lib/repeat-report.ts`). An event counts as a repeat for window W when the gap to the most recent strictly-earlier occurrence of the same hash is at most W. The boundary is inclusive and tested (M7 killed). The first occurrence counts in the denominator but never in the numerator. Same-millisecond duplicates are not a repeat (M6 killed). Unhashed events stay out of the denominator (M9 killed). The daily split is in UTC (M12 killed). The script is read-only: `lrange` over the day lists, with no write, `del` or `expire`. The math is correct as written. The test does not pin the "most recent" anchor, though (item 1).

**Retention claim verified.** `lib/telemetry-types.ts:94` `TELEMETRY_RETENTION_DAYS = 90`. `lib/telemetry-store.ts:160-164` sets `expire` at the day key's first write (`rpush` returned 1). Hashes live in event `props`, so they age out with the raw event. 90 d covers the 30 d window.

## Mutation table

| # | Mutant | Result |
|---|---|---|
| M1 | search route hashes raw `q`, not `ck` | KILLED (1) |
| M2 | drop `kind\0` domain separation | KILLED (1) |
| M3 | drop the blank-salt `trim()` check | KILLED (1) |
| M4 | constant fallback salt | KILLED (3) |
| M5 | truncate to 8 hex | KILLED (3) |
| M6 | same-instant pair counts as a repeat (`<` to `<=`) | KILLED (1) |
| M7 | window boundary `<=` to `<` | KILLED (1) |
| M8 | anchor the gap to the FIRST occurrence instead of the most recent | **SURVIVED, real gap** |
| M9 | unhashed live events enter the denominator | KILLED (1) |
| M10 | host-approve `song_queued` drops `videoHash` | **SURVIVED, real gap** |
| M11 | queue route hashes a transformed id | KILLED (1) |
| M12 | daily split not by UTC day | KILLED (1) |
| M13 | `cacheKey` fold replaced by trim+lowercase | KILLED (4) |

M8 is not equivalent. For a hash at 0 h, 8 h and 16 h, the correct 12 h count is 2, while first-anchored gives 1. A song sung every few days for weeks would show as "not repeating within 7 d" after its first week. The test named "counts a repeat against the most recent earlier occurrence" does not tell the two apart.

## Required (REQUEST-CHANGES)

1. **Pin the most-recent anchor.** In `__tests__/repeat-report.test.ts`, add a case like `repeatRates([[0,"x"],[8*H,"x"],[16*H,"x"]])` and expect `12h.repeats === 2`. Show it KILLS M8 (change `if (prev === undefined || t > prev) last.set` to `if (prev === undefined) last.set`).
2. **Test the host-approve emit (M10).** This is required. In a moderated room, the approve route is the only place that emits `song_queued`. If the spread is dropped, every moderated song silently becomes "unhashed" and the song repeat rate skews toward non-moderated rooms. The scaffolding already exists in `__tests__/api-moderation.test.ts` (`approve()` helper, `telemetryStore`). The test should, with `TELEMETRY_HASH_SALT` set: turn moderation on, submit a song (pending), approve it, and assert that the latest `song_queued` props `toMatchObject({ kind: "moderated", videoHash: hashVideoId(<id>) })`. Then, with the salt unset, repeat the flow and assert props `toEqual({ kind: "moderated", mode: <mode> })`. Show it KILLS M10.
3. **Dev report correction.** It says `triggered mutation pass: not triggered`. This diff adds a new HMAC/hash function over identity values (query key, videoId), so the pass is triggered. Update the line to reference this table.

## Optional, non-blocking

- Edge truncation: an event early in the `--days` range cannot see an earlier occurrence before the range start, so the 30 d rate is undercounted for roughly the first 30 days of the range. A one-line note in the report output, or counting only events at or after `from + W` per window, would make the numbers safer to quote. The hash series starts empty on salt day anyway, so the effect is the same for the first month.
- After the salt is set in prod, record its set-date with the deploy note, so a reader of the report knows where the windows start.

triggered mutation pass: run, 13 mutants, 11 KILLED, 2 SURVIVED-real-gap (M8, M10).
