# TICKET-140 — dev report

**Status:** implemented, self-verified, draft PR [#95](https://github.com/paulosalvatore/boraoke/pull/95) open. Not yet requesting gates (TM to sequence: App Tester → Cyber → Reviewer; TL OK before merge).
**Branch:** `ticket/140-paste-link`, stacked on `ticket/126-search-limits` (PR #90, base `ede63ef`). Retarget to `main` after #90 merges.
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
