# TICKET-106 — Spike: surviving the 100-calls/day `search.list` cap

**Branch:** `ticket/106-search-quota` · **Type:** spike (findings + smallest-slice prototype, no production feature)
**Continues:** TICKET-85 (2026-08-19 independence spike) and TICKET-87 (shipped cross-instance spend counter).
**Status:** Steps 1 and 2 first, as instructed — they change the shape of the answer.

Every number below is labelled **[MEASURED]** (read live from production this session), **[VERIFIED]** (quoted from a primary source, cited), **[DERIVED]** (arithmetic over measured inputs, with the arithmetic shown), or **[ESTIMATE]**. Nothing is asserted from memory and nothing local or synthetic is presented as production.

---

## Step 1 — The actual production numbers, and they reframe the whole ticket

### How production state was reached

Production `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` were pulled from the linked Vercel project (`vercel env pull --environment=production`) into the session scratchpad **outside the repo**, read over the Upstash REST API read-only, and shredded afterwards. No secret value appears in this report, in the transcript, or in the repo. No write of any kind was issued to production Redis. The `search.list` bucket was **not** touched by this spike's measurement (the counter was read, never incremented).

**Positive control for the probe** (so an empty result cannot be mistaken for a dead probe): `PING → PONG`, `DBSIZE → 166`, and a full `SCAN` returning the expected key namespaces (`sc:` 89, `room:` 28, `identity:` 24, `telemetry:` 19, `feedback:` 4, `rooms:` 1, `sb:` 1). The probe provably ran against the live store.

### Finding 1A — The cap is genuinely being hit, exactly as reported [MEASURED]

```
sb:2026-09-26 = 90
```

`sb:<pacific-day>` is TICKET-87's cross-instance spend counter. `SEARCH_DAILY_BUDGET` is 90 (`SEARCH_DAILY_CAP` 100 − `RESERVE_MARGIN` 10). **The counter sat at exactly 90/90: the patron-reachable daily budget was fully exhausted on Pacific day 2026-09-26**, after which every free-text search on the platform returned `degraded: reason=daily-limit`. The Tech Lead's report is confirmed by the counter, not inferred.

There is only **one** day of counter history available: the key TTL is 36h (`KEY_TTL_MS`), so `sb:2026-09-25` and earlier have expired. As of the probe, `sb:2026-09-27` did not exist yet (zero spend so far in the current Pacific day). So the counter alone is n=1. Telemetry, below, supplies the history the counter cannot.

### Finding 1B — The measured cache hit rate is ~27%, and that is not the interesting number [MEASURED + DERIVED]

`search_performed` is emitted on **exactly two** paths in `app/api/search/route.ts`: line 146 (cache hit) and line 192 (successful live call). It is **not** emitted on a rate-limit 429, a budget denial, or an upstream error. So `search_performed` = cache hits + successful billed calls, which makes the hit rate recoverable even though nobody ever shipped the `cached: true|false` telemetry flag TICKET-85 asked for.

The exhausted session spans one UTC-date boundary (BRT evening → UTC after midnight), so both days belong to Pacific day 2026-09-26:

| Instrument | Value |
|---|---|
| `telemetry:events:2026-09-26` `search_performed` | 20 **[MEASURED]** |
| `telemetry:events:2026-09-27` `search_performed` | 104 **[MEASURED]** |
| Total `search_performed` for the session | **124** **[DERIVED]** |
| Billed `search.list` calls (`sb:2026-09-26`) | **90** **[MEASURED]** |
| Cache hits = 124 − 90 | **34** **[DERIVED]** |
| **Measured cache hit rate** = 34 / 124 | **≈ 27%** **[DERIVED]** |
| Distinct live `sc:` cache keys created | 89 **[MEASURED]** (89 ≈ 90 billed calls, minus ~1 empty-result key that expired on its 10-min TTL — the accounting closes) |

27% lands inside TICKET-85's **[ESTIMATE]** of 20–40% at a 12h TTL. So the cache is working as designed, and it is *not* the lever: at 27% it is absorbing a quarter of the traffic and the day still ends at 90/90.

### Finding 1C — THE ROOT CAUSE. The spend is not venue volume, it is one `search.list` call per keystroke [MEASURED]

This is the finding that changes the ticket. The 89 live cache keys are not 89 patron requests for 89 songs. They are **keystroke prefixes of the same few songs**. Read the raw keys:

```
sc:BR::esc karaoke                        sc:BR::escurinho do c karaoke
sc:BR::escu karaoke                       sc:BR::escurinho do ci karaoke
sc:BR::escur karaoke                      sc:BR::escurinho do cin karaoke
sc:BR::escuri karaoke                     sc:BR::escurinho do cinema karaoke
sc:BR::escurinh karaoke                   sc:BR::escurinho d karaoke
sc:BR::escurinho karaoke                  sc:BR::escurinho do karaoke
```

