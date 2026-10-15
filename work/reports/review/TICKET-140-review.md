# TICKET-140 — Reviewer report (D-022 opus pass)

**PR:** #95 (stacked on #90, base `ticket/126-search-limits`)
**Head reviewed:** `71a6d5e` (local HEAD == `origin/ticket/140-paste-link`)
**Diff:** `git diff origin/ticket/126-search-limits...HEAD` (29 files, +1673/−406)
**Verdict:** REQUEST-CHANGES (3 required items, all small). The design is sound and each gap is fixed at its cause.

## Preconditions

- The App Tester and Cyber Security gates had not reported when this pass ran. An App Tester run appears to be in progress in this worktree: there are uncommitted `tsconfig.json`, `.next-apptest/` and `work/evidence/ticket-140/apptest/` files, which this review did not touch.
- The local-Docker verify-green has not been run.
- This opus pass ran at the TM's request ahead of those gates. Even after the items below are fixed, an APPROVE still needs App Tester PASS, Cyber PASS (which must rule on gap 6) and verify-green GREEN.
- The TL also still has to confirm the gap-5 block. The ticket asks for that explicitly, and the plan records "house default per the TM brief" rather than a TL confirmation.

## What I read

- Ticket: `work/tickets/TICKET-140-paste-link-gaps.md` (on `origin/main`).
- Plan: `work/plans/TICKET-140-plan.md`.
- Dev report: `work/reports/dev/TICKET-140-dev.md`.
- Evidence: `work/evidence/ticket-140/{jest-full,e2e,mutation-pass,reverse-check,build}.txt`.
- The PR body.
- The full diff, read locally.
- Callers and stores the diff did not touch, to rule out field-dropping projections: `lib/rotation.ts` `orderQueue`/`relayQueue` keep the original entry objects, and `lib/store/upstash.ts` stores the whole JSON, so `channelTitle`/`duration` reach `GET /api/queue`, the TV and the host view.

## Cause vs symptom, per gap

| Gap | Fixed at the cause? | Notes |
|---|---|---|
| 1. 11-letter word taken as an id | Yes | `looksLikeBareVideoId`, shared by client and server. See the heuristic ruling below. |
| 2. URL forms | Yes | Exact host sets after `URL` parsing, and exact path segment counts. Look-alike hosts are still refused. Only `youtu`-bearing tokens are read from share text. |
| 3. Title | Yes | Resolved server-side in the same 1-unit `videos.list` call (`part=status,snippet,contentDetails`), with keyless oEmbed as the fallback. One `songLabel` helper feeds the patron view, the host view and the TV. The pending (moderation) entry gets the server title, and mutant Mk (below) confirms a test covers it. |
| 4. Preview | Yes | `GET /api/video-meta` uses the cache plus oEmbed only, so it can never spend Data API units (mutant Mf KILLED). |
| 5. Embeddability | Yes | A definite `not-embeddable` returns 422 before moderation or the queue. Every failure is still fail-open. |
| 6. Client trust | Yes | The check runs on every submit, and `source` is only a telemetry label now. The server title wins, and the client title is used only when every lookup failed. Cyber has to rule on that remaining fallback. |
| 7. Discoverability | Partly | The 429 copy now says to paste a link in all 3 locales. There is no test for it (item 2). No clipboard button was added, which the ticket only said to "consider". |
| 8. Per-instance limit | Left alone, reasoned | The new calls sit after the submit limit and `checkSubmit`, and are cached. TICKET-67 tracks moving the limit cross-instance. |

## Rulings on the TM's questions

**The bare-id heuristic is the right call.** Keep it rather than requiring URL context.
- The share sheet always produces a URL, and URLs never go through the heuristic. Losing about 1 in 6,000 real ids when pasted bare costs almost nothing.
- The misfire in the other direction needs a single 11-character token with a digit or odd casing ("Blink182abc"). That is rare in karaoke queries.
- The ticket explicitly allowed "a stricter check". Going URL-only would remove the residual misfire, but it would also drop a working input form for very little gain.
- One real residual: a misfire auto-selects a video that does not exist, and `videos.list` returning `items: []` comes back `unknown`, so that video is queued (fail-open). The preview already knows it is "missing" (oEmbed 404). That is a cheap follow-up (optional item 6).

