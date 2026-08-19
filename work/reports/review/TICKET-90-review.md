# TICKET-90 — Reviewer gate report (opus, clean context)

**Target:** `work/youtube-quota-form.md` on `ticket/90-quota-form-correction` (worktree `.worktrees/ticket-90`, HEAD `958e27e`).
**Reviewer method:** every factual assertion in the document was checked independently against the code in this worktree, or against a primary source retrieved live. Nothing was taken on the document's word.

## Verdict: **CHANGES REQUESTED**

The two blocking errors TICKET-90 exists to fix are **both genuinely fixed and correctly stated**: the false "60-second search cache" retention claim is replaced with the true 12h/10min/60s tiering, and the ask is re-denominated from "1,000,000 units/day" to a `search.list` daily-call allowance with an explicit "no increase requested" on the unit pool. The `[VERIFIED]` / `[ESTIMATE]` / `[UNVERIFIED]` labelling discipline is real and mostly well applied, and both Google quotations reproduce verbatim.

It is **not** approved to file as-is because of one MEDIUM accuracy defect (a shipped safeguard described as stronger than the code makes it, under a heading that asserts everything under it is verified and in production) plus an arithmetic error in the quota justification. Both are small edits. In a document whose whole thesis is "everything here is literally true", a safeguard overstated by construction is exactly the class of defect this gate exists to catch.

---

## 1. Cache TTLs — independently verified from code

| Constant | Value | File:line |
|---|---|---|
| `SEARCH_CACHE_TTL_MS` (Redis, non-empty results) | `12 * 60 * 60 * 1000` = **12 hours** | `lib/search-cache.ts:64` |
| `SEARCH_CACHE_EMPTY_TTL_MS` (Redis, empty results) | `10 * 60 * 1000` = **10 minutes** | `lib/search-cache.ts:67` |
| `CACHE_TTL_MS` (per-instance in-memory L1) | `60_000` = **60 seconds** | `lib/youtube-search.ts:312` |
| `CACHE_MAX` (L1 entry cap, LRU) | `100` | `lib/youtube-search.ts:311` |

TTL selection is at `lib/search-cache.ts:193-195` (non-empty → 12h, empty → 10min). Errors are never cached: the route only calls `setCachedSearchPage` on the success path (`app/api/search/route.ts:154-157`); every throw returns before it (`:160-166`).

**The document states all three tiers correctly** (§2 bullet 1 and §3 "Data storage — API responses"). Upstash is confirmed provisioned in Vercel Production (`work/status/MANAGER-LOG.md:256`, `work/status/BOARD.md:153`), so the "across all serverless instances" framing holds in prod; the memory-only path is the fail-open/dev degradation (`lib/search-cache.ts:77-83`).

## 2. Denomination of the ask — correct

The document asks for **`search.list` calls/day (5,000) and peak calls/minute (100)**, states **"no increase requested"** for the combined 10,000-unit pool, and states **`videos.insert` not used**. That is the right resource under the post-2026-06-01 model, and it explicitly declines an increase it does not need. §0's framing ("more units would be more of the resource we already have in surplus") is correct and matches the code's own comments (`lib/youtube-search.ts:4-11`, `lib/search-cache.ts:6-12`).

## 3. Per-claim verification table

