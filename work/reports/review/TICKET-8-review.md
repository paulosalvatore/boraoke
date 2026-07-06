# Review Report — TICKET-8: In-app YouTube Search

**Reviewer:** claude (Reviewer agent, sonnet pass)
**Date:** 2026-07-05
**PR:** #8 — paulosalvatore/cantai, branch `ticket/8-youtube-search`
**Verdict:** APPROVE

---

## Evidence Consulted

| Gate | Artifact | Status |
|---|---|---|
| App Tester | `work/reports/testing/TICKET-8-app-test.md` on branch | PASS |
| App Tester screenshots | `work/evidence/ticket-8/` — 7 PNGs on branch | Present |
| Security | `work/reports/security/TICKET-8-security.md` on branch | PASS-WITH-NOTES |
| Security follow-up | PR comment + commit bf17cd7 (+10 tests, 81/81) | All 3 findings fixed |
| Dev report | `work/reports/dev/TICKET-8-dev-report.md` on branch | Current (post-sec-gate state) |
| CI | `gh pr checks 8` — Vercel pass, Vercel Preview Comments pass | Green |

---

## Tests Run (Reviewer-verified)

```
npm test (ticket-8 worktree):
  Test Suites: 5 passed, 5 total
  Tests:       81 passed, 81 total
  Time:        0.329s

npx playwright test PORT=3008 (ticket-8 worktree):
  3 passed (8.2s)
  ✓ e2e/submit-song.spec.ts › patron submits a song and it appears in the queue
  ✓ e2e/search.spec.ts › search → select a result → submit queues the picked video
  ✓ e2e/search.spec.ts › degraded search shows fallback copy but paste-link still works

npm run build:
  ✓ Compiled successfully
  Routes: ○ /, ○ /tv, ƒ /api/queue, ƒ /api/queue/advance, ƒ /api/search

Bundle safety:
  grep -rE "YOUTUBE_API_KEY|googleapis.com/youtube" .next/static → CLEAN (no matches)
```

---

## Code Review

### lib/youtube-search.ts

Quality is high. Key findings:

- **Duration formatter** (`formatISODuration`): handles hours, minutes, seconds, minutes-only, seconds-only, null/undefined/garbage correctly. `PT0S` returns "0:00" (live streams) — acceptable for MVP.
- **`mapSearchResponse`**: correctly fuses `search.list` + `videos.list` payloads in `search.list` order, drops items without `videoId` (channel results), HTML-entity-decodes titles/channelTitle.
- **`searchYouTube`**: injectable `fetchImpl` keeps tests isolated. URL construction is correct — `type=video`, `videoEmbeddable=true`, `safeSearch=moderate`, `regionCode=BR`, `maxResults=8`, key never hardcoded. `videos.list` failure is non-fatal (returns results without durations); quota error on `videos.list` also throws `YouTubeQuotaError`.
- **Typed error taxonomy**: `YouTubeQuotaError` (403 `quotaExceeded`/`dailyLimitExceeded`) and `YouTubeSearchError` (other non-OK) — the route's `catch` handles all three cases (quota, known error, runtime), mapping each to a non-throwing `degraded` response. Exhaustive.
- **LRU query cache**: `getCached` does a delete+re-set on hit to move to Map tail (correct insertion-order LRU). `setCached` evicts while `size > CACHE_MAX` (100). TTL is checked at read time; stale entries evicted on access.
- **Rate limiter (dual-bucket)**: `rateLimitOk(uuid, ip)` evaluates AND charges **both** buckets every call, even when the uuid bucket already tripped. This is the correct implementation — a rotator accumulates IP-bucket charges on every rejected attempt, preventing the rotation bypass. UUID-only mode (`ip=""`) applies only when no IP is extractable (local dev without a proxy). Sliding-window arithmetic is correct (`filter t > now - RATE_WINDOW_MS` before checking `>= max`). LRU bucket eviction mirrors the query cache pattern.

### app/api/search/route.ts

Validation order: uuid → query length → rate limit → key check → cache → API. Correct sequencing — invalid queries don't consume rate budget; malformed UUIDs don't touch server state.

`clientIp()`: first hop of `x-forwarded-for`, falls back to `x-real-ip`, falls back to `""`. Spoofability: on Vercel the edge normalizes the header (trustworthy); in bare local dev the header is absent, so `ip=""` and only the uuid bucket applies. Acceptable for this deployment context; the code comment documents the tradeoff explicitly.

