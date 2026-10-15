# TICKET-124 — Karaoke index as the primary search tier

**Filed:** 2026-10-14, by the boraoke Tech Manager (Global TM search-strategy brief).
**Priority:** HIGH — the 100/day `search.list` cap is still the binding limit on the core patron flow.
**Type:** Feature / quota
**Size:** L
**Prior art:** TICKET-106 (spike: harvested index, 36,372 videos for 741 units, hit@10 66% alone), TICKET-108 (shipped prefix narrowing: ~2.25 billed calls per queued song, hit@10 79%). Measurement code: `work/spikes/ticket-106/`, `work/measurements/ticket-108/`.

## Goal

Answer most sing-mode searches from a locally searched karaoke index harvested via `playlistItems.list` (the 10,000-unit pool), and keep live `search.list` only as the fallback when the index has no good match. The existing 12h search cache stays in front.

## Scope

1. **Production index tier.** A harvest job using only `videos.list` / `playlistItems.list` (never `search.list`), storage the app can read on the Vercel free tier, and a refresh path (cron or script), documented.
2. **Search order:** cache → index → live. Define the "good match" threshold explicitly and tune it on the TICKET-108 replay set.
3. **Measurement in the PR body:** billed `search.list` calls per queued song BEFORE (re-measured) → AFTER, and hit@10 of the combined tiers vs 79%, same predicate. **Quality must not drop below 79%.** If the threshold trade-off forces a regression, report the curve and stop for a TM decision.
4. **Tests:** unit tests for matcher / threshold / tier routing, a prove-can-fail mutation, and jest + e2e with run conditions stated.

## Folded in by the TM / Global TM (2026-10-14)

- **Re-harvest once with the production key** (the spike's 36k index was never committed). Zero `search.list`, guard on, units logged. Key read once via `vercel env pull` into the scratchpad, only `YOUTUBE_API_KEY` exported to the harvest process, file deleted right after. Not enrolled in the framework vault.
- Check the app's own non-search usage of the 10k pool before harvesting.
- Seeds = the karaoke-named channels in the production oracle. **Commit the seed list and the compact index fixture.** Put the channel-level seeding bias caveat in the PR body.
- **Data minimisation:** store only videoId, title, channel, duration per row.
- **Retention:** YouTube API Services policy limits unrefreshed stored data to about 30 days. Scheduled refresh if it fits the free tier (else document the cadence + file a follow-up). The index carries `harvestedAt`; data past the limit is treated as expired and falls back to live, never served silently.
- PR body gets a short "YouTube data retention" section: what is stored, how it is refreshed, and whether the committed fixture is a test fixture or the production source.

## Constraints

- No deploy, no production writes, no `search.list` spend during development.
- `workers: 1` stays for e2e; one suite at a time; `e2e/_canary` failing voids a run; `e2e/tv.spec.ts:740` is a known load-dependent flake.
- TICKET-83's no-fetch-on-mode-flip property and TICKET-87's fail-closed daily budget must keep holding.

## Acceptance

Draft PR with the before → after calls-per-song and hit@10, the threshold and its justification, the storage choice, tests (incl. a mutation that the key test catches), jest + e2e results with conditions, and the retention section.