**The title path, caching and fallbacks are correct.**
- `lookupForSubmit` reads `ec:` and `vm:` in parallel. On a miss it makes at most one `videos.list` call (only with a key and only on an `ec:` miss), then at most one oEmbed call (only with no title and no cached "missing").
- Both calls have an 800 ms `AbortSignal.timeout`. oEmbed also uses `redirect: "error"`, and both re-validate the id before building the URL.
- A `videos.list` answer about a different id is ignored.
- `cleanMetaText` strips control and bidi characters and caps the length.
- Everything sits inside an outer try/catch that returns `unknown`, so a cache or network fault can never fail a submit.
- The no-key path still never writes `ec:`. That matches the old behaviour, but the TICKET-95 test asserting it was deleted (optional item 7).
- Redundancy: on a miss, `resolveVideoTitle` re-reads `vm:` after `lookupForSubmit` already read it. That costs one extra Redis GET per miss and is harmless.

**1 `videos.list` unit per search pick on a cache miss is acceptable and bounded.**
- It comes from the separate 10k/day pool documented in `lib/youtube-search.ts`. `search.list` is never touched.
- The cost is bounded per distinct video by the 24 h `ec:` cache (10 min for `unknown`), and per request by the submit limit (10 per patron, 60 per IP, per minute, per instance). The call sits after `checkSubmit`.
- This adds no abuse ceiling: before this PR any client could already force the call with `source:"paste"`.
- A night of about 300 distinct songs costs about 300 units.
- Worst-case added submit latency on a full miss is about 1.6 s. That is acceptable.

**The `/api/video-meta` design is good.**
- It is a GET with id validation (400 on a bad id).
- It has a per-IP in-memory bucket of 60 per minute, in the same shape as the other limiters.
- It returns `{}` when no title is known, so the client keeps its placeholder.
- It is display-only, because the submit route resolves the title again on its own.
- One nit: `Cache-Control: private, max-age=600` is also sent on a `{}` caused by a transient oEmbed error. The browser then pins "no title" for 10 minutes, even though the server deliberately does not cache errors (optional item 5).

**The embeddability (422) UX and copy pass in all 3 locales.**
- The copy is friendly and actionable ("Try another version of the song"). It names the owner's restriction, not cost.
- No new or touched string in pt-BR, en or es mentions billing, quota, cost or paid search, so the TL copy rule passes.
- `PatronRoom` shows `err.error` for the 422.

## Mutation pass (reviewer-run, targeted jest: api-queue, api-video-meta, youtube, api-moderation; 146 tests)

| Mutant | Result |
|---|---|
| Ma `fromStored` reads the wrong key (Upstash `vm:` round-trip broken) | **SURVIVED, real gap** |
| Mb oEmbed "missing" only on 404 | KILLED (3) |
| Mc drop the `cachedMeta !== "missing"` guard | SURVIVED, equivalent (`resolveVideoTitle` re-checks the cache) |
| Md upper-case anywhere counts as mixed case | KILLED (4) |
| Me server title overwritten with undefined when there is no meta | KILLED (18) |
| Mf preview endpoint uses the Data API path | KILLED (1) |
| Mg "missing" cached for 24 h instead of 10 min | **SURVIVED, real gap** (L1 and Redis) |
| Mh `videos.list` meta not cached | KILLED (2) |
| Mi hour branch of `formatDuration` dropped | SURVIVED, real gap (display only, minor) |
| Mj `youtu` token filter removed from share text | SURVIVED, equivalent (non-YouTube tokens fail the exact host check anyway) |
| Mk moderated (pending) entry loses the server title | KILLED (1) |

