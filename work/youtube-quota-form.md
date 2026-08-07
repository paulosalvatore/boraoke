# YouTube Data API — Quota Increase Form (paste-ready answers)

**Status (2026-08-05): drafted, not yet submitted.** The API key itself is provisioned and live in prod (since 2026-07-07); this quota-increase request is a separate, still-open TL action — see `work/status/BOARD.md`'s growth-arc decisions. The ~99-searches/day default ceiling applies until this is filed.

Product: **Boraoke** — https://boraoke.com · API key project: the Google Cloud project holding your "Cantai Karaoke Credentials" key (that is the project's literal name in Google Cloud Console — a pre-rename artifact of the external Google account, not something this repo's docs cleanup can or should rename).

## Use case description (Seção: caso de uso / descrição do cliente da API)

> Boraoke (https://boraoke.com) is a karaoke queue platform for venues (bars, parties, private and corporate events). Patrons scan a QR code at the venue, search for a song, and add it to the venue's shared queue; the venue's TV screen plays the selected videos exclusively through the official YouTube IFrame Player API — embedded playback only, with no downloading, no proxying, and full preservation of YouTube's ads, attribution, and playback controls.
>
> We use the YouTube Data API v3 for exactly one purpose: user-initiated song search. Each patron search calls `search.list` (100 units) and `videos.list` (1 unit) server-side. Searches are debounced client-side, cached server-side, and rate-limited per user AND per IP. The API key is stored server-side only and is verifiably absent from client bundles.

## Quota calculation (Seção: justificativa / volume)

> Current quota: 10,000 units/day ≈ 99 searches/day total.
> Real usage per venue night: 20–40 patrons × 2–4 songs × 1–3 searches each ≈ 80–480 searches ≈ 8,000–48,000 units — a single venue can exceed the entire default daily quota in one evening.
> Requested quota: **1,000,000 units/day**, sized for 10–20 concurrent early-access venues with headroom (≈9,900 searches/day). Playback consumes no Data API quota (IFrame embeds only).

## Compliance answers (if asked)

- **Data displayed:** only title, channel name, thumbnail, and duration of search results; selected videos play unmodified in the official embed.
- **Data storage:** we store only the selected videoId + title in the venue's queue (ephemeral, 90-day max retention); no API response caching beyond a 60-second search cache; no offline storage of media or metadata.
- **User data:** patrons are anonymous (random UUID + nickname); no Google user data is accessed; no YouTube account features are used.
- **No modifications to playback:** ads, branding, and controls untouched; TV screen is a fullscreen embed.
- **Monetization:** the platform is free in early access; future venue subscriptions charge for venue tooling, never for YouTube content itself.

## Seção 7 (declarações)

All checkboxes are standard consents (ToS, privacy, developer policies, termination understanding, accuracy, data-use/LLM-review consent, support-recording consent) — tick all and submit. Nothing in our use case conflicts with any of them.
