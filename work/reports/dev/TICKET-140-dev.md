# TICKET-140 — dev report

**Status:** round 2 done: main merged in, every Reviewer REQUEST-CHANGES item and every Cyber finding addressed, self-verified (full jest, build + bundle grep, full e2e 141/141). Ready for the Reviewer re-pass and a Cyber delta check.
**Branch:** `ticket/140-paste-link`, base `main` (PR #90 merged as a0f2b59).
**Worktree / port:** `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t140-paste-link`, 3140 (e2e stub on 4140).

## Picking up from

Fresh start from the TM brief (items 1–7) and `work/tickets/TICKET-140-paste-link-gaps.md`. No earlier reports or PR.

## Implementation log

- `c8b37bd` fix(TICKET-140): close the paste-a-YouTube-link gaps (code, tests, e2e, plan, evidence).
- (this commit) dev report + plan APPROVED-BY write-back.

## What was done, per item

1. **11-letter word bug.** `looksLikeBareVideoId` (lib/youtube.ts): bare token is an id only with a digit or `_`, or mixed case beyond Title Case. Hyphen alone deliberately does not count ("rock-n-roll", "hip-hop-pop" are 11 chars). Trade-off: ~1 in 6,000 real ids (no digit/`_` and all-lower/all-upper/Title) must be pasted as a link; 11-char queries with a digit or odd casing ("Blink182abc") are taken as an id. Both directions tested.
2. **URL forms.** music.youtube.com, youtube-nocookie(/www) embed, case-insensitive scheme/host, `youtu.be/<id>/`, share text (only URL tokens containing "youtu" are read from multi-word input; punctuation stripped). Path matching tightened to exactly one id segment. One parser for client and server (route `youtubeUrl` test proves agreement).
3. **Title.** `videos.list` now `part=status,snippet,contentDetails` (still 1 call, 1 unit) → title, channel, duration. Keyless oEmbed when that call is not made (no key) or gives no title. `lib/video-meta.ts` caches in `vm:<id>` (L1 + Upstash; 24 h found, 10 min missing, errors uncached). 800 ms timeouts each. Display via `lib/song-label.ts` in PatronRoom (queue + pending), AdminRoom (queue + pending with duration), TvScreen (hero = title, queue = title · channel). Picker preview via new `GET /api/video-meta` (oEmbed only, never Data API, 60/min/IP). Client title not trusted: server title wins; client title only when every lookup failed.
4. **Embeddability.** Definite `not-embeddable` → 422 `{error, reason:"not-embeddable"}` before moderation/queue; any failure → song allowed.
5. **Server trust.** Lookup runs for every submit regardless of `source`; `source` is now a telemetry label only. SongSearch sends an explicit `source` on the selection.
6. **Rate-limit copy** mentions pasting a link (pt-BR/en/es).
7. **Per-instance submit limit: left as is.** Moving `lib/queue-rate-limit.ts` onto `lib/rate-limit-counter.ts` changes sliding → fixed window, needs a check-then-charge across two buckets and adds Redis round-trips on the hottest route; not small. TICKET-67 tracks it.

e2e support: production build honours loopback `YOUTUBE_API_ORIGIN` / `YOUTUBE_OEMBED_ORIGIN` only with `BORAOKE_E2E_STUBS=1` and off Vercel; sends a placeholder key to a stub (never the real one). `jest.env.ts` points oEmbed at a closed loopback port so no suite reaches youtube.com.

## Self-verification (verbatim, evidence in `work/evidence/ticket-140/`)

Full jest (`jest-full.txt`):
```
START 18:38:23 load averages: 95.05 110.20 130.29
Test Suites: 71 passed, 71 total
Tests:       18 skipped, 1260 passed, 1278 total
END 18:39:19 load averages: 104.82 111.81 129.72
```
Note: that run printed "A worker process has failed to exit gracefully"; the base branch run did not. `--detectOpenHandles` on every touched suite found no handle. Flagged for the Reviewer as possibly load-related, not chased further.

`npm run build` (`build.txt`): exit 0, START load 91.08, END load 72.33; `bundle-es-target: OK — all 51 chunk(s) parse at ES2019`; `css-target: OK — the TV surface uses nothing newer than Chrome 68`.

Full e2e, workers 1, PORT=3140 (`e2e.txt`): START 18:42:06 load 75.99, END 18:48:06 load 112.85 → `136 passed, 2 failed`. Both failures were in the new spec: `getByText("Link do YouTube")` substring-matched the input label. Fixed with `exact: true`; re-run of canary + paste-link spec: START 18:48:26 load 99.23, END 18:49:53 load 92.51 → `6 passed (1.4m)`, canary green. No other boraoke e2e run was live (checked `ps`).

## Prove-your-test-can-fail

Reverse-check vs base `ede63ef` (`reverse-check.txt`): old parser body → `22 failed, 66 passed, 88 total` (all 7 words, all new forms); old route → `12 failed, 26 passed, 38 total` (block, source-ignored, title, cache). With the change: `134 passed, 134 total`.

Triggered mutation pass (identity path: video-id parser) — `mutation-pass.txt`: 17 mutants; 16 KILLED; M5 (protocol check removed) SURVIVED-equivalent (non-http schemes become the host after `https://` is prepended and are refused by the exact host check); M6 (embed path segment count relaxed) was SURVIVED-real-gap, fixed in-PR with two refuse cases, re-run KILLED.

## Open for the gates

- Cyber: rule on keeping the client title as a last-resort fallback (gap 6).
- Every search pick now spends 1 `videos.list` unit on a cache miss (separate pool). Pre-warming `ec:`/`vm:` from search results was considered and skipped (50 Redis writes per search).
- Clipboard "Colar link" button (ticket gap 7 suggestion) not built; not in the TM item list.

## Round 2 — review and cyber fixes (2026-10-15)

### Picking up from

Reviewer REQUEST-CHANGES (`work/reports/review/TICKET-140-review.md`, comment 6203198615), Cyber PASS-WITH-NOTES (`work/reports/security/TICKET-140-security.md`, comment 6203194280), App Tester PASS. The `tsconfig.json` change the App Tester run left behind was already gone at 0b9e66a (tree clean) and `.next-apptest/` is not tracked (`git ls-files | grep -c next-apptest` → 0).

### Implementation log

- `2221dc5` Merge origin/main (#90 squash a0f2b59), a merge, no rebase or force-push. Conflicts: the #90 files (`lib/search-budget.ts`, `.env.example`, `__tests__/api-search-personal-caps.test.ts`, the TICKET-126 ticket/plan/report) taken from main, since main holds #90's final squash; `jest.env.ts` and `playwright.config.ts` kept both sides. After the merge, `git diff origin/main --stat` lists only TICKET-140 files.
- `4ac1870` fix(TICKET-140): review and cyber fixes (below).
- `7060c6f` TICKET-153, 154, 155 filed.
- (this commit) evidence `work/evidence/ticket-140/r2/` and this report.

### What changed

| Item | Fix |
|---|---|
| Review 1 | New `__tests__/video-meta-cache.test.ts`: memory L1 and a Map-backed fake Upstash. Covers the `{t,c,d}` round-trip read by another instance, `vm:` key on get and set, px 24 h found / 10 min missing (Redis and L1), malformed values as a miss, control chars re-cleaned, GET/SET errors failing open, L1 warming. Added `_resetMetaCacheClient` for it. |
| Review 2 | `e2e/search.spec.ts`: 429 with the server's copy, 429 with no body (client copy), and `{degraded, reason:"error"}`. Each asserts the paste hint and that a paste still selects. |
| Review 3 | `PatronRoom.tsx`: `submitWarning` state, `submit-warning` element, the `warning` parse and the stale TICKET-61/FOLLOW-UP comment removed. |
| Review 4 (opt.) | `/api/video-meta` answers `{}` with `Cache-Control: no-store`; a found title keeps `private, max-age=600`. |
| Review opt. 4, 7 | `formatDuration` hours test; the no-key "writes no `ec:` verdict" assertion restored. |
| MED-1 | `parseYouTubeVideoId` returns null for input over `MAX_PARSE_INPUT` (512) before any regex. `stripSharePunctuation` is now a linear index walk. The search box has `maxLength={512}`. |
| LOW-1 | The queue route never stores a client-sent title. When every lookup fails, the entry has no title and shows `youtu.be/<id>`. `title` is still length-checked (400 over 120) for old clients, then ignored. |
| LOW-3 | `lib/youtube-server.ts` (`import "server-only"`) now holds `fetchVideoDetails`, `checkEmbeddable`, `fetchOEmbed`, `videoApiKey`, the overrides, `cleanMetaText` and `formatDuration`. `lib/youtube.ts`, which the client imports, keeps only the parser, `isValidVideoId` and the two shared types. |
| LOW-2 | Not fixed here. Filed TICKET-153. |
| App Tester | Filed TICKET-154 (host admin horizontal scroll on phones). Filed TICKET-155 (e2e warm-ups wait for `load` on /default/tv). |

### Two calls the TM should know about

1. **I removed the patron's optional "Título da música" field** (and its `songTitleLabel`/`songTitlePlaceholder` keys in all 3 locales). Once LOW-1 drops the client title, the field cannot change anything in production: the server title wins when a lookup works, and nothing is stored when none does. Keeping a field that silently does nothing seemed worse. This is a visible form change. If the TL wants the field back, it's a small revert, but it would need a product meaning (e.g. a host-visible note) to do anything.
2. **A test-only seam keeps seeded titles in the local e2e build.** About 10 e2e specs seed songs via `POST /api/queue` and tell them apart by title. No YouTube lookup answers in e2e, so without a seam every row would read `youtu.be/dQw4w9WgXcQ`. `clientTitleFallbackAllowed()` (lib/youtube-server.ts) keeps the client title only when every lookup failed. It needs `BORAOKE_TEST_CLIENT_TITLES=1` AND the same gate as the origin overrides (non-production, or `BORAOKE_E2E_STUBS=1` off Vercel), so it is off on Vercel whatever the env says. A jest test proves that (flag on + NODE_ENV=production + VERCEL=1 → no title). Only `playwright.config.ts` sets the flag. jest does not, so the unit suites run the production rule. The specs that went through the patron form (moderation, rooms, submit-song, feedback-widget) now identify songs by nickname.

### Self-verification (verbatim; files in `work/evidence/ticket-140/r2/`)

Full jest (`jest-full.txt`), final run:
```
START 20:28:41 load averages: 165.46 150.17 132.35
Test Suites: 73 passed, 73 total
Tests:       21 skipped, 1344 passed, 1365 total
END 20:29:10 load averages: 170.54 152.53 133.71
```
An earlier run (19:49, load 159) had one failure: `karaoke-index-matcher.test.ts:136`, a 25 ms timing bound in a suite this PR does not touch. It passed alone and in the run above. The "worker failed to exit gracefully" warning from round 1 did not recur.

`npm run build` (`build.txt`): START 19:50:11 load 153.08, END 19:53:30 load 142.61. `bundle-es-target: OK — all 51 chunk(s) parse at ES2019`; `css-target: OK`.

Client bundle grep (`bundle-grep.txt`, on that build):
```
client files scanned: 51 js files under .next/static
positive control (parser host string, must be >0): 1 files
positive control 2 (music.youtube.com, the parser host set): 1 files
YOUTUBE_API_KEY in client bundle: 0 files
AIza in client bundle: 0 files
local-stub-key in client bundle: 0 files
oembed/videos.list server code in client bundle: 0 files
server-side control (key reader present server-side, must be >0): 3 files
```

Full e2e (`e2e-full.txt`), workers 1, PORT=3140. The #96 lane's run on 3118 was live, so I waited for it to finish (its END 20:05:47) before starting:
```
START 20:13:09 load averages: 105.06 114.52 126.63
other boraoke e2e live at start: 0
  141 passed (14.8m)
EXIT 0
END 20:28:09 load averages: 165.14 148.31 130.98
```
Canary: both `_canary.spec.ts` tests ✓.

### Prove-your-test-can-fail

**(a) Reverse check vs the old code** (`reverse-check.txt`; old = 2221dc5 files plus compile-only shims). 8 failed:
- no-store: `Expected: "no-store"`, `Received: "private, max-age=600"`.
- Title never stored: the client title is present.
- Non-existent id: `Received: "FREE DRINKS at table 9"`.
- Seam gated on Vercel: fails.
- Parser timing, linear token: `Received: 1251.02` (bound < 50).
- Parser timing, share text: `Received: 1086.07`.
- Over the cap: `Received: 80819.76` ms for 100k chars.
- formatDuration: a shim artifact, proven by mutant Mi instead.

The title-cache suite passes on the old code. The cache was correct but untested, so the mutants below are its proof.

e2e reverse (`e2e-reverse.txt`, port 3141). pt-BR `rateLimited`/`searchRateLimited` reverted to the pre-PR text, and `degraded` mutated to drop its hint. 3 failed, e.g. `Expected pattern: /cole um link do YouTube/`, `Received string: "Muitas buscas — aguarde um instante."`. The `error` case passes on the pre-PR code because its hint predates this PR; the mutation is what proves it (`Received string: "Busca indisponível"`).

**(b) Mutation pass** (`mutation-pass.txt`): 16/16 KILLED. Includes the Reviewer's survivors: Ma (wrong read key, 6 failed), Mg (missing cached 24 h, 2 failed) and Mi (hours branch, 1 failed). Also the stored shape, malformed check, get/set fail-open, L1 skip, no-key `ec:` write, length cap, both strip loops, no-store, seam gate and client-title restore.

**(c) Hollowing-out:** `stripSharePunctuation` changed from a regex to a loop under the existing share-text and punctuation assertions. I re-ran them against the loop with each end's loop mutated: the leading-loop and trailing off-by-one mutants each fail 3 tests, so those assertions are not vacuous.

**(d) Triggered mutation pass:** triggered (the id parser is an identity path). See (b).
