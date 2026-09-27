# TICKET-108 — Stop billing a `search.list` call per keystroke (the actual quota fix)

**Filed:** 2026-09-27, from the TICKET-106 spike.
**Priority:** HIGH — this is the fix for the quota exhaustion the Tech Lead reported, and it is the cheapest one available.
**Type:** Performance / quota
**Size:** M
**Prior art:** `work/reports/TICKET-106-spike.md` (branch `ticket/106-search-quota`). Read it before starting — it carries the production measurements.

## The finding this ticket exists to act on

The YouTube quota exhaustion is **not a quota-size problem**. Measured against production:

- `sb:2026-09-26 = 90` — the daily `search.list` budget was genuinely exhausted.
- **124 searches → 90 billed calls → 24 songs queued = 3.75 billed calls per song.** The ratio holds on both busy days ever recorded (4.2 and 5.2).
- The product has never needed more than ~25 songs/day. **90 calls/day is only "too few" because each queued song costs four to five of them.**
- **Cause:** `components/SongSearch.tsx` searches as you type on a `DEBOUNCE_MS = 400` debounce, fired from a `useEffect` on `[input]`. Every typing pause longer than 400ms bills a call. The live cache keys are keystroke prefixes — `esc → escu → escur → … → escurinho do cinema` consumed **12 of the platform's 90 daily calls for one song title**; `zé r → zé ramalho` cost 5 within a 1-second spread.
- **The existing 12h cache cannot help**, because each prefix is a string nobody has ever typed before. Measured hit rate: 27%.

Removing this waste yields roughly **4x headroom** for hours of work, with no new dependency and no ToS surface — which is why it outranks every option in the original independence brief (harvested index, InnerTube, proxies), all of which are now deferred.

## The approach to try FIRST, because it avoids a product trade

The obvious framing is "search-as-you-type vs search-on-submit", but that is a genuine product-feel decision and the Tech Lead's to make. **Try to make it unnecessary:**

**Only issue a new API call when the query is not an extension of one we already have results for; filter client-side while the patron keeps typing.** `escur` fetches once; `escurinho`, `escurinho do`, `escurinho do cinema` filter the held result set locally. This preserves as-you-type behaviour exactly and should capture most of the 4x.

Secondary, complementary levers worth measuring rather than assuming: a longer debounce, and a higher minimum query length (currently ≥3 chars).

## The guardrail that decides whether this ships — do not skip it

**Measure result QUALITY, not just billed calls.** A short prefix's top-N may simply not contain the song a full-string search would have returned, in which case client-side filtering silently makes results worse while the quota graph looks great. That is a false win of exactly the kind this product has been bitten by before.

So report **both**:
1. **Billed calls per queued song**, before and after (the spike's baseline is 3.75, with 4.2 and 5.2 on the two busy days).
2. **Result quality against the same 32 real production queries the spike used** (`work/spikes/ticket-106/queries.mjs`) — hit@10 / relevance, prefix-filtered versus full-string search.

**If quality holds, ship it.** **If quality measurably degrades, stop and report up** — it then becomes a genuine as-you-type-vs-on-submit feel decision for the Tech Lead, and it is not ours to take. Do not quietly accept degraded results to keep the billing win.

## Constraints

- `SongSearch.tsx` carries deliberate TICKET-83 structure: the live mode is read through a ref precisely so a mode flip "can never re-trigger a debounce, a fetch, or a quota charge" (see its comment at L120-123). **Do not break that property** — a change that reintroduces a fetch on mode flip would silently undo an earlier quota fix.
- A pasted YouTube URL/ID is resolved locally with no API call (`parseYouTubeVideoId`). Keep it that way.
- The 12h cache (`lib/search-cache.ts`) and TICKET-87's fail-closed daily spend cap (`lib/search-budget.ts`) both stay in place. This change reduces demand; it does not replace either bound.
- Jest is node-env only (no jsdom): the prefix/extension decision logic belongs in a **pure helper** that can be unit-tested directly, not buried in the component.
- Before writing tests, read **`prove-your-test-can-fail`**. A test asserting "fewer calls" that passes against the current per-keystroke code proves nothing.

## Deferred, deliberately (do not build these here)

The harvested `playlistItems` index (proven: 741 units → 36,372 songs, zero `search.list`, hit@10 = 66%) is kept as a **proven fallback** if this fix is insufficient — its measured value was largely "the index exists" (a naive substring baseline beat the fuzzy matcher on partial words), so building it out now would be premature. `youtubei.js` and the Piped/Invidious proxies stay disqualified (datacenter-IP blocking with "no known solution", and `/search` degrading to silent empty results).

## Acceptance

Billed calls per queued song drop materially from the 3.75 baseline, with the number reported from a real measurement rather than reasoning; result quality against the spike's 32 production queries is reported alongside it and does not measurably degrade; the TICKET-83 no-fetch-on-mode-flip property still holds; jest + e2e + both floor gates green.