Degraded contract: no key → `200 { degraded:true, reason:"no-api-key" }`; quota → `200 { degraded:true, reason:"quota" }`; any other error → `200 { degraded:true, reason:"error" }`. Never 5xx to the patron. Verified.

### components/SongSearch.tsx

State machine is correct:
- Empty → reset all state, `onSelect(null)`
- Pasted YouTube URL/ID → resolved via `parseYouTubeVideoId`, auto-selected, no API call (AC2 satisfied)
- Text < 3 chars → no results, no search, `onSelect(null)`
- Text ≥ 3 chars → debounce 400ms → `runSearch`
- Degraded API response → show fallback copy; paste-link path unaffected (local resolution)
- 429 → show pt-BR rate-limit message
- Results → tappable rows with selection state

Sequence guard (`seqRef.current`) prevents stale responses from overwriting a newer query's results. `finally` block correctly runs `setLoading(false)` even on the 429 early-return path.

A11y basics: `htmlFor`/`id` pair on label+input, `aria-label` on input, `aria-pressed` on result buttons, `role="status"` on degraded and rate-limit notices, thumbnail `alt=""` (decorative). Adequate for the MVP.

### app/page.tsx

Changes are scoped to the form section only. Queue polling (`fetchQueue`, `POLL_INTERVAL`, the `useEffect` that drives it) is untouched. `handleSelect` is a stable `useCallback` reference. `searchKey` bump on submit correctly remounts `SongSearch` and clears its input/results. Title auto-prefill from a search result only when the title field is empty — good UX hygiene.

### e2e/submit-song.spec.ts

Update is legitimate, not a weakening. Old test targeted `getByLabel("YouTube URL")` + `getByText(/Video ID:/)` — that field and copy no longer exist. New test targets `getByLabel(/Buscar música/i)` + `getByText(/Selected:/)` — same intent (paste link → confirm → submit → queue). Assertions are equivalent in strength.

---

## Rebase Surface Assessment

TICKET-6 (persistence) merged into main after this branch was cut. Files touched by TICKET-6 that overlap with TICKET-8's scope:

| File | TICKET-6 change | TICKET-8 change | Merge outcome |
|---|---|---|---|
| `app/api/queue/route.ts` | Refactored to async store API | Not touched | **Clean** — main version preserved automatically |
| `app/api/queue/advance/route.ts` | Refactored to async store API | Not touched | **Clean** — main version preserved |
| `lib/store.ts` et al. | Created async store interface | Not touched | **Clean** — main version preserved |
| `.env.example` | Created with Redis vars | Created with `YOUTUBE_API_KEY=` line | **CONFLICT** — both branches created the file |
| `work/events/2026-07.jsonl` | Appended entries | Appended entries | **CONFLICT** — trivially resolved by keeping all lines |
| `app/page.tsx` | Not touched | Modified (SongSearch integration) | **Clean** |

**Semantic conflicts:** None. The patron page's queue polling (`fetch('/api/queue')`) contracts with `{ items, nowPlaying }` — TICKET-6 changed the server implementation to async store but kept that contract. TICKET-8's page.tsx changes are purely in the form section and don't interact with the polling.

**TM action required on merge:** Resolve `.env.example` by appending TICKET-8's `YOUTUBE_API_KEY=` section to TICKET-6's content (straightforward concatenation). `work/events/2026-07.jsonl` resolves by keeping all lines from both branches.

---

## Acceptance Criteria

| AC | Status | Evidence |
|---|---|---|
| 1. Search shows tappable results (thumb/title/channel/duration); tap + submit queues videoId | PASS | e2e `search.spec.ts › search → select → submit` |
| 2. Pasting a YouTube URL resolves locally without hitting the search API | PASS | Component path (`parseYouTubeVideoId` before any fetch); e2e degraded test pastes URL when API is degraded |
| 3. No key → build passes, tests pass, fallback copy + paste-link work | PASS | `npm test` 81/81 with no key; build clean; e2e degraded test |
| 4. Key in zero client bytes / zero logs | PASS | Bundle grep clean; key read server-side only in route |
| 5. Debounced (400ms / 3-char) + rate-limited (6th rapid req/uuid → 429) | PASS | 81 unit tests (rate-limiter suite + route validation suite) |
| 6. Quota-exceeded renders degraded state, not a crash | PASS | Unit tests map 403 quotaExceeded → `YouTubeQuotaError` → degraded; e2e degraded path |

---

## Security Gate Notes

