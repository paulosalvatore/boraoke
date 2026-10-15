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
