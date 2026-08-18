# TICKET-85 — YouTube search independence: options analysis

**Type:** research spike, read-only. No product code, no config change, no dependency added.
**Date:** 2026-08-18
**Question (Tech Lead):** *"We also should look into alternative ways of doing YT search, not to just rely on official API availability."*

Every quota figure, terms clause and third-party reliability claim below is either **[VERIFIED]** against a primary source cited inline, **[MEASURED]** by a live probe run during this spike, or **[ESTIMATE]** — labelled explicitly. Nothing is asserted from memory.

---

## 0. The headline finding: the quota model changed under us on 2026-06-01

The premise this ticket was written on — *"`search.list` costs 100 units against a 10,000/day pool, so ~99 searches/day"* — **is no longer how the quota works.** It is stale in mechanism, though almost exactly right in magnitude.

**[VERIFIED]** https://developers.google.com/youtube/v3/getting-started and https://developers.google.com/youtube/v3/determine_quota_cost (both "Last updated 2026-06-01 UTC"):

> "Projects that enable the YouTube Data API have a default quota allocation of 100 `search.list` calls, 100 `videos.insert` calls, and 10,000 units per day combined for all other endpoints."

And on the quota-cost table, `search.list` is now listed not as a unit price but as:

> "100 quota per day. Each call costs 1 quota."

So the current shape is:

| Endpoint | Cost | Budget it draws from | Source |
|---|---|---|---|
| `search.list` | 1 unit/call | **its own 100 calls/day bucket** | [VERIFIED] determine_quota_cost |
| `videos.list` | 1 unit/call | the shared 10,000/day pool | [VERIFIED] determine_quota_cost |
| `playlistItems.list` | 1 unit/call | the shared 10,000/day pool | [VERIFIED] determine_quota_cost |
| `playlists.list` | 1 unit/call | the shared 10,000/day pool | [VERIFIED] determine_quota_cost |
| `channels.list` | 1 unit/call | the shared 10,000/day pool | [VERIFIED] determine_quota_cost |
| embedded playback (IFrame Player API) | **0** — not a Data API call at all | n/a | [VERIFIED] iframe_api_reference + determine_quota_cost |

**Why this matters more than it looks.** The old model coupled search and metadata: one search burned 101 of one shared 10,000 pool, so *everything* was scarce together. The new model **decouples them**. Search is capped at 100 calls/day and that cap is now effectively immovable by engineering. But every *other* read endpoint sits in a 10,000-calls/day pool that Boraoke currently uses for almost nothing — today the only consumers are the duration lookup in `searchYouTube()` and the embeddability pre-check in `checkEmbeddable()`, each 1 unit.

That is roughly **10,000 units/day of official, in-terms, currently-idle API budget**, sitting next to a search bucket that is 100/day and cannot be engineered around. The entire strategic answer to this ticket follows from that asymmetry: *stop trying to buy more `search.list`, and start spending the pool that is already free.*

### What is stale in our own code and docs

| Location | Says | Reality |
|---|---|---|
| `lib/search-cache.ts` header | "a YouTube Data API search burns ~101 quota units (search.list 100 + videos.list 1) against a 10,000/day default quota — ~99 searches/day TOTAL" | mechanism wrong since 2026-06-01; the ~99/day *conclusion* is coincidentally still right (now exactly 100/day) |
| `work/status/BOARD.md` (several rows) | "~99 searches/day", "each search costs ~101 units" | same |
| `work/youtube-quota-form.md` | "Current quota: 10,000 units/day ≈ 99 searches/day total… Requested quota: **1,000,000 units/day**" | the ask is denominated in a unit that no longer governs search. Filing this as-written asks for the wrong thing. |

None of this changed any *decision* that was made — the operating ceiling was ~99/day and is now 100/day. But the form cannot be filed until it is re-denominated (see §1).

### A second stale item in the form — and this one is a live risk

`work/youtube-quota-form.md`, "Compliance answers", states:

> "**Data storage:** … no API response caching beyond a 60-second search cache"

That was true when drafted. It **stopped being true on 2026-08-05**, when TICKET-55 / PR #39 merged and shipped a cross-instance Upstash cache with a **12-hour** TTL for non-empty results (`SEARCH_CACHE_TTL_MS` in `lib/search-cache.ts`). Filing a compliance form containing a false statement about data storage, into a process whose entire purpose is a compliance audit, is a materially bad idea.