The Dev's own pass (17 mutants on the parser and route, including the reverse-check against `ede63ef`) stands. The parser, the identity path, is well covered.

The gap is the new `vm:` cache module. Unlike `lib/embed-cache.ts`, which has a "redis path" suite, its production (Upstash) path and its TTL rules have no test at all.

## Dev flags

**(a) "A worker process has failed to exit gracefully": not reproduced, and no open handle found in the new code.**
- Targeted runs did not reproduce it: the 4 suites that POST to the queue without mocking `fetch`, plus the 3 new or changed suites, run in-band with `--detectOpenHandles` and twice with `-w 4` (load average about 63–90).
- Every new outbound `fetch` carries an `AbortSignal.timeout`, which is unref'd in Node.
- Probe: three refused `fetch`es to `127.0.0.1:9`, then `process.getActiveResourcesInfo()`, returned `[]` immediately and again 50 ms later.
- The new code holds no timers or intervals, and its Redis client is not created under the memory driver.
- One thing is genuinely new: because of `jest.env.ts` `YOUTUBE_OEMBED_ORIGIN=127.0.0.1:9`, unmocked suites now make real loopback connection attempts, where before they made no network I/O. Each attempt is awaited inside the request, so none outlives a test.
- At a load average of 95–130 a slow worker shutdown is the likelier explanation.
- Optional hardening: have `jest.env.ts` stub `global.fetch` to reject by default instead of using a closed port, so unit suites do no real network I/O at all.
- The TM's post-rebase full jest run is the confirmation. If the warning recurs there, run the full suite with `--detectOpenHandles`.

**(b) A full e2e re-run is not needed for this commit.**
- Both failures were in the new spec's locators (`exact: true`). The other 136 specs passed against the same app code in the same run.
- The 6/6 re-run covered the canary and the whole new spec.
- The required items below change code anyway, and the TM's full suite after the rebase onto main is the run that gates merge. That one must be full and green.

## Required (REQUEST-CHANGES)

1. **Test the `vm:` cache's production path.** Add a "redis path" suite for `lib/video-meta.ts` that mirrors `__tests__/embed-cache.test.ts`. It should cover:
   - the stored round-trip (`t`/`c`/`d`), so that mutant Ma dies;
   - `px` set to 24 h for a found title and 10 min for "missing", in Redis and in L1, so that Mg dies;
   - a malformed stored value read as a miss;
   - a Redis `get`/`set` throw failing open.

   This is the cache every production submit goes through, and today a broken serialization would silently turn every repeat submit into a live oEmbed call.
2. **AC gap: show the paste hint on a 429 and on `error`.** The ticket's acceptance asks for it in every degraded state, "including the 429 rate limit", with e2e. `quota`, `no-api-key`, `daily-limit` and `personal-limit` are already covered in `e2e/search.spec.ts`. The changed `rateLimited` / `searchRateLimited` copy and the `error` reason have no test. Add a spec case for each (mock `/api/search` to return 429, and `{degraded, reason:"error"}`), and assert that the paste hint is visible and that a paste still selects.
3. **Remove the dead `warning` path in `PatronRoom.tsx`.** The server no longer sends `warning`, so the `submitWarning` state, the `submit-warning` element (around `:460`) and its parse (around `:298-302`) are dead code. Also update the stale TICKET-61 comment around `:200-213`: the "FOLLOW-UP: have SongSearch carry an explicit `source`" note is now done by this PR, and "loses one advisory warning" is no longer true.

## Optional (non-blocking)