**Twelve of the platform's 90 daily calls — 13% of a whole day's global budget — went on one patron typing one song title.** Their TTLs are within ~50 seconds of each other, so this is one continuous typing burst, not repeat demand. `zé r → zé ra → zé ram → zé rama → zé ramalho` is five calls inside a **one-second** TTL spread. `bor → borb → borbu → borbulhas → borbulhas de` is five more.

Grouping all 89 keys into prefix families collapses them to **40 families**, and clustering the obvious typo-variants of the same attempt (`cerol na mão`/`cerol na mao`, `soda stereo`/`soda stete`, `olha a onda`/`olha a onfs`, `maná`/`mana`, `alors`/`alord`/`alo s`/`aloés`/`qlos`/`slod`, `evidências`/`evide`) brings it to roughly **24–28 distinct songs** — which matches the independently-measured `song_queued` count of **24** for the same session almost exactly.

**So: 124 searches and 90 billed API calls to queue 24 songs. 3.75 billed `search.list` calls per song actually queued.**

The mechanism is in the client, not the quota. `components/SongSearch.tsx`:

```ts
const DEBOUNCE_MS = 400;
const MIN_CHARS = 3;
...
debounceRef.current = setTimeout(() => runSearch(trimmed), DEBOUNCE_MS);
```

Search-as-you-type on a 400ms debounce. A patron thumb-typing a Portuguese title on a phone pauses for >400ms many times per title — every pause is a distinct query string, therefore a distinct cache key, therefore a fresh 1-of-90. The 12h cache **cannot** help: every prefix is a string nobody has ever typed before, so it is a guaranteed miss by construction. That is why the hit rate is 27% and not 90%.

### Finding 1D — The pattern is structural and reproducible, not one bad evening [MEASURED]

