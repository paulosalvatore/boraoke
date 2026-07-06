# TICKET-8 — In-app YouTube search — Plan

- **Date:** 2026-07-05 · **Product:** cantai · **Role:** Dev (wave-1 parallel)
- **Branch:** `ticket/8-youtube-search` · **Worktree:** `.worktrees/ticket-8` · **App port:** 3008 (e2e override; base config is 3040)
- **Status:** self-approved under wave-1 autonomy (fully-specified ticket; TM-spawned delivery). Plan recorded for the durable record.
- **APPROVED-BY:** auto-approved (no plan-gate escalation) — validated downstream by gates + TL merge of PR #8

## Approach

Add a server-side YouTube Data API v3 search route, a reusable `SongSearch` client component with the design's dual-behavior input (free text → search results; pasted URL → resolve locally without the API), and wire it into the patron song-pick section of `app/page.tsx`. The API key is read **only** server-side (`process.env.YOUTUBE_API_KEY`) inside the route; when absent or quota-exceeded the route returns a `degraded` contract and the UI shows the designed fallback copy while paste-link keeps working.

## Files touched (all within TICKET-8 ownership)

- `lib/youtube-search.ts` (new) — pure, testable core: ISO-8601 duration formatter, `mapSearchResponse()` (search.list + videos.list → `SearchResult[]`), `searchYouTube(q, key, opts)` (does the two fetches; throws typed `YouTubeQuotaError`/`YouTubeSearchError`), plus an in-memory LRU query cache and a per-uuid sliding-window rate limiter (module singletons with test-reset helpers). No React, no `process.env` import.
- `app/api/search/route.ts` (new) — `GET /api/search?q=&uuid=`; reads the key from env; validates (min 3, max 100 chars); rate-limits per uuid (5/10s window, 6th → 429); caches identical queries (~60s); maps Google's quota/no-key to `{ degraded, reason }`.
- `components/SongSearch.tsx` (new) — debounced (400ms, min 3 chars) dual-behavior input; `song-row` results (64×48 thumb, ellipsized title, `channel · duration` meta), selected state (pink border + check), skeleton rows, degraded/quota copy "Busca indisponível — cola o link do YouTube". Reports selection up via `onSelect`.
- `app/page.tsx` — replace the raw "YouTube URL" input block with `<SongSearch>`; selection drives `parsedVideoId` (+ prefilled title). Rest of the form/queue unchanged.
- `app/globals.css` — **owned? NO.** Song-row/skeleton styles go inline (existing page convention is inline `style={}`) to avoid touching a non-owned file. (globals.css is not in the ownership list.)
- `.env.example` (new) — append `YOUTUBE_API_KEY=` line (sequential-merge per wave rule #6; #6 creates the file first — if it lands before me I re-append, if after, note in PR).
- `__tests__/youtube-search.test.ts`, `__tests__/api-search.test.ts` (new) — mapping, duration parse, quota-error handling, no-key degraded, rate-limit, cache. Never call the live API.
- `e2e/search.spec.ts` (new) — `page.route('**/api/search**')` mock → type → select result → submit → appears in queue; plus a degraded-mode paste-link path.

## Degraded / no-key behavior

- No `YOUTUBE_API_KEY`: route returns `200 { degraded:true, reason:"no-api-key", results:[] }`. Free-text typing shows the fallback copy; pasting a URL resolves locally (no API call) → selectable → submittable. App builds & tests pass with no key (CI/local-dev mode).
- Google quota (403 `quotaExceeded`): `searchYouTube` throws `YouTubeQuotaError`; route returns `200 { degraded:true, reason:"quota", results:[] }` → same fallback UI, no crash.

## Risks / notes

- The key must appear in zero client bytes: it is only referenced in the route (server). Verified by bundle grep in self-verify.
- Serverless per-instance cache/rate-limit is best-effort (acceptable per ticket §2).
- e2e runs on a one-off `PORT=3008` override to avoid colliding with parallel wave-1 devs on 3040.

## Needs-user

- YouTube Data API v3 key (Google Cloud) → Vercel env + local `.env`. Buildable/testable without it; gates live verification only.
