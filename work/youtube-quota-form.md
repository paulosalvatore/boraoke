# YouTube Data API — Audit & Quota Extension Form (paste-ready answers)

> ⚠️ **NOT YET SUBMITTED — REQUIRES TECH-LEAD REVIEW BEFORE FILING.**
> This is a compliance-audit submission to Google. Everything below is drafted to be literally true as of the date in the status line; every factual claim is either **[VERIFIED]** against the code or a primary source cited inline, or explicitly labelled **[ESTIMATE]** / **[UNVERIFIED]**. Do not file it without re-checking the two things that can go stale under it: the cache TTLs in `lib/search-cache.ts`, and whether TICKET-87's daily spend counter has shipped (the text below says "in progress" — if it has merged by filing time, change that sentence).

**Status (2026-08-19, TICKET-90):** corrected and filing-ready, **not filed**. The API key itself is provisioned and live in prod (since 2026-07-07). Until an extension is granted, the platform operates under the default **100 `search.list` calls/day**.

**Product:** Boraoke — https://boraoke.com
**API key project:** the Google Cloud project holding the "Cantai Karaoke Credentials" key (that is the project's literal name in the Console — a pre-rename artifact, not a live product name).

---

## 0. The quota model this form is written against [VERIFIED]

Google changed the model on **2026-06-01**, and this section exists so the numbers below are read in the right denomination.

**[VERIFIED]** https://developers.google.com/youtube/v3/getting-started (Last updated 2026-06-01 UTC):

> "Projects that enable the YouTube Data API have a default quota allocation of 100 `search.list` calls, 100 `videos.insert` calls, and 10,000 units per day combined for all other endpoints."

**[VERIFIED]** https://developers.google.com/youtube/v3/determine_quota_cost (Last updated 2026-06-01 UTC):

> "The `search.list` and `videos.insert` methods have their own quota buckets. Each of these methods has a default daily limit of 100 per day. The quota cost is 1 per call."

So the two resources are **decoupled**, and only one of them constrains Boraoke:

| Resource | Default | Boraoke's usage |
|---|---|---|
| `search.list` calls/day (own bucket) | **100** | **the binding constraint** — a patron's search costs 1 call, or 2 if they explicitly ask for a deeper page (hard-capped at 2 — see §2) |
| all other endpoints (shared units/day) | 10,000 | ~1–2 units per search (`videos.list` durations), plus 1 unit per pasted-link embeddability check — a small fraction of the pool |
| embedded playback (IFrame Player API) | not a Data API call | **0** [VERIFIED] https://developers.google.com/youtube/iframe_api_reference |

**This form therefore asks for an increased `search.list` daily call allowance, not for more units.** More units would be more of the resource we already have in surplus.

---

## 1. Use case description (Seção: caso de uso / descrição do cliente da API)

> Boraoke (https://boraoke.com) is a shared karaoke-queue platform for any room with a TV and a group of people — bars, parties, residential-building common rooms, and company events. A host creates a room in about 30 seconds and displays a QR code; each guest scans it, joins with a nickname (and optionally a table number) from their phone browser with no app and no account, searches for a song, and adds it to the room's shared queue. The room's TV screen plays that queue **exclusively through the official YouTube IFrame Player API** — embedded playback only, with no downloading, no proxying, and no modification of YouTube's ads, branding, attribution, or player controls. A fairness rotation (full karaoke / two per table / one per person) decides the play order; it never touches how a video is played.
>
> We use the YouTube Data API v3 for two closely related read purposes, both driven by a patron action: **user-initiated song search**, and a **metadata lookup for the video a patron chooses**. A search issues one `search.list` call (or is served entirely from our cache), plus one `videos.list` call to fetch the durations of the returned ids so we can display them. Patrons may also paste a YouTube link directly instead of searching; that path issues one `videos.list` call to verify the video is embeddable and consumes no `search.list` quota at all. We use no other endpoints, and we never write to the API.
>
> Searches are debounced client-side (400 ms) with a 3-character minimum, cached server-side across all serverless instances, hard-capped at two `search.list` calls per query, never prefetched, and rate-limited per patron **and** per IP. The API key is read server-side only, inside an API route, and is never exposed to the client bundle (it is not a `NEXT_PUBLIC_*` variable and is never serialised into any response).

---

## 2. Quota calculation and the request (Seção: justificativa / volume)

### What we have today

Default allocation: **100 `search.list` calls/day for the entire platform, across every venue combined** — not per venue, not per room. The separate 10,000-unit/day pool is barely touched and we are **not** requesting an increase to it.

### What a single venue night actually needs

**[ESTIMATE — stated as an estimate on purpose.]** We do not yet have live query-level telemetry (our current events record a result *count*, never the query text), so the following is modelled from the product's shape rather than measured. We would rather present it as an estimate than present a measured-sounding number we cannot support.

- 20–40 guests per venue night × 2–4 songs each × 1–3 search attempts per song ≈ **40–480 patron search requests per venue night** (low end: 20 × 2 × 1; high end: 40 × 4 × 3).
- Client-side debounce (400 ms) and the 3-character minimum already collapse keystroke bursts into whole-query requests before any of these reach the server.
- Our cross-instance cache then absorbs repeated *identical* queries. **[ESTIMATE]** we model a 20–40% hit rate within a single evening; karaoke demand is highly repetitive at the *song* level, but patrons type the same song many different ways, so string-level hits are far rarer than song-level repeats.
- A minority of queries spend a second call when the patron asks for a deeper page; that is capped at 2 and pushes the result toward the upper end of the range rather than beyond it.
- Net: roughly **25–380 `search.list` calls per venue night, from one venue** — a wide band because it is a model, not a measurement. A **central case of ~150 calls per venue night** is what we size the request against.

**A single active venue can therefore exhaust the entire platform-wide daily allowance in one evening, several times over.** That is the concrete problem this request addresses.

### What we are requesting

| Field | Request | Basis |
|---|---|---|
| `youtube.search.list` — total per day | **5,000 calls/day** | 10–20 concurrent early-access venues × the ~150-call/venue-night central case ≈ 1,500–3,000/day, with the remainder as headroom for busier-than-modelled nights and for growth within the early-access period |
| `youtube.search.list` — peak per minute | **100 calls/minute** | searches cluster at the start of an evening and after each song change; 20 venues × a few concurrent searches each |
| All other endpoints (combined units/day) | **no increase requested** — the default 10,000/day is sufficient | our only consumers are duration lookups and embeddability checks, at 1 unit each |
| `videos.insert` | **not used** — no increase requested | Boraoke never uploads to YouTube |

We have deliberately sized this to what the product actually needs during early access rather than asking for a round large number.

### What we have already done to reduce consumption [VERIFIED — all shipped and in production]

These are not plans; each is verifiable in the codebase today.

- **A 12-hour cross-instance search cache.** A query answered once is answered from shared storage for every serverless instance for the next 12 hours, instead of each instance re-spending a call on the same question (`SEARCH_CACHE_TTL_MS` in `lib/search-cache.ts`). Empty result sets are cached for only 10 minutes so a transient miss is never pinned. API errors are never cached.
- **`maxResults` raised to 50, the API maximum.** `search.list` is billed per call regardless of `maxResults`, so one call now returns 50 candidate videos, which the client reveals 8 at a time — roughly six pages of results for the cost of one call, where previously a patron hit a dead end after 8 rows and searched again.
- **A hard cap of two `search.list` calls per query, ever** (`MAX_SEARCH_PAGES` in `lib/youtube-search.ts`). A patron who has looked at 100 candidates cannot spend a third call; the UI stops offering more.
- **Nothing is ever prefetched.** A deeper page is fetched only after a deliberate tap, so we never spend a call on results nobody scrolls to.
- **Paged results are cached under their own key**, so paging forward and back over an evening costs zero additional quota.
- **Debounce and minimum query length.** 400 ms debounce, 3-character minimum — no search-on-every-keystroke.
- **Dual-bucket rate limiting**, per anonymous patron id *and* per IP (a sliding window on each), so no single client or single host can issue searches at an unbounded rate. To be precise about its scope: this limiter is per serverless instance and is a burst control, not a platform-wide daily bound — the cross-instance daily spend counter described immediately below is the piece that provides that bound, and it is not yet shipped.
- **Paste-a-link is a first-class path** that bypasses search entirely and costs no `search.list` quota.

**In progress (not yet shipped at the time of writing):** a cross-instance **daily `search.list` spend counter** that tracks the platform-wide daily total across all serverless instances and refuses further searches at a safety margin below the cap, so the allowance can never be silently drained by one misbehaving client. **Planned, not started:** a locally-harvested karaoke song index, populated via `playlistItems.list` from the separate 10,000-unit pool, so that most searches are answered locally and `search.list` becomes a long-tail fallback rather than the core interaction. We mention the index explicitly rather than omit it: it would be an internal implementation detail behind our own search box, never a publicly browsable catalogue.

---

## 3. Compliance answers

- **Data displayed:** for search results, only the video title, channel name, thumbnail, and duration. A selected video plays unmodified in the official IFrame embed.
- **Data storage — API responses.** We cache `search.list`/`videos.list` responses server-side in Redis so repeat queries do not re-spend quota. **Non-empty result sets are cached for 12 hours; empty result sets for 10 minutes; API errors are never cached.** There is additionally a short per-instance in-memory cache (60 seconds, bounded to 100 entries) that sits in front of the shared one. Shared-cache entries are deleted automatically at their TTL; the in-memory tier's entries are never served past their 60-second TTL and are evicted on the next read or by the size bound. This is well inside the 30-day limit in the YouTube API Services Developer Policies §III.E.4 ("API Clients may temporarily store limited amounts of Non-Authorized Data … but not longer than 30 calendar days").
- **Data storage — queue contents.** When a guest adds a song, we store the `videoId` and title in that room's queue so the TV can play it and the room can see what is coming. **These entries currently have no automatic expiry**; they persist until the entry is played and removed, or the room is deleted. We are treating that as an item to fix rather than to describe loosely: we intend to add an explicit retention bound to room/queue data. Separately, our anonymous product-analytics events already carry a hard 90-day expiry.
- **No media is ever downloaded, proxied, or stored.** We store identifiers and display metadata only.
- **User data:** guests are anonymous — a random UUID plus a self-chosen nickname, and optionally a table number. No Google or YouTube account data is accessed, no OAuth is used, no YouTube account features are used. The application uses an API key only.
- **No modification of playback:** ads, branding, attribution and player controls are untouched; the TV screen is a fullscreen official embed.
- **Monetization:** the platform is free during early access. Any future paid plan charges venues for venue tooling (rotation control, room management, analytics) and never for YouTube content, and never places advertising against YouTube playback.
- **Public accessibility:** the product is publicly accessible at https://boraoke.com with no account required; a reviewer can create a room and exercise the full flow without credentials.

---

## 4. Open question to be aware of before filing — [PARTIALLY RESOLVED]

The concern raised by the TICKET-85 spike was that a granted extension might raise only the 10,000-unit pool and leave the 100-call `search.list` cap untouched, making this filing a placebo.

**What we were able to confirm.** The live Audit and Quota Extension Form (https://support.google.com/youtube/contact/yt_api_form) contains **dedicated `youtube.search.list` "Total Per Day Quota" and "Peak Per Min Quota" fields, separate from the combined all-other-endpoints total** — its own instructions state that if additional quota is needed for `search.list` and `videos.insert`, it must be specified separately from the total quota box. So the ask in §2 **does** map onto a field Google's current process actually evaluates, and the request is expressible in the correct denomination. *(Confirmed by two independent retrievals of the live form on 2026-08-19, and consistent with Google's own statement that these methods have their own quota buckets.)*

**What remains unconfirmed.** Whether Google in practice *grants* increases above the 100/day `search.list` default, and at what magnitude, is **[UNVERIFIED]** — there is no published approval rubric, no published SLA, and no primary source stating what a granted `search.list` allowance looks like. Google's only commitment is that "a member of YouTube's API Services team will contact you as soon as possible."

**Practical consequence:** filing is worth doing — it is free, it asks for the right resource in the right field, and the product's merits are genuinely strong. But **nothing should be sequenced behind an approval**, and the demand-reduction work in §2 remains the real answer regardless of the outcome.

---

## 5. Seção 7 (declarações)

Standard consents (Terms of Service, privacy, developer policies, termination understanding, accuracy of the information provided, data-use/review consent, support-recording consent) — tick all and submit. Nothing in the use case above conflicts with any of them.

**Accuracy declaration note:** the "accuracy" checkbox is the reason this document is written the way it is. Everything asserted above is true as written at the time of filing, and anything we could not verify is labelled rather than smoothed over.

---

## 6. Pre-filing checklist for the Tech Lead

- [ ] Re-confirm `SEARCH_CACHE_TTL_MS` is still 12 h and `SEARCH_CACHE_EMPTY_TTL_MS` still 10 min in `lib/search-cache.ts`.
- [ ] Update §2's "in progress" line if TICKET-87 (daily spend counter) has merged by filing time.
- [ ] Decide whether to add a retention bound to room/queue data **before** filing, and if so update §3's queue-storage answer to state it.
- [ ] Confirm the privacy-policy and terms URLs the form asks for exist and are reachable.
- [ ] Confirm the legal/organisation details (legal name, address, business category) the form requires — this document does not contain them.
- [ ] Sanity-check the requested numbers in §2 against the venue count actually expected in the next quarter.
