# TICKET-124 — plan

**Approval:** the TM's dispatch brief (2026-10-14) is the approved design, plus two TM addenda the same day (option 1 re-harvest with the production key; Global TM data-minimisation + retention). No separate plan gate was requested.

## Approach

1. **Harvest** (`lib/karaoke-index/harvest.ts`, CLI `scripts/karaoke-index-harvest.ts`): seeds = karaoke-named channels in the production oracle, ranked by how many production rows they supplied. Per channel: `playlistItems.list` on the derived uploads playlist (UC→UU, saves `channels.list`), plus one `videos.list` (contentDetails,status) per page for duration and playability (embeddable, public, not BR-blocked, not a P0D stream). `assertNoSearchList` runs before every fetch, and a unit ledger enforces a hard cap.
2. **Storage**: Upstash Redis, one gzip+base64 key per channel shard with a 30-day TTL, plus a `ki:stamps` hash. Rows are `[videoId, title, duration]`; the channel title is stored once per shard.
3. **Query**: each instance loads the shards into memory (reloading hourly), builds posting lists plus a sorted vocabulary, and matches exact/prefix/bounded-fuzzy. Confidence is the mean per-token quality of the best full-coverage row.
4. **Routing**: cache → index (sing mode, first page, confidence ≥ threshold, ≥ N discriminating chars) → live. The index answer carries an `IDXLIVE` cursor, so "load more" escapes to live with no client change.
5. **Refresh**: Vercel Cron, daily, `/api/cron/karaoke-index`, guarded by `CRON_SECRET` (fail-closed). It refreshes the oldest channels within 400 units / 40 s. Expired shards are never served, and Redis also TTL-deletes them.
6. **Measurement**: `work/measurements/ticket-124/replay.ts` extends the TICKET-108 replay (same oracle, traces, graded queries and predicate) with the index tier, prints the threshold × minChars curve, and runs falsifiability controls.

## Risks

- Seeding bias: the channels come from the same production cache as the replay queries (channel level, not song level). Disclosed in the PR.
- Coverage of the long tail. The live fallback is unchanged, so a miss costs exactly today's price.
- n = 28 graded queries. Tune coarsely and don't overfit.
- Hobby cron limits (daily, 60 s). The per-run time/unit budget keeps each run inside them.

## Test strategy

Unit tests for the matcher, threshold boundary, routing, retention expiry (incl. a warm-instance expiry), refresh budget and the harvest guard. Route tests cover cache-in-front, index-answer-with-zero-fetch, fallback and escape. A mutation pass (threshold removed, tier order swapped) must turn a named test red. Full jest plus the e2e suite (`workers: 1`).
