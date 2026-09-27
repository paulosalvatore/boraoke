# TICKET-106 — Make song search survive the 100-calls/day `search.list` cap

**Filed:** 2026-09-27, from a Tech-Lead report relayed via the Global TM: the YouTube search quota is being hit, capping the search-a-song flow at any real usage.
**Priority:** HIGH — this caps the product's core patron flow at a level no real venue night can live inside.
**Type:** Spike → build
**Size:** L
**Supersedes/continues:** TICKET-85 (the 2026-08-19 independence spike, PR #58). **Read TICKET-85's findings before doing anything here.**

## READ THIS FIRST — most of the obvious spike was already run, and its results still bind

The relayed brief proposed evaluating InnerTube libraries, Piped, Invidious, Playwright scraping and caching. **Four of those five were already investigated on 2026-08-19 under TICKET-85, by measurement rather than reputation, and the results were recorded on the board.** Re-running them unchanged would burn a spike to rediscover known answers:

- **Invidious — measured and rejected.** 11 registered instances checked, 5 clearnet, **zero with the API enabled**; 401/403 on all three healthiest.
- **Piped — measured and rejected.** **4 of 4 tested instances failed.**
- **Direct scraping — rejected on ToS grounds**, not on difficulty. (The brief independently guesses it is the weakest option; that agrees with the earlier call.)
- **Caching — already shipped.** `lib/search-cache.ts` ships a **12-hour** TTL for non-empty result sets and 10 minutes for empties (TICKET-55), two-tier L1-memory + Redis, with paging cached under the same TTLs so paging back and forth over an evening costs zero quota. "Add caching to slash calls" is largely done; the open question is its **measured hit rate in production**, which nobody has reported.
- **The per-IP drain hole is also closed.** TICKET-87 shipped a fail-closed cross-instance daily `search.list` spend cap (PR #65, merged 2026-08-20). Before it, one IP could drain the entire daily platform cap in ~35 seconds.

**These are five weeks old.** Instance-based ecosystems move, so a cheap bounded re-probe of Piped/Invidious is justified — but as a ten-minute re-check with a documented instance list, **not** as a fresh evaluation. If the re-probe finds them still dead, that is the end of it; do not spend the spike there.

## The approach TICKET-85 actually recommended, which the brief omits — and it is probably the answer

The quota model changed on **2026-06-01** and the two buckets are **fully decoupled**:

| Resource | Default/day | Boraoke's usage |
|---|---|---|
| `search.list` (own bucket) | **100 calls** | **the binding constraint** — 1 call per patron search |
| everything else (`videos.list`, `playlistItems.list`, `playlists.list`, `channels.list`) | **10,000 units**, 1 unit per call | **barely touched** |

So the product is starving in one bucket while sitting on a nearly untouched 10,000/day pool next to it. TICKET-85's recommendation followed directly: **harvest a karaoke song index via `playlistItems.list`, search it locally with fuzzy matching, and keep `search.list` only as a long-tail fallback.** Plus room-scoped "popular/recent here" shortcuts.

Why this is likely the strongest candidate and should be the spike's primary subject:

- It is **quota-abundant** — `playlistItems.list` bills 1 unit against the pool boraoke barely uses. A few hundred harvest calls builds an index of thousands of karaoke tracks for a rounding error of the daily allowance, refreshable nightly.
- It is **ToS-clean** — the official API, used as intended. Every alternative in the brief is either ToS-gray (InnerTube/youtubei.js reverse-engineers a private endpoint) or explicitly rejected (scraping).
- It **does not break when YouTube changes its web player**, which is the standing failure mode of every InnerTube library and the reason none of them can be a sole dependency.
- It **fits the product**: karaoke demand is a fat head of well-known songs, not a uniform sample of YouTube. A local index over curated karaoke playlists plausibly serves the large majority of requests with zero `search.list` spend.

Its honest weaknesses, to be tested rather than asserted: coverage of the long tail; index freshness; whether local fuzzy matching is good enough for patrons typing half-remembered Portuguese song titles on a phone; and the storage/infra cost of the index (Redis is already in place).

## Also do not lose this open question — filing the form may be a placebo

`work/youtube-quota-form.md` is **already drafted, corrected and filing-ready** (TICKET-90, PR #64 merged) and has been sitting unfiled since 2026-08-19 pending Tech-Lead pre-conditions. **This matters for the brief's framing that the form is "very complex, last resort": the expensive part — drafting a compliance-audit submission with every claim verified — is already done.** What remains is a Tech-Lead review and a submission.

But TICKET-85 left a genuinely unresolved question that decides whether filing is worth anything at all: **whether a granted extension raises the `search.list` call cap post-June, or only the old unit pool.** Google's public audit docs still describe the pre-June world. If an extension only grants more units, filing changes nothing, because units are not the constraint. **Answering that is cheap desk research and should happen in this spike** — it is the difference between "one form away from solved" and "the form is a placebo".

One stale line to fix before filing, per the form's own §6: §2 should describe TICKET-87's shipped platform-wide bound rather than the earlier "in progress" language.

## Spike scope (deliver before any build)

1. **Measure the actual problem.** What is the current production `search.list` spend per day, and what is the cache hit rate? The spend counter from TICKET-87 and the telemetry already exist. **We are about to design around a cap without having reported how close we run to it, or how much of the traffic the 12h cache already absorbs.** If the cache is at a high hit rate, the shape of the fix changes.
2. **Prototype the harvested index** — smallest slice that returns **real results**: harvest a handful of real karaoke playlists via `playlistItems.list`, index them, run local fuzzy search over realistic patron queries (including misspelled and partial Portuguese titles), and report hit rate against those queries plus the unit cost actually consumed.
3. **Evaluate `youtubei.js` honestly as the fallback tier** — does it work today, what breaks it, and what is the ToS exposure. It is the strongest of the brief's candidates and worth real assessment, but as a **fallback**, not the primary.
4. **Bounded re-probe** of Piped/Invidious against the five-week-old measurement. Document the instances tested.
5. **Answer the extension question** (does an approved audit raise the `search.list` call cap post-June?) with a primary source.
6. Short comparison across reliability / ToS risk / breakage exposure / latency / infra cost / effort, and a recommended layered design — most likely: local index primary → `search.list` fallback for the long tail → the existing cache in front of both.

## Escalate, do not decide alone

- **ToS-risk tolerance** for any InnerTube/reverse-engineered path. Boraoke is a public product intended to carry paying venues; this is a business risk, not an engineering preference.
- **Self-host vs public instance**, if any proxy path survives the re-probe.
- **Whether to file the quota form now**, given it is already filing-ready and the remaining cost is the TL's own review time.

## Acceptance (spike)

A committed report with: the measured current spend + cache hit rate; a working prototype returning real results for the top pick; the comparison table; a primary-sourced answer on the extension question; and a recommended layered design with its failure modes stated. No production code change in this ticket beyond what the prototype needs.