Full `search_performed` / `song_queued` history, every day the product has ever recorded telemetry (the counter's 36h TTL cannot see this; the telemetry lists can):

| Pacific/UTC day | `search_performed` | `song_queued` | searches per queued song |
|---|---|---|---|
| 2026-07-08 | 12 | 6 | 2.0 |
| 2026-07-17 | 11 | 3 | 3.7 |
| 2026-08-08 | 10 | 4 | 2.5 |
| 2026-08-17 | 26 | 6 | 4.3 |
| 2026-08-28 | **75** | 18 | 4.2 |
| 2026-09-24 | 4 | 2 | 2.0 |
| 2026-09-26 + 09-27 (one session) | **124** | 24 | **5.2** |

Two independent busy days (2026-08-28 at 75, and this session at 124) both run at **4–5 searches per queued song**. The ratio is a property of the input widget, not of the evening. And note the shape of the constraint: **the product has never needed more than ~25 songs in a day.** 90 calls/day is ~3.6 calls per song at today's demand — it is only "too small" because each song costs 4–5.

### What Step 1 means for the rest of the ticket

The ticket (following TICKET-85) frames this as "90 calls/day is structurally too few for a venue night, therefore build a harvested local index." The production numbers say something cheaper first:

- **The immediate, near-zero-effort fix is to stop spending a call per keystroke.** Search on submit (or: raise the debounce sharply, raise `MIN_CHARS`, and narrow already-fetched rows client-side instead of re-querying). At 1 call per song instead of 3.75, this session's 24 songs cost **24 of 90** rather than exhausting it — a ~4× headroom gain from a client-side change with no new infrastructure, no new dependency and no ToS surface. It is also strictly complementary to everything below.
- **The harvested index is still the right structural answer** and is still worth the prototype (Step 3) — it is what makes the product safe at 10× today's demand, and it is the only option that removes the dependency rather than stretching it. But it is no longer the *urgent* answer, and it should not be sequenced ahead of the keystroke fix.
- **Honest limit on this measurement:** n is small. This is real production traffic from real phones (rooms were created, songs were played), but it is one product with sparse usage, and the two busy days are the only ones with enough volume to be meaningful. The ratio is consistent across them, which is why I am willing to call it structural — but it is 2 days, not 20.

### The honest caveat on the cache hit rate

27% is a **[DERIVED]** figure resting on one assumption: that all 90 reserved calls succeeded upstream (reservations are never refunded, so a failed call would still count as spend and would make the true hit rate slightly higher). The route caches only successful responses, and 89 keys were created against 90 reservations, so at most one call failed or returned an empty that has since expired. The figure is sound to within ~1%.

The instrumentation TICKET-85 asked for — a `cached: true|false` flag on `search_performed` — is **still not shipped**, and it should be, because the derivation above only works while the budget counter happens to be readable and the day happens to be reconstructable across the UTC boundary. It is a two-line change. **But it is no longer a blocker for this decision**, which is the point of doing Step 1 first.

---

## Step 2 — Does a granted quota extension raise the `search.list` CALL cap?

### Verdict: **YES. It is a separately-requested, per-method, per-day allocation with its own field on the form. The form is NOT a placebo.** [VERIFIED]

TICKET-85 flagged this as "the single most important open question in this document" and could not resolve it, because the audit *documentation* still described the pre-June world. The resolution is that **the documentation was the wrong place to look — the answer is on the form itself.**

**Primary source, and it is decisive:** the YouTube Data API Services Audit and Quota Extension Form, https://support.google.com/youtube/contact/yt_api_form (fetched 2026-09-27, HTTP 200, server-rendered without sign-in; Google Support contact forms carry no "Last updated" date). Under "Quota Details for Project #1", verbatim:

> "Please note: At the end of your selection you can specify the total quota required. **This quota can be used for all endpoints except search.list and videos.insert.**"
> "**If you need additional quota for search.list and videos.insert you must specify the quota required for each of these methods separately below the box to enter total quota.**"

And the form's field sequence, verbatim in page order:

> "What is the total quota you are requesting for Project #1?" · "No change / Default quota (10k quota points)" · "Above Default quota" · "Total Per Day Quota \*" · "Detailed Justification \*" · **"youtube.search.list"** · "Total Per Day Quota \*" · "Detailed Justification \*" · **"youtube.videos.insert"** · "Total Per Day Quota \*" · "Detailed Justification \*"

Three independent per-day asks, each with its own mandatory justification. `youtube.search.list` and `youtube.videos.insert` are additionally hoisted to the top of the endpoint checkbox list, ahead of the otherwise-alphabetical remainder.

**This was verified twice, independently.** The research pass fetched the raw HTML and retained it; I then re-grepped that retained HTML myself rather than accepting the summary, and both the "except search.list" sentence and the three `Total Per Day Quota` / `Detailed Justification` field pairs are present verbatim (the pattern repeats for Projects #1–#10 on the form). This is a measurement, not a relayed claim.

**Corroboration from the docs, now that we know what to look for:**

- Revision history, https://developers.google.com/youtube/v3/revision_history ("Last updated 2026-09-14 UTC"), on the 2026-06-01 change: *"This update simplifies the path to quota increases by allowing YouTube to more easily verify and approve requests based on specific method usage."* and *"API calls to the videos.insert and search.list methods will be charged to their own respective quota buckets. … Developers can view quota limits in the Google Cloud Console, and they can request additional quota through the Quota Extension Form."* The per-method buckets and the extension mechanism are named in the same paragraph, and per-method approvability is stated as the *purpose* of the change.
- Getting-started, https://developers.google.com/youtube/v3/getting-started ("Last updated 2026-09-14 UTC"): *"request additional quota by completing the Quota extension request form for YouTube API Services"* — whose raw `href` is exactly the form URL above.
- Quota and compliance audits, https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits ("Last updated 2026-09-14 UTC"): extensions are *"beyond the default allocation"*, and the preceding sentence defines that allocation as the one **including** the 100 `search.list` calls. Nothing on any of these pages restricts extensions to "units".

**What is still NOT established:** the *magnitude* granted, and the odds. The form is an audit, not a slider — *"All requests for additional quota requests must go through a compliance audit"* and *"demonstrating significant independent value to the YT ecosystem and its users. Applications that are unable to meet requirements may not be granted additional quota."* No published ceiling on the number you may enter, no published SLA, no published rubric. So Step 2 converts the form from *"possibly worthless"* to *"the only documented path past 100 calls/day"* — it does not make it a plan, and nothing should be sequenced behind it.

**A documentation-staleness finding worth recording on its own:** the June-2026 rewrite did not regenerate Google's auto-generated "Page Summary"/TTS layers, which now contradict their own page bodies. `determine_quota_cost` ("Last updated 2026-09-15 UTC") has a summary still claiming *"videos.insert have the highest cost of 1600 points"* while its own table row reads *"100 quota per day. Each call costs 1 quota."*; the audits page summary still says *"a default allocation of 10,000 units per day"*; getting-started's footer still says searching *"costs much more"* against a body reading *"A search query costs 1 unit."* **Body text and table rows are current; never quote a Page Summary as doctrine.** This is very likely why TICKET-85 read the audit docs as pre-June: parts of them still are.

**Also note for the form itself:** the correction the ticket already flagged (form §2 should describe TICKET-87's *shipped* platform-wide bound rather than "in progress") still applies, and one more now does too — **the ask must be denominated in the `youtube.search.list` per-day box, not as "1,000,000 units/day"**, which under the current model asks for more of the resource boraoke already has in surplus. Filing remains the Tech Lead's decision; this spike did not file anything.

---

## Step 3 — Harvested-index prototype

_(pending)_

## Step 4 — `youtubei.js` as a fallback tier

_(pending)_

## Step 5 — Bounded Piped/Invidious re-probe

_(pending)_

## Step 6 — Comparison and recommendation

_(pending)_
