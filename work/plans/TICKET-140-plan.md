# TICKET-140 — plan: close the paste-a-link gaps

**APPROVED-BY:** auto-approved (no plan-gate escalation; TM dispatched implementation with the item list) — validated downstream by gates + TL merge of PR #95

**Status:** implemented on `ticket/140-paste-link` (stacked on `ticket/126-search-limits`, PR #90). The TM dispatched implementation directly with the item list below, so this plan records the decisions rather than gating them.

## Decisions

| Gap | Decision |
|---|---|
| 1. 11-letter word taken as an id | A bare 11-char token is an id only if it has a digit or `_`, or mixes case beyond Title Case. A hyphen alone does not count, because "rock-n-roll" and "hip-hop-pop" are 11 characters. URLs never go through the heuristic, so a word-shaped id still works as a link. Cost: roughly 1 in 6,000 real ids must be pasted as a link instead of bare. Same function on client and server. |
| 2. URL forms | Added `music.youtube.com`, `youtube-nocookie.com/embed`, case-insensitive scheme/host, `youtu.be/<id>/`, share text (only URL tokens are read from multi-word input). Path matching is now exact (one id segment), look-alike hosts still refused. |
| 3. Title | Server-side. The existing `videos.list` call now asks for `status,snippet,contentDetails` (still 1 unit) and gives title, channel and duration. When it is not made (no key) or fails, keyless oEmbed gives title and channel. Cached in `vm:<id>` (24 h found, 10 min missing, errors not cached). Display: `Title · Channel` in patron queue, host view and TV queue; title alone in the TV hero; duration added in the moderation (pending) row. Fallback `youtu.be/<id>` unchanged. |
| 4. Preview | `GET /api/video-meta?v=<id>`: cache + oEmbed only, never the Data API, so the public endpoint cannot drain quota. 60/min/IP bucket. The picker swaps its placeholder for title + channel. |
| 5. Embeddability | A definite `not-embeddable` refuses the submit (422, `reason: "not-embeddable"`), house default per the TM brief. Any failure still lets the song in. |
| 6. Client trust | The check runs for every submit, so `source` is a telemetry label only. The stored title is the server's; the client title is kept only when every lookup failed (Cyber gate to rule on whether to drop it entirely). |
| 7. Discoverability | `rateLimited` / `searchRateLimited` copy now mention pasting a link, in pt-BR, en, es. No clipboard button (not in the TM item list). |
| 8. Per-instance submit limit | Left as is. Moving it onto `lib/rate-limit-counter.ts` changes the window from sliding to fixed and makes the hottest route two Redis round-trips; not small. TICKET-67 tracks it. The new outbound calls sit after that limit and after `checkSubmit`, and are cached. |

## Risks

- Every search pick now spends 1 `videos.list` unit on a cache miss (separate ~10k/day pool, not `search.list`). A busy night of ~300 distinct songs is ~300 units.
- Submit latency on a full miss: up to 800 ms (videos.list) + 800 ms (oEmbed, only if videos.list gave no title).
- e2e: the production build honours loopback origin overrides only with `BORAOKE_E2E_STUBS=1` and never on Vercel; the real key is never sent to a stub.

## Test strategy

Unit (parser table, heuristic both ways, oEmbed, videos.list mapping, override guard), route (block, fail-open, source ignored, title precedence, caches, youtubeUrl forms), endpoint (preview, cache, rate limit), e2e for gaps 1, 3, 5 against a local stub. Reverse-checked against the old code and a triggered mutation pass.
