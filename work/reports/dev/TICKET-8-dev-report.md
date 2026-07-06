# TICKET-8 — In-app YouTube search — Dev Report

- **Product:** cantai · **Ticket:** TICKET-8 · **Role:** Dev (wave-1 parallel)
- **Branch:** `ticket/8-youtube-search` · **Worktree:** `.worktrees/ticket-8`
- **App port:** 3040 (base config); e2e verified on an isolated `3008` (parallel-wave courtesy)
- **Status:** IMPLEMENTED + fully verified locally. Draft PR open. Live verification blocked on the YouTube API key (needs-user).

## Summary

Added server-side YouTube Data API v3 search with a clean degraded (paste-link) fallback:

- `GET /api/search?q=&uuid=` reads `YOUTUBE_API_KEY` **server-side only**, validates the query, rate-limits per uuid, caches identical queries, and maps no-key / quota / upstream failures to a non-throwing `{ degraded, reason }` contract so the patron UI never crashes.
- `components/SongSearch.tsx` — the design §2 dual-behavior input: free text (debounced 400ms, min 3 chars) → `song-row` results (64×48 thumb, ellipsized title, `channel · duration` meta, selected state + check, skeleton loading); a pasted YouTube URL/ID resolves locally with **no API call**; degraded state shows "Busca indisponível — cola o link do YouTube" while paste-link keeps working.
- `app/page.tsx` — replaced the standalone "YouTube URL" field with `<SongSearch>`; selection drives the existing submit flow (queues the picked `videoId`, prefills the optional title from the result).

## Files

Owned/new:
- `lib/youtube-search.ts` — pure core (duration formatter, `mapSearchResponse`, `searchYouTube` w/ injectable fetch, typed `YouTubeQuotaError`/`YouTubeSearchError`, LRU query cache, per-uuid sliding-window rate limiter). No React, no `process.env`.
- `app/api/search/route.ts` — the search route (degraded contract, validation, 429 rate limit, caching).
- `components/SongSearch.tsx` — the picker component.
- `.env.example` — new file with the documented `YOUTUBE_API_KEY=` line (see wave note below).
- `__tests__/youtube-search.test.ts`, `__tests__/api-search.test.ts` — unit tests (mocked, never hit Google).
- `e2e/search.spec.ts` — mocked search→select→submit + degraded/paste-link e2e.

Modified:
- `app/page.tsx` — song-pick section (sole wave-1 owner of this file).
- `e2e/submit-song.spec.ts` — updated the paste-link assertion to the new unified input (the old separate "YouTube URL" field it targeted no longer exists after the design's single-input change). Same intent (paste link → submit → appears in queue).

## Ownership / wave notes

- Stayed within TICKET-8 boundaries. Did **not** touch `lib/store.ts`, `app/api/queue/**`, `app/tv/**`, `app/admin/**`, or rewrite `lib/youtube.ts` (extended via the new module; the parser is reused as the fallback).
- Song-row/skeleton styling is inline (existing page convention) — `app/globals.css` was intentionally NOT modified (not in my ownership set).
- **`.env.example` sequencing (wave rule #6):** TICKET-6 owns this file's creation. It did not exist on main when I branched, so I created it with the `YOUTUBE_API_KEY` line. If #6 merges first, whoever merges second rebases and re-appends (trivial). Flagged for the TM's sequential-merge handling.

## Degraded-mode behavior (no key / quota)

- No `YOUTUBE_API_KEY` (local dev / CI / not-yet-provisioned): route returns `200 { degraded:true, reason:"no-api-key", results:[] }`. Free-text typing shows the fallback copy; pasting a link resolves locally and is submittable. **App builds and all tests pass with no key.**
- Google quota (`403 quotaExceeded`): `searchYouTube` throws `YouTubeQuotaError`; route returns `200 { degraded:true, reason:"quota" }` → same fallback UI, no crash.
- Any other upstream error → `200 { degraded:true, reason:"error" }` (never a 500 to the patron).

## Self-verification (real output)

**Unit — `npm test`:** `Test Suites: 5 passed, 5 total · Tests: 71 passed, 71 total` (added 30 tests: 24 in youtube-search, 6 in api-search; pre-existing 41 still green).

**Build — `npm run build`:** `✓ Compiled successfully`; `/api/search` registered as a dynamic route (`ƒ /api/search`). Types + lint clean.

**Bundle safety (AC4):** `grep -rE "YOUTUBE_API_KEY|googleapis.com/youtube|searchYouTube" .next/static` → no matches. The key/search code never reaches the client bundle.

**E2E — Playwright (isolated port 3008, own dev server):** `3 passed` —
- `search.spec.ts › search → select a result → submit queues the picked video`
- `search.spec.ts › degraded search shows fallback copy but paste-link still works`
- `submit-song.spec.ts › patron submits a song and it appears in the queue` (updated)

## Acceptance criteria

1. Search shows tappable results (thumb/title/channel/duration); tap + submit queues the videoId — ✅ (e2e).
2. Pasting a YouTube URL resolves directly without hitting the search API — ✅ (component resolves via `parseYouTubeVideoId`, no fetch; e2e).
3. No key → builds, tests pass, fallback copy + paste-link functional — ✅ (build/tests + e2e degraded test).
4. Key in zero client bytes / zero logs — ✅ (bundle grep; key only referenced server-side in the route; never logged).
5. Debounced (400ms/3-char) + rate-limited (6th rapid req/uuid → 429) — ✅ (unit tests for the limiter + route 429).
6. Quota-exceeded renders the degraded state, not a crash — ✅ (unit maps 403 quota → `YouTubeQuotaError` → degraded; e2e degraded path).

## Needs-user (W7)

- **YouTube Data API v3 key** — Google Cloud: enable "YouTube Data API v3", create an API key, restrict to that API + server/Vercel referrers → set as `YOUTUBE_API_KEY` in Vercel env + local `.env`. Buildable/testable without it; gates the **live** search verification only.

## CI note

Product CI is known billing-broken (per TM). Verification above is local with real command output. `gh pr checks` will be pasted once CI is restored; gates rely on the local evidence in the meantime.

## Friction

- `emit-event.sh` (framework script) wrote the `worktree_created` event into the **worktree's** tracked `work/events/2026-07.jsonl` rather than the main checkout, dirtying the worktree with a line that would cause cross-branch jsonl merge conflicts. Restored it (event emission is fail-safe/non-blocking). Worth a framework note if it recurs.