All 3 findings from Cyber Security PASS-WITH-NOTES are fixed in commit `bf17cd7`:

- **MEDIUM #1 (uuid-rotation bypass):** Dual-bucket rate limit — per-uuid (5/10s) AND per-IP (30/10s); IP bucket charged even when uuid bucket trips. Correct implementation verified in code and 10 new tests.
- **MEDIUM #2 (unbounded hits Map):** LRU cap at 2000 buckets; oldest-touched evicted first. Correct implementation mirroring the query cache pattern.
- **LOW #3 (uuid length):** Strict UUID-shape regex (36-char) before any map use; `anon` also accepted; anything else → 400. Verified in uuid validation suite.

---

## Nits (optional, non-blocking)

1. `formatISODuration("PT0S")` → "0:00". Google returns "PT0S" for live streams; the "0:00" display is slightly misleading. Acceptable for MVP; consider filtering "0:00" to "" in a future iteration.
2. `pickThumbnail` prefers `medium` (320×180) for a 64×48 display slot — correct for HiDPI/Retina but the larger image is fetched. Low impact; fine for MVP.
3. The `eslint-disable-next-line @next/next/no-img-element` on the thumbnail is expected given dynamic YouTube URLs that can't be enumerated for `next/image` optimization. Fine.

---

## Verdict

**APPROVE.**

Implementation matches the ticket and plan. All acceptance criteria met. 81/81 unit tests + 3/3 e2e pass (reviewer-verified). Build clean. Bundle safety confirmed. Security findings all addressed with test coverage. Code quality is high: rate limiter logic is correct, cache is correct, degraded contract is correct, state machine is clean.

**Merge precondition:** TM must resolve the `.env.example` merge conflict before/during the GitHub merge (append TICKET-8's `YOUTUBE_API_KEY=` section to TICKET-6's Redis-vars content). Trivial two-line fix, not a code defect.

---

# Opus Second Pass (D-022 merge-counting judgment layer)

**Reviewer:** claude (Reviewer agent, opus pass — `claude-opus-4-8[1m]`)
**Date:** 2026-07-05
**Verdict:** APPROVE — with ONE required, explicitly-recorded pre-key-provisioning condition (doc-only; does not block this code merge)

This pass re-ran everything (81/81 unit, `next build` clean, bundle grep clean) and confirms the sonnet pass. It adds the judgment layer the cheaper pass did not carry: the **quota economics** of a money-adjacent, primary patron-facing flow.

## 1. Quota economics — the load-bearing finding

**Unit costs (YouTube Data API v3):** `search.list` = **100 units**, `videos.list?part=contentDetails` = **1 unit** → **101 units per successful search** (100 if a search returns zero ids and the `videos.list` call is skipped). Default project quota = **10,000 units/day** → **~99 searches/day TOTAL, shared across every venue on the single key.**

**Debounce/cache reality:**
- Debounce is 400ms / min 3 chars. Each typing *pause* > 400ms fires one search, so a patron naturally emits **~2–4 searches per song-add session** ("evi"→pause→search, "eviden"→pause→search, "evidencias"→search), not one.
- The query cache is a **module-level `Map` with a 60s TTL — per-lambda**. On Vercel serverless, concurrent invocations each hold their own Map, so the **cross-instance hit rate ≈ 0**. Two patrons searching the same song 30s apart routinely land on different instances → both miss → both spend 101 units. The cache saves units only for a single patron re-issuing the identical query on the same warm instance inside 60s. **Effective fleet-wide savings ≈ negligible.**

**Realistic busy-bar-night math:**

| Scenario | patrons × songs × searches | searches | units | vs 10k/day |
|---|---|---|---|---|
| Modest venue | 20 × 2 × 2 | 80 | 8,080 | **~80% of the *global* daily quota from ONE venue** |
| Busy venue | 40 × 4 × 3 | 480 | 48,480 | **~5× the daily quota — exhausted mid-night from ONE bar** |

The hard ceiling is **~99 searches/day across ALL venues combined.** A single busy bar exhausts it partway through the first night; two venues on the same night guarantee it. **At any real venue scale the live search is economically dead on day one** and stays degraded (paste-link) until the next 24h quota reset.

**Why this is APPROVE and not REQUEST-CHANGES:** the code is *correct* about this. When quota trips, `route.ts` maps `403 quotaExceeded → YouTubeQuotaError → 200 {degraded:true, reason:"quota"}` (never a 5xx), and the component (`SongSearch.tsx:63-66`) shows the fallback copy while the paste-link path (`parseYouTubeVideoId`, `:98-117`, zero API calls) keeps working. So the feature **degrades gracefully to the pre-TICKET-8 paste-link experience** rather than breaking. That is verified in code paths and the e2e degraded test, and it makes merging the *code* safe.