4. Add an `formatDuration` test with an hours value (`PT1H2M3S` should give `1:02:03`), so that mutant Mi dies.
5. In `/api/video-meta`, send `Cache-Control: no-store` (or a short max-age) when it answers `{}`, so a transient oEmbed error is not pinned in the browser for 10 minutes.
6. Follow-up ticket: treat a definite "no such video" (`videos.list` `items: []` together with an oEmbed 404) as a refusal, or fall back to search in the picker when the preview says it is missing. Either closes the residual heuristic misfire ("Blink182abc") and dead pasted ids.
7. Restore the deleted TICKET-95 assertion that a no-key submit writes nothing to `ec:`.
8. PR body: "Item 7 (per-instance submit limit)" is ticket gap **8**. The rest of the body is accurate against the diff: the stacked base, the gap list, the copy table, the Cyber notes and the quota note.

## PR body accuracy

Accurate, apart from item 8's numbering. The gates checklist correctly shows everything still unchecked.

triggered mutation pass: run (new parsing function on an identity path, the video-id parser). Dev: 17 mutants, all KILLED or SURVIVED-equivalent after an in-PR fix. Reviewer: 11 mutants above, three SURVIVED as real gaps, all in the new cache and display helpers rather than the parser.

---

# Re-review (D-022 opus), head `fb373ed` (code `4ac1870`)

**Verdict: APPROVE.** Every required item, the optional items I raised and the three Cyber findings this round targeted are fixed at the cause, and the new tests fail when the fix is removed. Commits after `fb373ed` (`4039dff`, `f0fb8d9`) touch only the security report and the event log, so this verdict holds at the current head.

Read in a throwaway detached worktree on `origin/ticket/140-paste-link` (`fb373ed`). The shared worktree was not mutated, apart from this report.

## Prior items

| Item | Status | Evidence |
|---|---|---|
| 1. `vm:` cache Redis path | Fixed | `__tests__/video-meta-cache.test.ts`. Dev mutants Ma/Mg killed. My R6 (stored duration dropped) and R8 (stored title not re-cleaned) were also KILLED. |
| 2. Paste hint on 429 and `error` | Fixed | `e2e/search.spec.ts` has 3 new cases, each asserting the hint and that a paste still selects. e2e-reverse shows they fail on the pre-PR copy. Full e2e 141/141 (`r2/e2e-full.txt`). |
| 3. Dead `warning` path | Fixed | `submitWarning`, `submit-warning`, the parse and the stale TICKET-61/FOLLOW-UP comment are all gone. A grep over app/components/lib/e2e/__tests__/messages finds nothing left. |
| opt 4 `formatDuration` hours | Fixed | Mi killed (Dev pass). |
| opt 5 `no-store` on `{}` | Fixed | My R5 (put `max-age=600` back) was KILLED. |
| opt 6 dead/non-existent id | Covered for the title-injection side. A non-existent id with a client title now stores no title (test "a non-existent id ... cannot put client text on the TV"). Refusing the submit outright is still a possible follow-up. Not blocking. |
| opt 7 no-key writes no `ec:` | Restored | Dev mutant killed. |
| opt 8 PR body gap numbering | Fixed | The body now says "Gap 8". |
| Cyber MED-1 | Fixed | The parser returns null over `MAX_PARSE_INPUT` (512) before any regex. `stripSharePunctuation` is a linear index walk. SongSearch has `maxLength={MAX_PARSE_INPUT}`. My R4 (cap removed) was KILLED by the timing test. |
| Cyber LOW-1 | Fixed | The `title:` field is gone from the entry literal. The only client-title path is the gated seam. My R9 (server title skipped) was KILLED (4 tests). |
| Cyber LOW-3 | Fixed | `lib/youtube-server.ts` is `import "server-only"`, and `lib/youtube.ts` keeps only the parser, `isValidVideoId` and the types. Client imports (SongSearch) take only `parseYouTubeVideoId`/`MAX_PARSE_INPUT`. The bundle grep found 0 key strings, with positive controls. |

## Dev decision (a): removing "Título da música"

