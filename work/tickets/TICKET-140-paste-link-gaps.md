---
ticket: TICKET-140
product: boraoke
status: filed
---

# TICKET-140 — Paste-a-YouTube-link fallback: close the gaps

**Filed:** 2026-10-15, by the boraoke Tech Manager. TL ask (verbatim): "I think we need to add the ability to directly paste the youtube link if search is disabled."
**Priority:** MEDIUM — it is the patron's only way in when live search is unavailable.
**Type:** Search / UX / security
**Size:** S–M
**Patron-facing:** yes. **Gates:** Cyber Security gate (new outbound call + client-trust change on the busiest public route). **TL OK before merge.**

## Status: the feature already exists, this ticket is the gap list

Pasting a YouTube link already works on `main` and on `origin/ticket/126-search-limits`, with 0 `search.list` calls:

- The search box accepts a link or a raw ID. `components/SongSearch.tsx` resolves it locally with `parseYouTubeVideoId` (`lib/youtube.ts:13-53`), shows a single "YouTube link" row with an `i.ytimg.com` thumbnail and auto-selects it. No API call.
- `POST /api/queue` (`app/api/queue/route.ts`) re-validates the ID server-side (`:100-131`), runs the same rate limit, rotation checks and moderation (TICKET-44, the pending path `:272-309`) as a search pick.
- Embeddability (TICKET-61/95): on the paste path only, `videos.list part=status` (1 unit from the separate ~10k/day pool, never `search.list`'s 100-unit calls), cached 24 h in `ec:<videoId>`, fail-open, 800 ms timeout. A "not embeddable" answer is a **warning only**, the song is still queued (`:247-263`). The TV watchdog (TICKET-41) skips it if it fails to play.
- Every degraded reason's copy already says to paste a link: `degraded`, `dailyLimit` (main) and `personalLimit` (126 branch), plus the input placeholder (`messages/*.json:211-217`).

So this is not a new feature. It is the following gaps.

## Gaps

1. **An 11-letter single word is taken for a video ID.** `parseYouTubeVideoId` accepts any bare 11-character `[A-Za-z0-9_-]` string (`lib/youtube.ts:19`), and the search box tries it before searching (`SongSearch.tsx`, the paste branch of the input effect). Typing `Imagination`, `Bittersweet` or `Unbreakable` shows a fake "YouTube link" row, auto-selects a probably non-existent video and never searches. Fix: in the search box, accept only URLs (keep the bare-ID form for the server or behind a stricter check).
2. **URL forms not parsed** (probed against `lib/youtube.ts` on main, 2026-10-15): `music.youtube.com/watch?v=…`, `youtube-nocookie.com/embed/…`, an upper-case scheme (`HTTPS://YOUTU.BE/…`), a trailing slash (`youtu.be/<id>/`), and share text with words around the link ("olha esse https://youtu.be/…"). Already parsed: `youtube.com/watch` and `m.youtube.com/watch` with extra params (`&t=`, `&list=`, `&si=`, `v` not first), `youtu.be/<id>?si=…&t=…`, `/shorts/`, `/embed/`, `/live/`, `/v/`, scheme-less `youtube.com/…`. Look-alike hosts (`youtube.com.evil.com`) are correctly refused and must stay refused.
3. **No title.** A pasted song is shown as "YouTube link" while picking, and as `youtu.be/<id>` in the patron queue, the host/moderation view and on the TV (`PatronRoom.tsx:497,607`, `AdminRoom.tsx:563,626`, `TvScreen.tsx:1046,1103`). A moderator approving a pending paste cannot see what it is. Fix: fetch the title server-side from YouTube oEmbed (`https://www.youtube.com/oembed?url=…&format=json`), which needs no API key and costs no Data API quota. It returns title, channel name and thumbnail, and 404 for a missing video (probed 2026-10-15). Cache it beside `ec:` with the same TTL rules, bounded timeout, fail-open to today's display. Duration is not in oEmbed: either skip it, or add `contentDetails,snippet` to the existing `videos.list` call, which still costs 1 unit. The plan picks one and says which.
4. **Patron preview before submit.** Show the oEmbed title and channel on the pasted row once known, so the patron sees the right song before tapping add. Prefer a small server endpoint (one cached fetch shared by all patrons, no new CSP `connect-src` host; not verified whether a direct browser call would work); it goes in a rate-limit bucket.
5. **Embeddable-only is advisory.** A definitive `not-embeddable` verdict still queues the song with a warning. Decide in the plan, and confirm with the TL: block a definitive `not-embeddable` paste (keep fail-open on `unknown`), or keep the warning. TICKET-41's watchdog stays the backstop either way.
6. **Server trusts client-declared source and title.** A client that sends `videoId` with `source: "search"` skips the embeddability check and can attach any `title` up to 120 characters (`route.ts:85,105-124,165-170,185`). With item 3 in place, a paste's title comes from oEmbed, not the request. Moderation is the backstop for search picks today. The Cyber gate rules on whether a server-fetched title should replace the client title for every submit.
7. **Discoverability gaps.** The 429 "too many searches" copy (`rateLimited`, `searchRateLimited`) does not mention pasting a link. And the hint is text only: consider a "Colar link" button that reads the clipboard (with a fallback when clipboard read is refused). A `quota` or `error` reason falls to the generic `degraded` copy, which already mentions pasting, so those are fine.
8. **Submit rate limit is per instance.** `lib/queue-rate-limit.ts` (10 per patron, 60 per IP, per minute) is in-memory, so N warm instances allow N times that. The new oEmbed call must sit after that limit and after `checkSubmit`, like the `videos.list` call does, and be cached so repeats cost nothing.

## Copy rule (TL, 2026-10-15)

Patron copy must **never** mention billing, quota, cost, or limits framed as money. Any new or touched string follows it in pt-BR, en and es. Check #90/TICKET-126's `personalLimit` copy and the existing `dailyLimit` copy against this rule (they speak of "limits" but not money; the TL confirms).

## Acceptance

- Typing an 11-letter word searches. A test that fails on today's code.
- Every form in gap 2 parses to the right ID, look-alike hosts are still refused (table-driven test, mutation-proof).
- A pasted song shows its real title in the picker, the queue, the moderation view and on the TV, with 0 `search.list` calls and 0 Data API units for the title (test stubs oEmbed). On oEmbed failure, today's display stays.
- The embeddability decision from gap 5 is implemented and tested.
- Paste works and shows the paste hint in every degraded state: `no-api-key`, `quota`, `error`, `daily-limit`, `personal-limit`, and the 429 rate limit. e2e with search forced degraded.
- Copy in all three catalogs, passing the copy rule.
- Cyber gate report covers the new outbound call (fixed host, `URLSearchParams`, timeout, cache, rate limit) and gap 6.

## References

- `lib/youtube.ts`, `lib/embed-cache.ts`, `app/api/queue/route.ts`, `components/SongSearch.tsx`, `app/(patron)/[room]/PatronRoom.tsx`, `app/(patron)/[room]/admin/AdminRoom.tsx`, `components/tv/TvScreen.tsx`, `lib/queue-rate-limit.ts`, `messages/{pt-BR,en,es}.json`.
- Tickets: TICKET-41 (TV watchdog), TICKET-44 (moderation), TICKET-61 / TICKET-95 (paste embeddability check and cache), TICKET-126 (personal limit copy).