**What must NOT merge silently — the required condition:** the Needs-user note (dev report + plan) currently reads, in effect, "provision a key and it works." That materially understates reality: on the **default** 10k quota the live search is non-functional past ~1 modest venue-night. **Before the live key is provisioned/shipped, the TM must:**

1. Amend the Needs-user note to disclose the **~99-searches/day default-quota ceiling** and **recommend filing a YouTube Data API v3 quota-increase request** with Google (the only real fix; caching cannot rescue this at 100 units/search), OR commit a short `QUOTA-BUDGET.md` capturing this math.
2. This is **doc-only and gates KEY PROVISIONING, not this merge** — the code can merge now; the key is not yet provisioned, so there is a natural gate before any real quota is spent.

Posting this math publicly on the PR + recording the condition here is the "not silently" the mission requires.

## 2. Serverless statefulness — acceptable + honestly documented; follow-up available

The rate limiter (`hits`) and both caches are module-level `Map`s = **per-lambda**. An abuser hitting different warm instances multiplies the effective rate ceiling by the instance count, and cache misses across instances (see §1). The code is **honest** about this ("best-effort per instance", "per serverless instance; best-effort") and the security gate already rated + accepted it at MEDIUM for prototype tier. Acceptable to merge.

**Follow-up worth a ticket (not blocking):** the now-merged TICKET-6 **Upstash store gives a shared cross-instance backing.** Moving the query cache (and ideally the rate-limit buckets) onto it would (a) make the cache actually reduce quota burn cross-venue — the single biggest lever on §1 short of a quota increase — and (b) make the rate limit non-bypassable across instances. Recommend filing this as a hardening ticket to be scheduled alongside the quota-increase request.

## 3. UX under failure — PASS (verified in code paths, not just tests)

Quota exhausted mid-night: `route.ts:103-104` → degraded/quota → `SongSearch.tsx:63-66` sets `degraded`, renders "Busca indisponível — cola o link do YouTube"; the paste path (`:98-117`) resolves locally with no API call and auto-selects, so a patron can still queue a song by pasting a link. Graceful, no crash, no 5xx. e2e `search.spec.ts › degraded search…` covers it.

## 4. Response field pass-through — PASS

`mapSearchResponse` (`youtube-search.ts:103-125`) emits ONLY `{videoId, title, channelTitle, duration, thumbnailUrl}`. No other Google payload field reaches the client; `decodeHtmlEntities` handles only the 5 safe entities and React re-escapes as text (no XSS path — concurs with the security gate).

## 5. Rebase surface vs current main tip (TICKET-6 merged @ `8e51e9b`) — confirmed, nothing semantic missed

- `app/api/search/**` is a **clean add** (main has no `api/search`).
- `app/page.tsx` diff is scoped to the form section only; the queue-polling contract is preserved — main's GET returns `{items, nowPlaying}` and the page reads only `data.items`. `import type { QueueEntry, Mode } from "@/lib/store"` resolves against main's store. **No semantic conflict with the store refactor.**
- `.env.example`: genuine **two-creation conflict** (TICKET-6 Redis vars vs TICKET-8 `YOUTUBE_API_KEY=`) → resolve by concatenation. `work/events/2026-07.jsonl` → keep all lines. Both are the known merge-surface items; `mergeable:CONFLICTING` reflects exactly these, not a code defect.

## 6. Verification (opus-rerun)

`npx jest` → **81/81** (5 suites). `npx next build` → compiled clean, `ƒ /api/search` dynamic, bundle grep for key/API clean. CI `gh pr checks 8` → Vercel pass (both required checks terminal-green).

## Opus Verdict

**APPROVE (merge-counting).** The code correctly and cleanly implements the ticket, all ACs hold, gates are green, and the failure mode degrades gracefully and honestly. The one substantive judgment finding — the feature is economically dead on the default quota at real venue scale — is **not a code defect** (the code handles it), so it does not block this merge; it is recorded as a **required doc-only condition on live-key provisioning** (disclose the ~99/day ceiling + recommend a quota-increase request) plus a recommended Upstash-shared-cache/rate-limit hardening follow-up. TM resolves the `.env.example`/events-jsonl conflict at merge.