Correct. Once LOW-1 landed the field could not affect anything in production: the server title wins when a lookup works, and nothing is stored when none does. A form field that silently does nothing is worse than no field. The field and its `songTitleLabel`/`songTitlePlaceholder` keys are removed in all 3 locales, and nothing references them any more. The specs that filled it (moderation, rooms, submit-song, feedback-widget) now identify rows by nickname. The `songTitle` that remains in `lib/song-label.ts`/TvScreen is an unrelated display helper.

Nit, not blocking: `PatronRoom` still sends the picked search result's `title` in the POST body. Production ignores it and it exists only for the seam. It is harmless.

This is a visible form change, so the TM should mention it to the TL (the PR body already states it plainly). App Tester r2 should confirm the form renders cleanly without the field.

## Dev decision (b): `BORAOKE_TEST_CLIENT_TITLES` seam

The gate is airtight for Vercel. `clientTitleFallbackAllowed()` = flag `=== "1"` AND `overrideAllowed()`, and `overrideAllowed()` = `NODE_ENV !== "production"` OR (`BORAOKE_E2E_STUBS === "1"` AND `!VERCEL`).

- A deployed Vercel build always runs with `NODE_ENV=production`, which Next inlines at build time, so the first branch is dead there.
- `VERCEL=1` is a Vercel system env var that is present at runtime, so the second branch is false too.
- Even if both of those failed, the seam would still need two non-standard env vars set on the project. Neither is in `.env.example`, and only `playwright.config.ts` sets them.
- jest does not set the flag, so the unit suites run the production rule.

Mutation proof:
- R1 (drop the `overrideAllowed()` conjunct): KILLED.
- R2 (`overrideAllowed` ignores `VERCEL`): KILLED, 2 tests.
- R3 (seam ignores the flag): KILLED, 2 tests.

The test sets flag + stubs + `NODE_ENV=production` + `VERCEL=1` and asserts no title, then restores the env in `finally`.

The only residual is a self-hosted (non-Vercel) production deployment that deliberately sets both flags. That is acceptable, and it is the same posture as the existing origin overrides.

## Main-merge resolution (`2221dc5`)

Correct.
- `git diff a0f2b59 HEAD` over #90's files (`lib/search-budget.ts`, `.env.example`, `__tests__/api-search-personal-caps.test.ts`, karaoke-index, claim-token test, `.gitignore`, `package.json`) is empty, so #90's squash is taken verbatim.
- `git diff origin/main` on `jest.env.ts` and `playwright.config.ts` is additions only: the oEmbed origin, the stub env and the seam flag. Nothing from #90 was dropped.
- The code diff against `origin/main` lists only TICKET-140 files.
- `origin/main` has since gained two event-log-only commits, and GitHub reports the PR MERGEABLE.

## Reviewer mutation pass (targeted jest: api-queue, api-video-meta, video-meta-cache, youtube, api-moderation; 176 tests)

Baseline: 5 suites, 176 passed (load about 125).

R1–R6 and R8–R10 KILLED (9/9):
- R1 seam gate: 1 test failed.
- R2: 2 failed.
- R3: 2 failed.
- R4 parse cap: 1 failed.
- R5 no-store: 1 failed.
- R6 duration: 2 failed.
- R8 re-clean: 2 failed.
- R9 server title: 4 failed.
- R10 loosening the bare-id mixed-case rule: 7 failed.

R7 (Redis get fail-open) was not applied because its pattern was ambiguous. The Dev's own get/set fail-open mutants cover it.

## PR body accuracy

The body is accurate against the diff: the base, the round-2 list, the removed field, the seam, the evidence counts, the copy table and the Cyber notes.

Nit: the PR **title** still says "(stacked on #90)", but the base is now `main` and #90 is merged. Retitle before merge.

## Still needed before merge (not Reviewer items)

- verify-green local-Docker GREEN on the branch rebased on current main.
- App Tester r2 PASS (in progress, `apptest-r2/` is uncommitted in the shared worktree).
- The TL confirmation of the gap-5 block that the round-1 review flagged.

Cyber delta re-gate PASS is at `4039dff`.