The good news: **12 hours is comfortably legal.** **[VERIFIED]** YouTube API Services Developer Policies §III.E.4 (https://developers.google.com/youtube/terms/developer-policies):

> "API Clients may temporarily store limited amounts of Non-Authorized Data for as long as is necessary for the purposes of the API Client but not longer than 30 calendar days."
> "after 30 calendar days, the API Client must either delete or refresh the stored data."

So the fix is to tell the truth (12h cache, well inside the 30-day allowance), not to change the code. **This is a blocking pre-condition on §1 and the single most important line in this document after §0.**

---

## 1. File the quota increase

### What is actually involved

**[VERIFIED]** https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits (Last updated 2026-06-24):

> "If you would like to request additional quota beyond the default allocation, you must first complete an audit to show that your project is in compliance with the YouTube API Services Terms of Service."

The mechanism is the **YouTube API Services – Audit and Quota Extension Form**, https://support.google.com/youtube/contact/yt_api_form. **[VERIFIED]** the form URL and name; **[NOT VERIFIED]** its exact current field list — the form sits behind an interactive Google Support flow that could not be rendered in this spike. The existing draft in `work/youtube-quota-form.md` was clearly written against the real form, so treat its section headings as the better guide, not this report.

Note it is an **audit**, not a slider. You are asking Google to review the product against the Developer Policies, and the review is of the whole application, not the quota line.

### Timeline and odds

**[VERIFIED]** the docs commit to no SLA whatsoever. The only statement is:

> "A member of YouTube's API Services team will contact you as soon as possible."

**[VERIFIED]** there is no published approval rubric. The only stated standard is:

> "This gives YouTube visibility into the intended use cases of large projects and ensures that YouTube's API services are being used in a manner that is free from abuse."

**[ESTIMATE]** — reported real-world waits cluster in the weeks-to-months range, and I could not corroborate any specific figure against a primary source, so plan for "months, possibly never answered" rather than any particular number. **[ESTIMATE]** approval odds for Boraoke specifically: *moderate-to-good on the merits, unknown in practice.* The merits are genuinely strong — playback is the official IFrame embed, ads and controls are untouched, there is no download or proxy, the key is server-side only, and the use case (user-initiated search) is the canonical sanctioned one. The unknowns are that Boraoke is pre-revenue with thin usage evidence, and that the June 2026 tightening suggests Google is actively *reducing* search availability, not expanding it.

**One structural caution [ESTIMATE, and the honest weak point of this option]:** it is not established that the extension process even grants a larger `search.list` **call** allowance in the post-June-2026 model, as opposed to a larger *unit* pool for the other endpoints. The audit docs still describe the old world. Since the new `search.list` cap is expressed in calls rather than units, an approved extension might raise the 10,000 pool and leave the 100 search calls untouched. **I could not determine this from any primary source, and it is the single most important open question in this document.** The form's free-text justification should therefore ask, explicitly and in the new vocabulary, for *an increased `search.list` daily call allowance* — not "1,000,000 units/day", which under the current model is an ask for more of the resource we already have in surplus.

### Cost / risk / reversibility

- **Build cost:** ~1–2 hours to correct and file the existing draft. It is 90% written.
- **Run cost:** zero. It is free.
- **How it fails:** silently — no response, indefinitely. Or a denial, which is worse than a non-answer because it creates a record.
- **Legal/operational risk:** near zero, *provided the form is truthful*. The 60-second-cache line is the one landmine. A form containing a false data-storage claim invites exactly the audit finding you least want.
- **Reversibility:** fully reversible in the sense that filing costs nothing; **not** reversible in the sense that you cannot un-tell Google about your product. This is the one place in this document where I would slow down by an hour and get the text right.

**Verdict: yes, obviously do it — but it is not a plan.** It is a free lottery ticket with an unbounded timeline and a genuine risk that the thing it wins is not the thing we need. Nothing downstream should be sequenced behind it.

---

## 2. Harder caching, and the shared song index

This is where the answer actually is, and it splits into two very different ideas that are easy to conflate.

### 2a. A bigger/longer cache — real, but structurally limited

Today (`lib/search-cache.ts` + `lib/youtube-search.ts`) the cache key is:

```
`${regionCode}::${q.trim().toLowerCase().replace(/\s+/g, " ")}`
```

— i.e. **the normalized query string**. That means a cache hit requires two patrons to type *the same characters*. TTL is 12h for non-empty, 10min for empty.

The obvious knob is TTL. **[VERIFIED]** we may legally go to **30 days** (Developer Policies §III.E.4, quoted in §0), a 60× increase over today's 12h, with a delete-or-refresh obligation at the boundary. That is a real and cheap win and it is well within terms.

But here is the honest limitation, and it is the crux of this whole section:

> **Karaoke *demand* is extremely head-heavy. Karaoke *query strings* are not.**

The same song arrives as `evidencias karaoke`, `evidências`, `evidencias chitaozinho`, `karaoke evidencias playback`, `evidencia` (typo), `chitãozinho e xororó evidências`. Every one of those is a distinct cache key and a distinct 1-of-100 search call. The head-heaviness of the underlying catalogue is largely **destroyed by the free-text layer sitting in front of it**. Raising the TTL does not fix that; it only makes each *string* cheaper the second time it appears verbatim.

**[ESTIMATE]** — and I want to be blunt that this is an estimate with no local data behind it: string-level cache hit rate at 12h TTL is plausibly **20–40%** within a busy venue night (patrons do copy each other and retype the same hits), rising to maybe **40–60%** at a 30-day TTL once cross-night and cross-venue repeats accumulate. Song-level repeat rate — the fraction of *songs* that recur — is far higher, plausibly **80%+** for a few-hundred-song head. The gap between those two numbers is the entire prize, and a string cache cannot collect it.

### 2b. A persistent song index — the actual recommendation

Instead of caching *answers to queries*, build a local, searchable **catalogue of karaoke videos**, and answer most searches from it with **zero `search.list` calls**.

The part that makes this work — and the reason §0 matters — is how the index gets populated. **Not** by scraping, and **not** by burning search calls. By the endpoints that are already free:

**[VERIFIED]** `playlistItems.list` = 1 unit, `maxResults` accepts "0 to 50, inclusive" (https://developers.google.com/youtube/v3/docs/playlistItems/list). `playlists.list`, `channels.list`, `videos.list` = 1 unit each. All against the 10,000/day pool.

**[ESTIMATE — arithmetic, from verified inputs]** Brazilian karaoke/playback channels publish their catalogues as playlists. Harvesting them costs 1 unit per 50 videos. A **10,000-unit day therefore harvests on the order of 500,000 video records** — orders of magnitude more than a complete Brazilian karaoke catalogue. In practice you would build a 20–50k-song index in a **single afternoon**, using well under one day's already-idle pool, and never touch `search.list` to do it.

Refresh is equally cheap: **[VERIFIED]** the 30-day delete-or-refresh obligation applies, and re-harvesting the whole index costs a fraction of one day's pool, so a monthly refresh cron satisfies the policy comfortably.

Then local search over that index (Postgres full-text / trigram, or a small in-process fuzzy matcher over a few tens of thousands of rows) handles typos, accents, partial titles and artist-only queries — collapsing all six variants of "Evidências" onto one row. **That is how you capture the song-level head-heaviness that the string cache structurally cannot reach.** `search.list` then degrades from "the product's core interaction" to "the long-tail fallback when the index misses", which is exactly what 100 calls/day is adequate for.

### What data would confirm the hit rate — and why we don't have it

**I could not estimate the hit rate from real data, because there is none.** The only rollup in the repo, `work/telemetry/rollups/2026-W27.md`, ends with:

> "Generated from `--demo-seed` synthetic data (deterministic), not live traffic."

Worse, the current telemetry **cannot answer this question even with live traffic**: `search_performed` records only `props: results` (a count), and `song_queued` records only `kind` and `mode` (`lib/telemetry-types.ts`). Neither the query text nor the selected `videoId` is captured, so distinct-query rate, repeat rate and index hit rate are all unmeasurable today.

The minimal instrumentation that would settle it — and which respects the existing "free text is impossible by construction" guarantee in `work/telemetry/README.md`, so it needs no consent-banner rethink:

1. On `search_performed`, add a **short hash of the normalized query** (not the query) + a `cached: true|false` flag. Gives distinct-query count, repeat rate, and the *actual* current cache hit rate — the number this whole section is guessing at.
2. On `song_queued`, add the selected **`videoId`**. It is not personal data, it is already stored in the queue itself per the quota form, and it directly measures song-level head-heaviness — the number that decides whether the index is worth building.

**[ESTIMATE]** Roughly a half-day of work. It is the cheapest possible way to replace this section's estimates with facts, and it should be done *before* the index is built, not after.

### Cost / risk / reversibility

- **Build cost [ESTIMATE]:** TTL bump, ~1 hour. Telemetry, ~half a day. Index harvest + local search + fallback wiring, ~3–5 days.
- **Run cost:** the harvest is well inside the existing free pool. Storage for tens of thousands of rows is negligible; if it outgrows Upstash, a small Postgres is the natural home.
- **How it fails:** gracefully and in the right direction. An index miss falls through to `search.list` — i.e. exactly today's behaviour. There is no new outage mode; the worst case is the status quo.
- **Legal/operational risk:** **low, and this is the option's best property — it stays entirely inside the official API and the Terms.** Two constraints to honour explicitly: the 30-day refresh (a cron, [VERIFIED] requirement), and the Developer Policies clause against using API Services to "create, offer, or act as a substitute for, or substantially similar service to, any YouTube Applications" [VERIFIED]. A venue karaoke queue that plays through the official IFrame embed is not a YouTube substitute — but a searchable index is the one component that could be *mistaken* for one, so the index should stay an internal implementation detail (never a public browsable catalogue) and the form should describe it plainly rather than omit it.
- **Reversibility:** high. It is additive; delete the index and the product is exactly what it is today.

---

## 3. Third-party front-ends (Invidious, Piped)

I did not want to argue this from reputation, so I probed the live networks during this spike.

### Invidious — **[MEASURED, 2026-08-18]**

Fetched the official instance registry, `https://api.invidious.io/instances.json`:

- **11 instances listed in total.** Of those, only **5 are clearnet HTTPS** with monitoring data (the rest are I2P and Tor hidden services).
- **Instances exposing the API (`api: true`): ZERO.**

Then I called the search endpoint directly on the three healthiest clearnet instances:

| Instance | `GET /api/v1/search?q=karaoke+evidencias` |
|---|---|
| `invidious.nerdvpn.de` | **HTTP 401** |
| `inv.nadeko.net` | **HTTP 403** |
| `invidious.tiekoetter.com` | **HTTP 403** |

**The public Invidious search API is not available to us at all.** This is not a reliability concern to be mitigated — there is nothing to integrate against. **[VERIFIED]** the project's own docs (https://docs.invidious.io/instances/) now keep the list deliberately short "due to the recent YouTube issues" and direct users to self-host.

### Piped — **[MEASURED, 2026-08-18]**

Called `/search?q=karaoke&filter=videos` on four well-known public API instances:

| Instance | Result |
|---|---|
| `pipedapi.kavin.rocks` | **HTTP 526** (TLS failure at origin) |
| `pipedapi.adminforge.de` | **HTTP 301** to a non-API destination |
| `api.piped.yt` | **connection failed** |
| `pipedapi.leptons.xyz` | **HTTP 502** |

**Four of four failed.** Not one returned a result.

### Context [VERIFIED]

Google sent Invidious a cease-and-desist in June 2023 demanding shutdown within 7 days (TorrentFreak, https://torrentfreak.com/youtube-orders-invidious-privacy-software-to-shut-down-in-7-days-230609/). Since 2024, Google has systematically blocked datacenter IPs and deployed the "sign in to confirm you're not a bot" interstitial, which is what hollowed out the public instance networks.

Also worth stating plainly: these front-ends work by consuming YouTube's *internal* API without agreeing to any terms. Routing a commercial product's core interaction through them inherits every objection in §4 while adding a dependency on volunteer infrastructure we neither control nor pay for.

### Cost / risk / reversibility

- **Build cost:** irrelevant — there is no working endpoint to build against.
- **Run cost:** zero, because it does not run.
- **How it fails:** *mid-night, at a venue, with no warning.* An instance that worked in testing returns 403 at 22:30 on a Saturday. Even a health-checked multi-instance pool cannot fix a network where the measured availability of the required API is zero.
- **Legal/operational risk:** inherits §4's ToS exposure, plus reputational coupling to projects Google has already sent legal threats to.
- **Reversibility:** high (easy to remove) — but that is no consolation, because the failure lands on a paying venue in front of a room of people.

**Verdict: rejected on measured evidence, not on principle.** This is the clearest "no" in the document.

---

## 4. Scraping YouTube directly (including `yt-dlp`-style extraction)

### This violates YouTube's Terms of Service. Stated plainly, not softened.

**[VERIFIED]** https://www.youtube.com/t/terms, "Permissions and Restrictions". The Terms prohibit:

> "access the Service using any automated means (such as robots, botnets or scrapers)"

— except for public search engines complying with YouTube's `robots.txt`, or with YouTube's prior written authorisation. Boraoke is neither. The Terms further prohibit:

> "circumvent, disable, fraudulently engage with, or otherwise interfere with any part of the Service"

Scraping YouTube search results, or extracting via `yt-dlp`-style tooling, is a **direct violation of the Terms of Service**. This is not a grey area, not a "commonly done in practice" caveat, and not something the analysis below mitigates. **A commercial product doing this carries real business risk**: Boraoke charges venues, is publicly branded at `boraoke.com`, and — decisively — **holds a YouTube Data API key on an identifiable Google Cloud project that we are about to submit for a compliance audit (§1).** Scraping from the same product that is asking Google for more quota risks losing the API access we already have, on top of the ToS exposure itself. The two options are actively incompatible.

Note also that this route poisons §1: the audit asks about data practices, and a scraping component either has to be disclosed (guaranteeing denial) or concealed (a far worse posture).

### The practical picture, for completeness

Even setting the Terms aside — which we should not — it is a bad engineering bet:

- **[VERIFIED]** `yt-dlp` ships releases roughly every 1–3 weeks, many of which exist specifically to repair YouTube extraction breakage (https://github.com/yt-dlp/yt-dlp/releases). Every one of those is a potential live-venue outage on our side.
- **[VERIFIED]** Proof-of-Origin (PO) tokens are now required on effectively every video request; the community workaround is running a **companion token-provider daemon** alongside the extractor (https://yt-dlp.net/errors/po-token-required).
- **[VERIFIED]** YouTube's SABR delivery path and bot detection hit **datacenter IPs hardest** (yt-dlp issues #15793, #14390, #16821). Boraoke runs on Vercel — i.e. exactly the IP space that gets blocked first. Mitigating that means residential proxies, which adds cost, latency, and a further layer of deliberate circumvention.

### Commercial scraping-as-a-service (SerpApi, Apify, RapidAPI)

**[VERIFIED]** pricing exists — SerpApi from ~$25/1,000 searches (https://apiserpent.com/blog/serpapi-pricing-explained); Apify YouTube actors from ~$0.50–$5.00 per 1,000 results (https://apify.com/streamers/youtube-channel-scraper). Paying a vendor **does not launder the Terms problem** — these are scrapers, they are not authorised YouTube Data API resellers, and the restriction in the Terms is on how the Service is accessed, not on who runs the software. It converts a technical risk into a billed technical risk while leaving the legal exposure with us.

### Cost / risk / reversibility

- **Build cost [ESTIMATE]:** days, plus permanent maintenance — this is the option with unbounded ongoing cost.
- **Run cost:** proxy/vendor fees, plus engineering attention every few weeks, forever.
- **How it fails:** unpredictably, on Google's schedule, typically at peak traffic.
- **Legal/operational risk:** **highest in this document.** ToS violation; jeopardises the existing API key and the §1 audit; reputational and contractual exposure to venue customers.
- **Reversibility:** the *code* is reversible. **The risk is not** — a Google enforcement action, or a disclosure during an audit, cannot be rolled back by deleting a module.

**Verdict: rejected. Not "only if forced" — rejected**, because it is the one option that actively destroys another option we want (§1) and endangers the access we already have. See §7 for the only conditions under which this would even warrant re-examination.

---

## 5. Reducing dependence on search at all

The framing in the ticket is right, and under the new quota model it is *more* right than when it was written: **the cheapest search is the one that never happens.** With `search.list` capped at 100 calls/day by a mechanism we cannot engineer around, demand reduction is not a consolation prize — it is a first-class lever with the best cost/benefit ratio in this document.

Roughly in order of value per unit of effort:

**a. Venue-curated song lists / host pre-loaded set lists.** A host uploads or picks a set list before the night starts. **[ESTIMATE]** For a themed night ("anos 80", "sertanejo") this could plausibly cover the majority of the evening's songs at *zero* search cost, and it is a genuine venue-facing feature that makes the product more valuable, not a degradation. This is the rare case where the quota fix and the product roadmap point the same way.

**b. "Popular in this room" / "recently played here" shortcuts.** The queue store already holds `videoId` + title per room (90-day retention per the quota form). Surfacing the room's own history as tappable chips is **almost free to build, costs zero quota, and directly attacks the head of the demand curve** — the same songs recur within a venue. Best effort-to-value ratio on this list.

**c. A house "top karaoke songs" starter list.** A curated few-hundred-song grid shown *before* the search box. Zero quota, and it doubles as an onboarding improvement for a patron who does not know what to sing. Composes naturally with §2b (the index is exactly where this list comes from).

**d. Better paste-a-link UX.** Already the degraded-mode fallback (`/api/search` returns `{degraded: true}` and the client falls back to paste), and `checkEmbeddable()` already validates pasted links for 1 unit from the *non-search* pool. Promoting paste from "the thing that happens when search breaks" to a first-class, well-explained path costs nothing and works when everything else is exhausted.

**e. Search hygiene.** Longer debounce, a higher minimum query length (currently `MIN_QUERY = 3`), and no search-on-every-keystroke. Note the current rate limits (5/uuid/10s, 30/IP/10s in `lib/youtube-search.ts`) are **far too generous for a 100/day cap** — a single patron can legally burn 5 of the day's 100 searches in ten seconds. **[ESTIMATE]** This is a config-level change worth doing regardless of everything else in this document.

### Cost / risk / reversibility

- **Build cost [ESTIMATE]:** (b) and (e) are ~1 day combined. (a) and (c) are a few days each and are genuine product features with their own justification.
- **Run cost:** zero. All of it removes API calls rather than adding them.
- **How it fails:** it doesn't, really — worst case a shortcut goes unused and the patron searches as they do today.
- **Legal/operational risk:** none. Nothing here touches a third party or a term.
- **Reversibility:** total.

---

## 6. Other providers

**The binding constraint here is playback, and it disqualifies almost everything.** Boraoke's TV plays via the YouTube IFrame Player API. A search source that cannot return an **embeddable YouTube video id** is of essentially no use, because we cannot play what it finds. This rules out the entire music-metadata category as a *search replacement*:

| Source | Public API | Yields a YouTube video id? | Verdict |
|---|---|---|---|
| MusicBrainz | yes, free, no key | **partially** — [VERIFIED] it models "YouTube Channel" / "Free streaming" relationship types, so `url-rels` *can* carry a YouTube URL where editors have added one. Coverage is editor-dependent and skewed to artist-level channels, not per-song karaoke tracks. | useful for *canonicalising* an artist/title, not for finding a karaoke video |
| Deezer | yes, free, no key, ISRC lookup | no evidence of YouTube links [NOT VERIFIED either way] | metadata only |
| Spotify | free tier, but [VERIFIED] sharply restricted — extended access now requires a registered business + 250k MAU (2025), and Developer Mode requires Premium and caps at 5 test users (2026-02-06, https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security) | no | unusable at our stage |
| Last.fm | yes, free key, 5 req/s | no | metadata only |
| Genius / Discogs | yes | no | metadata only |

**But there is a real, non-obvious use for them**, and it is worth stating because it is the only way this section contributes: these APIs are excellent at the *disambiguation* half of the problem, which is precisely where §2b's index is weakest. A patron types `evidencia` — MusicBrainz or Deezer resolves that to the canonical artist + title (`Chitãozinho & Xororó – Evidências`) for free and with no YouTube quota at all, and *that* canonical string is then matched against the local index. In other words they are **query-normalisation infrastructure for the index, not a search provider.** Nice-to-have, clearly second-order, and only worth building if index hit rate proves disappointing after §2b ships.

**Also [VERIFIED] and worth recording:** the IFrame Player API requires no Data API key and consumes no Data API quota (https://developers.google.com/youtube/iframe_api_reference). Playback is *not* at risk from the quota ceiling at all — only discovery is. One caveat, [VERIFIED]: the Required Minimum Functionality policy requires the embedded player to send an HTTP `Referer` header for identification (https://developers.google.com/youtube/terms/required-minimum-functionality) — a compliance obligation, not a quota one, and worth confirming we satisfy before the §1 audit.

---

## 7. Recommended sequence

### Now (this week)

1. **Correct `work/youtube-quota-form.md` and file it.** Fix the false 60-second-cache statement to say 12 hours (truthful, and [VERIFIED] well inside the 30-day allowance). Re-denominate the ask from "1,000,000 units/day" into the post-June-2026 vocabulary: **an increased `search.list` daily call allowance**. Then file. It is free, slow, and must not block anything else.
2. **Tighten search hygiene** (§5e): reduce the per-uuid rate limit, lengthen the debounce, raise `MIN_QUERY`. Hours of work; the current 5-per-10s limit is indefensible against a 100/day cap.
3. **Instrument the two telemetry fields** (§2b): hashed normalized query + `cached` flag on `search_performed`; `videoId` on `song_queued`. This is the measurement that converts every [ESTIMATE] in this document into a fact, and it must land *before* the index is designed.
4. **Correct the stale quota arithmetic** in `lib/search-cache.ts`'s header comment and the board rows. Cheap, and it stops the wrong mental model propagating into the next ticket.

### Next (the actual fix)

5. **Ship "popular/recent in this room"** (§5b) — near-free, zero quota, attacks the demand head directly.
6. **Build the harvested song index** (§2b): populate via `playlistItems.list` at 1 unit per 50 videos from the free 10,000/day pool, local fuzzy search over it, fall through to `search.list` on a miss, monthly refresh cron for the [VERIFIED] 30-day obligation. **This is the structural answer** — it converts search from a metered external dependency into a local one.
7. **Raise the cache TTL** from 12h toward 30 days (§2a), with a delete-or-refresh boundary. Do this *after* step 3 tells us what the current hit rate actually is.
8. **Venue set lists / curated lists** (§5a, §5c) — real product features that also happen to eliminate searches.

### Only if forced

9. **Commercial search vendors** (§4) — only if the index misses badly *and* the quota request is denied *and* the business case justifies both the spend and the ToS exposure. I would want a specific, measured failure before revisiting this.

### Rejected

- **Invidious / Piped** (§3) — rejected on **measured** evidence: zero API-enabled Invidious instances, 4/4 Piped instances failing.
- **Direct scraping / `yt-dlp`** (§4) — rejected. Violates YouTube's Terms of Service, and endangers both the existing API key and the §1 audit.

### The single highest-leverage action

**Build the harvested song index (step 6).** It is the only option that changes the *shape* of the problem rather than the size of it: it moves the core interaction off the metered `search.list` bucket entirely and onto the 10,000/day pool that is already provisioned, already free, already in-terms, and currently almost entirely unused. Everything else on this list buys headroom; this one removes the dependency.

---

## 8. What would need to be true to revisit the rejected options

| Rejected | Would need to become true |
|---|---|
| Invidious / Piped | A stable, API-enabled instance network reappears (measurably: several instances with `api: true` and sustained uptime), **and** the ToS objection is resolved — which it would not be. Re-measure before ever reconsidering; do not rely on this document's numbers being current. |
| Direct scraping / `yt-dlp` | Realistically: **never**, while Boraoke is a commercial product holding a YouTube API key. It would take YouTube explicitly authorising the access in writing — at which point it stops being scraping. |
| Commercial scrapers (SerpApi/Apify) | Quota request denied, index hit rate measured below ~70%, and a venue-revenue case that absorbs both the per-search cost and the ToS risk. The risk does not go away by being outsourced. |
| Metadata providers as a search source | Only if one of them begins returning embeddable YouTube ids at karaoke-track granularity. Their real role (§6) is query normalisation feeding the index. |

---

## 9. Composition with TICKET-83 (mode-before-search + pagination)

TICKET-83 is changing search concurrently. Nothing recommended here conflicts with it, but **two things in it need attention in light of §0**, and the second is a genuine warning:

1. **Mode-before-search helps.** Deciding sing-vs-listen before searching lets the server construct a canonical query (e.g. appending "karaoke"/"playback" for sing mode) instead of relying on whatever the patron typed. That **increases normalization consistency, which directly raises cache hit rate today and index hit rate later.** It is a quiet win for this ticket. Recommend the mode be folded into the cache key so the two modes do not collide.

2. **Pagination is now materially more expensive than when TICKET-83 was scoped — please re-check its design.** **[VERIFIED]** each `search.list` call, including each `pageToken` continuation, is one call. **[INFERRED, not directly documented]** under the post-June-2026 model that means each additional page consumes **one of the day's 100 searches**. A patron paging three deep therefore spends 3% of the entire day's search budget across all venues. Under the old model an extra page was 100 of 10,000 (1%) — proportionally similar, but the new cap is *hard* and cannot be raised by caching. Recommendations: cap page depth, never prefetch the next page speculatively, and ensure the paged cache key includes the page token so a re-paged query is free. Caching paged results (already in TICKET-83's scope) is exactly right.

3. **No file conflicts with this ticket.** TICKET-85 is a report only — it touches no code. §7's steps 2–4 would land in `lib/youtube-search.ts`, `lib/search-cache.ts` and `app/api/search/route.ts`, which **are** TICKET-83's files, so those steps should be sequenced *after* TICKET-83 merges rather than developed in parallel.

---

## 10. Verification ledger

**[VERIFIED] against primary sources (URL cited inline):**
- The 2026-06-01 quota model change: 100 `search.list` calls/day in a dedicated bucket + 10,000 units/day for all other endpoints — confirmed independently on *two* Google pages (`getting-started`, `determine_quota_cost`).
- Per-call costs of `videos.list`, `playlistItems.list`, `playlists.list`, `channels.list` = 1 unit each.
- `playlistItems.list` `maxResults` range "0 to 50, inclusive".
- The audit/quota-extension process, the form name and URL, the absence of any SLA, and the absence of a published approval rubric.
- Developer Policies §III.E.4: the 30-day storage cap and the delete-or-refresh obligation.
- Developer Policies: the "substitute for, or substantially similar service to" prohibition.
- YouTube ToS "Permissions and Restrictions": the automated-access and circumvention prohibitions (quoted verbatim).
- IFrame Player API requires no Data API key and consumes no quota; Required Minimum Functionality `Referer` obligation.
- Google's June 2023 cease-and-desist to Invidious.
- `yt-dlp` release cadence; PO-token requirement; SABR/datacenter-IP exposure.
- Spotify's 2025/2026 API access restrictions.
- MusicBrainz models YouTube relationship types.
- SerpApi and Apify published pricing.

**[MEASURED] live during this spike (2026-08-18):**
- Invidious registry: 11 instances total, 5 clearnet, **0 with `api: true`**; search API returns 401/403 on all three healthiest instances.
- Piped: 4/4 tested public API instances failed (526 / 301 / connection failure / 502).

**[ESTIMATE] — explicitly not verified:**
- Cache hit rates (20–40% at 12h, 40–60% at 30d) and song-level repeat rate (80%+). No live data exists to ground these.
- Index build cost (~500k records per 10k-unit day) — arithmetic from verified per-call costs, not an observed harvest.
- Quota-request approval odds and timeline.
- All effort estimates.

**Could not determine:**
- **Whether a granted quota extension raises the `search.list` *call* cap at all under the post-June-2026 model, or only the 10,000-unit pool.** This is the most consequential open question here — it determines whether §1 is a real fix or a placebo. The audit documentation still describes the pre-June model. Only filing (or a direct answer from Google) will settle it.
- The exact current field list of the Audit and Quota Extension Form (interactive Google Support flow, not fetchable).
- Whether an API key alone (no OAuth) suffices for `playlistItems.list` on public playlists — the docs page showed only OAuth examples and did not state the key-only case either way. **This gates §2b and is a ~5-minute check with the existing prod key**; standard practice strongly suggests key-only works for public read, but I did not verify it and will not assert it.
- Whether Deezer, Last.fm, Genius or Discogs expose YouTube ids anywhere (no primary-source evidence either way).
- Any post-2023 Google legal action against Invidious.
- **Real Boraoke usage data of any kind** — the only rollup in the repo is explicitly synthetic (`--demo-seed`), and current telemetry captures neither query text nor selected `videoId`, so no live figure was available to this spike.