| # | Claim (document) | Verified against | Result |
|---|---|---|---|
| 1 | Non-empty cache TTL 12h; empty 10min; errors never cached | `lib/search-cache.ts:64,67,193-195`; `app/api/search/route.ts:154-166` | **OK** |
| 2 | Additional per-instance in-memory cache, 60s, in front of the shared one | `lib/youtube-search.ts:312`; `lib/search-cache.ts:156-167` | **OK** |
| 3 | Google: "default quota allocation of 100 `search.list` calls, 100 `videos.insert` calls, and 10,000 units per day combined for all other endpoints" (Last updated 2026-06-01) | Live retrieval of https://developers.google.com/youtube/v3/getting-started | **OK — verbatim match, date matches** |
| 4 | Google: "`search.list` and `videos.insert` … have their own quota buckets … default daily limit of 100 per day. The quota cost is 1 per call." (Last updated 2026-06-01) | Live retrieval of https://developers.google.com/youtube/v3/determine_quota_cost | **OK — verbatim match, date matches** |
| 5 | Extension form has dedicated `youtube.search.list` "Total Per Day Quota" / "Peak Per Min Quota" fields separate from the combined total, and instructions saying `search.list`/`videos.insert` must be specified separately | Live retrieval of https://support.google.com/youtube/contact/yt_api_form — form renders Specialized Quota Fields for `youtube.search.list` (Total Per Day, Peak Per Min, Detailed Justification) and the instruction "This quota can be used for all endpoints except search.list and videos.insert. If you need additional quota for search.list and videos.insert you must specify the quota required for each of these methods separately below." | **OK — corroborated independently by this reviewer** |
| 6 | Whether Google *grants* above the 100/day default, and at what magnitude, is unverifiable | No primary source found; no published rubric or SLA located | **OK — correctly labelled `[UNVERIFIED]`** |
| 7 | `maxResults` = 50, the API maximum | `lib/youtube-search.ts:85` (`SEARCH_DEFAULTS.maxResults: 50`) | **OK** |
| 8 | Client reveals 8 at a time → "roughly six pages" per call | `lib/youtube-search.ts:91` (`CLIENT_PAGE_SIZE = 8`), `components/SongSearch.tsx:20` (`PAGE_SIZE = 8`); 50/8 = 6.25 | **OK** |
| 9 | Hard cap of two `search.list` calls per query, ever | `lib/youtube-search.ts:112` (`MAX_SEARCH_PAGES = 2`); server-enforced at `app/api/search/route.ts:78-94` (page bound **and** page/pageToken agreement, so page=1+deep-cursor cannot sidestep it); client-enforced at `components/SongSearch.tsx:191` | **OK — enforced server-side, not just in the UI** |
| 10 | Nothing is ever prefetched | `components/SongSearch.tsx:184-223` — `loadMore` reveals already-fetched rows first and only fetches on a tap once they are exhausted; no fetch on mount/scroll/idle anywhere in the component | **OK** |
| 11 | Paged results cached under their own key; paging back costs zero quota | `lib/youtube-search.ts:336-349` (`cacheKey` folds `pageToken`, uppercase `P:` marker to prevent forgery); `app/api/search/route.ts:142-151` | **OK** |
| 12 | 400 ms debounce, 3-character minimum | `components/SongSearch.tsx:10` (`DEBOUNCE_MS = 400`), `:11` (`MIN_CHARS = 3`), `:277`, `:292`; server-side `MIN_QUERY = 3` at `app/api/search/route.ts:36,107` | **OK — enforced both client and server side** |
| 13 | Dual-bucket rate limiting, per anonymous patron id **and** per IP | `lib/youtube-search.ts:413-415,448-455`; called at `app/api/search/route.ts:122` before any Data API call | **OK as to existence** — but see DEFECT-1 for the efficacy claim attached to it |
| 14 | API key read server-side only, not a `NEXT_PUBLIC_*` var, never serialised into a response | `YOUTUBE_API_KEY` appears only at `app/api/search/route.ts:132` and `app/api/queue/route.ts:237`, both server routes; repo-wide `NEXT_PUBLIC` grep returns only `NEXT_PUBLIC_GIT_SHA`; `lib/youtube-search.ts` never imports env (key is passed in); no response body includes it | **OK** |
| 15 | Room/queue entries currently have **no** automatic expiry | `lib/rooms.ts:316-317` ("Rooms are never deleted yet, so the counter is monotonic"); no `expire`/`setex`/`px` anywhere in `lib/store/upstash.ts`, `lib/store.ts`, `lib/store/memory.ts` | **OK — the previous draft's 90-day claim is correctly retracted** |
| 16 | Queue stores `videoId` and title | `lib/store/types.ts:15-30` (`QueueEntry { videoId, title?, nickname, patronUuid, table?, mode, submittedAt }`) | **OK** |
| 17 | Analytics events carry a hard 90-day expiry | `lib/telemetry-types.ts:93-95` (`TELEMETRY_RETENTION_DAYS = 90`), applied via `expire()` at `lib/telemetry-store.ts:161-163` | **OK** |
| 18 | Pasted link costs no `search.list` quota; issues one `videos.list` embeddability check | `components/SongSearch.tsx:246-274` (paste resolved purely client-side by `parseYouTubeVideoId`, zero API calls at search time); the 1-unit check happens at queue-add and only for the paste path — `app/api/queue/route.ts:217,232-246` (`if (isPaste)`), `lib/youtube.ts:120-152` (`part=status`, 1 unit, fail-open to "unknown") | **OK** |
| 19 | Search results display only title, channel name, thumbnail, duration | `lib/youtube-search.ts:24-32` (`SearchResult` has exactly those five fields incl. `videoId`) | **OK** |
| 20 | Events record a result *count*, never the query text (hence no live query telemetry) | `app/api/search/route.ts:145,158` — `props: { results: <count> }`, query never passed | **OK — and this correctly justifies the `[ESTIMATE]` labelling** |
| 21 | Product is venue-agnostic: bars, parties, residential common rooms, company events; QR join, no app, no account; room in ~30s | `messages/pt-BR.json:17-20` (`chipBar` "No bar", `chipParty` "Na festa", `chipCondo` "No condomínio", `chipCompany` "Na empresa"), `:22` ("escaneia o QR … Sem app, sem cadastro"), `:24` ("pronta em 30 segundos"), `:262` | **OK — repositioning is genuinely reflected in shipped UI copy, not just in this document** (`README.md`'s "No YouTube search" line is stale and was correctly ignored) |
| 22 | Rotation modes: full karaoke / two per table / one per person | `lib/rotation-modes.ts:17` (`"full-karaoke" \| "per-table-2" \| "per-person-1"`) | **OK** |
| 23 | Guests anonymous: random UUID + self-chosen nickname + optional table number; no OAuth, API key only | `lib/store/types.ts:15-30`; `app/api/search/route.ts:44-45,99-105` (UUID-shaped, or literal `anon`); no OAuth on any API-consuming path | **OK** |
| 24 | Publicly accessible at https://boraoke.com, no credentials needed to exercise the flow | `app/metadata.ts:5` (`SITE_URL = "https://boraoke.com"`); repeated live HTTP/2 200 verifications in `work/status/MANAGER-LOG.md` | **OK** |
| 25 | API key provisioned and live in prod since 2026-07-07 | `work/status/BOARD.md:153-154` ("key SET in prod (2026-07-07)") | **OK** |
| 26 | TICKET-87 daily spend counter "in progress, not yet shipped" | `work/tickets/TICKET-87-search-daily-spend-counter.md` exists (filed 2026-08-19); branch `ticket/87-search-daily-spend-counter` exists locally **and** on `origin`; **no spend-counter code exists in this branch** (no daily-counter symbol in `lib/`, `app/`; `lib/rate-limit-counter.ts` is consumed only by `lib/host-auth.ts` and `lib/room-create-throttle.ts`, not by the search path) | **OK** |
| 27 | Harvested song index "planned, not started" | No `playlistItems` usage anywhere in `lib/`/`app/` | **OK** |
| 28 | Rate-limiting "so a single client cannot burst against the allowance" (§2, under a heading asserting everything below is shipped and in production) | `lib/youtube-search.ts:395-417` — the limiter is a **per-process in-memory `Map`**, explicitly documented as "best-effort per instance"; it is *not* the cross-instance `lib/rate-limit-counter.ts` used elsewhere. `work/tickets/TICKET-87-*.md` exists precisely because this limiter does not bound platform-wide spend | **DEFECT-1 (MEDIUM)** |
| 29 | "20–40 guests × 2–4 songs × 1–3 attempts ≈ 80–480 requests" | Arithmetic: minimum product is 20 × 2 × 1 = **40**, not 80 | **DEFECT-2 (LOW-MEDIUM)** |
| 30 | 5,000/day = "10–20 venues × ~150–250 calls/venue-night (midpoint of the range above), plus headroom for growth" | 20 × 250 = 5,000 exactly — the request equals the top of its own stated basis, so no headroom is actually included; and 150–250 is an interior band, not the midpoint of the stated 50–380 range (midpoint 215) | **DEFECT-3 (LOW)** |
| 31 | §0 table: "one patron search costs 1" | A single query may spend **2** calls (`MAX_SEARCH_PAGES = 2`), which §1/§2 do disclose; the venue-night model also converts patron *requests* to calls 1:1 with no allowance for the second page | **DEFECT-4 (LOW)** |

---

## 4. Defects, ranked

### DEFECT-1 — MEDIUM — the search rate limiter is described as a stronger safeguard than the code provides
**Where:** §2, "What we have already done to reduce consumption **[VERIFIED — all shipped and in production]**", bullet: *"Dual-bucket rate limiting, per anonymous patron id and per IP, so a single client cannot burst against the allowance."*

**Why it is a defect:** the limiter (`lib/youtube-search.ts:413-417`) is a per-process in-memory `Map`, and its own header comment calls it "best-effort per instance". On Vercel, requests fan out across many lambda instances, each with its own empty buckets — so the limiter constrains a client *per instance*, not against the platform-wide 100/day allowance. Elsewhere in this codebase the cross-instance primitive (`lib/rate-limit-counter.ts`) is used for exactly this purpose, and the search path deliberately does not use it. TICKET-87 exists because of this gap. Under a heading that asserts everything below it is verified-and-in-production, the clause "so a single client cannot burst against the allowance" is the one statement in §2 that the code does not support.

**Suggested fix (document only):** keep the bullet, drop the causal clause, and state the bound honestly — e.g. *"Dual-bucket rate limiting, per anonymous patron id and per IP (5 requests / 10 s per patron, 30 / 10 s per IP), applied before any Data API call. It is per-instance and best-effort; the cross-instance platform-wide daily spend cap is the in-progress work described below."* That is both true and stronger rhetorically, because it pairs the honest limit with the fix already under way.

### DEFECT-2 — LOW-MEDIUM — arithmetic floor in the venue-night estimate
**Where:** §2, "What a single venue night actually needs", first bullet.
`20–40 guests × 2–4 songs × 1–3 attempts` has a minimum of **40**, not 80. The maximum (480) is correct. The dependent "Net: roughly 50–380" line derives its floor from the wrong 80 (80 × 0.6 ≈ 50), so it moves too: with a 40 floor the net floor is ≈ 25. Everything else in that derivation checks out — the 380 ceiling correctly pairs the high request count with the low cache-hit assumption (480 × 0.8 ≈ 384).

**Suggested fix:** `≈ 40–480 patron search requests per venue night` and `Net: roughly 25–380 search.list calls per venue night`. The argument is unharmed — a single venue still exhausts a 100/day allowance several times over at the top of the range, and the honest floor makes the range read as modelled rather than rounded upward.

### DEFECT-3 — LOW — the requested 5,000/day does not contain the headroom it claims
**Where:** §2 request table, "Basis" cell.
20 venues × 250 calls = 5,000 exactly, so the figure is the ceiling of its own basis, not the basis plus headroom. Separately, "~150–250 … (midpoint of the range above)" mischaracterises the 50–380 range, whose midpoint is 215. Both are small, but this is a document that opens by promising nothing is smoothed over, and Google reviewers read the justification cell.

**Suggested fix:** either drop "plus headroom for growth" and say the figure is the top of the modelled range, or restate the basis honestly, e.g. *"10–20 early-access venues × a 150–250 call/venue-night working band drawn from the 25–380 modelled range; 5,000 is the top of that band."*

### DEFECT-4 — LOW — "one patron search costs 1" understates the disclosed 2-call cap
**Where:** §0 table, "Boraoke's usage" cell.
A query may spend up to 2 `search.list` calls (`MAX_SEARCH_PAGES = 2`), which §1 and §2 both disclose plainly — so this is an internal inconsistency, not a concealment. The same 1:1 assumption carries into the venue-night model, which converts patron requests to calls without an allowance for the deliberate second page.

**Suggested fix:** `one patron search costs 1 call, or 2 if the patron deliberately requests a deeper page (hard-capped at 2)`. Optionally note in §2 that the estimate treats each request as one call and that a minority of requests spend a second.

### NIT-1 — "exactly one purpose"
§1: *"We use the YouTube Data API v3 for exactly one purpose: user-initiated song search"* — the very next paragraph describes a second (small, 1-unit, paste-path embeddability verification at queue-add). It is disclosed immediately, so nothing is hidden, but "exactly one purpose" and the following sentence sit awkwardly together in a document being read for literal accuracy. Consider "for user-initiated song entry only" as the umbrella.

### NIT-2 — "not retained beyond it", memory tier
§3 says cached entries "expire automatically at their TTL and are not retained beyond it." True for Redis (`px` TTL). The in-memory L1 uses lazy expiry (`lib/youtube-search.ts:352-363`): an expired entry is never *served*, but the bytes can sit in a warm lambda's heap past the 60 s mark until it is read, LRU-evicted (cap 100), or the instance recycles. Immaterial against a 30-day policy limit and not worth a rewrite; noted only so the claim is not mistaken for a stronger guarantee than it is.

### ADVISORY — not a defect, but the Tech Lead should decide it consciously before filing
§3 discloses that queue entries store a **title** (API-derived display metadata) with **no automatic expiry** — verified true (`lib/rooms.ts:316-317`). That is a plainly honest disclosure and the document treats it as an item to fix, with a matching §6 checklist entry. But it means the form, as written, tells Google in an audit that stored API metadata currently has no retention bound, in the same section that cites the 30-day limit in Policies §III.E.4. That is a defensible and probably correct choice (honesty beats omission, and the reviewer would find it anyway), but it is a *decision*, not an oversight — and the cheaper path may be to ship a room/queue retention bound first and file with a clean answer. Flagging so the choice is deliberate.

---

## 5. What is genuinely good here

Worth recording, because the gate is not only about defects:

- The `[VERIFIED]` / `[ESTIMATE]` / `[UNVERIFIED]` labelling is not decorative — every number I could falsify was either accurate or already labelled an estimate, and the estimate labelling is justified by a real code fact (no query-level telemetry, verified at `app/api/search/route.ts:145,158`).
- Both Google quotations reproduce verbatim, with correct "Last updated" dates. Neither is paraphrased-then-quoted, which is the usual failure mode.
- §4 is honest in exactly the right place: the *form-field* claim is corroborated (I reproduced it independently), and the *grant-magnitude* claim is labelled `[UNVERIFIED]` rather than implied. The "nothing should be sequenced behind an approval" conclusion is the right one.
- The previous draft's wrong 90-day room/queue retention claim is fully retracted and replaced with the true "no automatic expiry", with the 90-day figure correctly re-attributed to telemetry only.
- The ask declines increases it does not need (`videos.insert`, the unit pool), which is the strongest possible signal to an auditor that the applicant understands the model.

## 6. Re-gate criteria

Fix DEFECT-1 through DEFECT-4 (document-only edits; no code change is required by this gate) and this is an **APPROVE**. NIT-1/NIT-2 are optional. The ADVISORY is a Tech-Lead decision, not a gate condition.
