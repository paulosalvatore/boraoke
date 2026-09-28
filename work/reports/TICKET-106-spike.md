# TICKET-106 — Spike: surviving the 100-calls/day `search.list` cap

**Branch:** `ticket/106-search-quota` · **Type:** spike (findings + smallest-slice prototype, no production feature)
**Continues:** TICKET-85 (2026-08-19 independence spike) and TICKET-87 (shipped cross-instance spend counter).
**Status:** Steps 1 and 2 first, as instructed — they change the shape of the answer.

Every number below is labelled **[MEASURED]** (read live from production this session), **[VERIFIED]** (quoted from a primary source, cited), **[DERIVED]** (arithmetic over measured inputs, with the arithmetic shown), or **[ESTIMATE]**. Nothing is asserted from memory and nothing local or synthetic is presented as production.

---

## The short version

1. **The cap is really being hit** — production counter read `sb:2026-09-26 = 90`, i.e. the full patron budget spent. **[MEASURED]**
2. **But not by venue volume. By keystrokes.** The client searches as you type on a 400 ms debounce, so one patron typing *one* song title burned **12** of the platform's 90 daily calls. Across the session: **124 searches and 90 billed API calls to queue 24 songs.** The 12h cache cannot help, because every keystroke prefix is a string nobody has ever typed before — measured hit rate **27%**. **[MEASURED]**
3. **So the cheapest fix is not on the ticket.** Stop spending a call per keystroke and the same evening's 24 songs cost ~24 of 90 instead of exhausting it — roughly **4× headroom for hours of work**, no new dependency, no ToS surface.
4. **The quota form is NOT a placebo** — the ticket's central open question. The extension form has a **dedicated per-day `youtube.search.list` quota field**, quoted verbatim and re-verified independently. It is the only path that raises the cap itself. **[VERIFIED]**
5. **The harvested index works and is cheap** — 741 units (7.4% of one day's *unused* 10,000 pool) built a **36,372-song** index answering **66% of real production queries at zero `search.list` cost**. Its weakness is measured, not asserted: **coverage**, not matching — and coverage scales with harvest budget. **[MEASURED]**
6. **`youtubei.js` is better than expected and still not adoptable yet** — search needs no PoToken or player JS (it sheds the library's worst fragility class), but it was only proven from a residential IP, the maintainer documents datacenter-IP blocking as having *"no known solution"*, and the ToS exposure is quoted rather than softened.
7. **Piped/Invidious: 1 working endpoint each, out of 5 and 12 probed.** The August rejection stands in substance.

**Recommendation: fix the keystroke spend first and re-measure, build the index second, file the form in parallel if the TL wants to, and do not adopt an InnerTube tier until it is proven from Vercel.** Full reasoning and failure modes in Step 6.

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

## Step 3 — Harvested-index prototype: it works, and its weakness is coverage, not matching

Prototype lives on this branch at `work/spikes/ticket-106/` — `harvest.mjs` (index build), `fuzzy.mjs` (local matcher), `queries.mjs` (the test set), `eval.mjs` (scoring + controls), `diagnose.mjs` (miss attribution). **Zero dependencies added to the product**, deliberately: part of what was being tested is whether "good enough for a patron thumb-typing a half-remembered Portuguese title" needs a search engine or just careful normalisation.

### It spends zero `search.list` calls by construction, not by intention

`harvest.mjs` carries `assertNoSearchList()`, which throws on any URL whose path matches `/search/i`. That is a guard, not a comment — the prototype **cannot** touch the 100/day bucket even by mistake.

### How the channels were chosen, which matters for the result's honesty

Seed channels were not guessed. They were taken from **Boraoke's own production search cache** — i.e. the channels YouTube's own search already surfaces for real Brazilian karaoke queries — so the index is built from what patrons actually get shown. The first 13-channel run taught a methodology lesson worth recording: picking channels purely by result-count pulled in **non-karaoke channels** (`CEROL` is a funk/streamer channel, `Zé Ramalho - Topic` is an auto-generated topic feed), which then polluted matching. The 60-channel run filters on the channel name actually claiming to be karaoke/playback.

### Measured harvest cost [MEASURED]

| Index | Channels | Videos | `playlistItems`+`videos`+`channels` units | `search.list` spent |
|---|---|---|---|---|
| small | 13 | 7,217 | **150** | **0** |
| large | 60 | **36,372** | **741** | **0** |

**741 units built a 36,372-song karaoke index — 7.4% of ONE day's 10,000-unit pool, which today sits essentially unused.** A full monthly re-harvest (which also satisfies the Developer Policies' 30-day delete-or-refresh obligation) costs the same 7.4%. This is the single strongest fact in favour of the approach and it is now measured, not estimated: the resource we are starving in is *not* the resource this needs.

### Measured hit rate against REAL patron queries [MEASURED]

The test set is **not invented**. All 32 graded queries were typed by real patrons into production Boraoke and exist verbatim as `sc:BR::<q>` keys in the production cache. Ground truth for each is derived from the **longest member of the same keystroke family** — what that same patron eventually finished typing — so it is the patron's own demonstrated intent rather than my guess. A further **20 real production strings are excluded as ungradable** (`alord`, `qlos`, `slod`, `bsf`, `día`, `eita`…) because a human cannot tell what song was meant either; they are listed in `queries.mjs` rather than quietly dropped.

| Index | hit@1 | hit@5 | hit@10 | latency |
|---|---|---|---|---|
| 7,217 videos / 13 channels | 41% | 41% | 41% | 17 ms/query |
| **36,372 videos / 60 channels** | **56%** | **63%** | **66%** | 91 ms/query |

By query shape, on the large index: **accents 5/5**, **fully-typed titles 7/9**, **partial words 7/13**, **typos 1/5**.

### The decisive diagnostic: coverage vs ranking

Reporting a hit rate without splitting the misses would recommend the wrong fix, so `diagnose.mjs` attributes every miss to exactly one cause — the song is **absent from the index** (only more harvesting helps; falls through to `search.list`) or **present but not surfaced in the top 10** (a matcher bug, fixable in code for free).

| Index | hit@10 | COVERAGE-miss | RANKING-miss |
|---|---|---|---|
| 7,217 / 13 ch | 41% | **15** | 4 |
| 36,372 / 60 ch | 66% | **7** | 4 |

**Coverage is the binding weakness, and it scales.** A 5× bigger index (150 → 741 units) cut coverage misses from 15 to 7 and left ranking misses flat at 4. The ticket asked for long-tail coverage to be *tested rather than asserted*: it is real, it is the dominant failure, and it responds directly to harvest budget — of which there is ~13× more available than was used.

The 4 ranking misses are cheap, known wins: `escu` (3 candidates present, out-ranked), `olha a onfs` (the right Tchakabum row is in the index, the typo scored below threshold), `musical jm feliz` (108 candidates, artist-vs-title weighting), `vida de gad`. None needs new infrastructure.

### Honest weaknesses, as the ticket demanded

1. **Long-tail coverage — the real one.** At 36k songs, ~22% of real production queries are for songs simply not in the index. `Bandoleros` (Don Omar — Spanish reggaeton) is absent entirely; `Cerol na Mão` (Bonde do Tigrão) is absent; `Na Boca da Garrafa` is absent. Brazilian karaoke channels do not carry a uniform sample of what a party actually asks for. **This is exactly why the design must be layered: the index is a spend-reducer, never a replacement.** The good news is the fallthrough is free — an index miss is today's behaviour.
2. **Fuzzy matching is good enough for accents, adequate for partial words, and NOT good enough for typos** — 1/5 on the typo bucket. `soda stete` worked; `olha a onfs`, `cerol na mao` did not. A bounded-Levenshtein-per-token matcher is a floor, not a ceiling; a trigram index or a proper BM25+fuzzy layer would do better. **I am not going to claim it is sufficient — the measurement says it is not, on that bucket.** Note Step 4's contrast: `youtubei.js` resolved two **lyric-fragment** queries (`escurinho do cinema` → *Flagra*; `vida de gado` → *Admirável Gado Novo*) that a title index structurally cannot answer, because YouTube is matching on signals we do not have.
3. **Latency grows linearly** — 17 ms at 7k rows, 91 ms at 36k rows, because `search()` is a naive full scan with no index structure. At 100k rows a linear scan would be ~250 ms, which is too slow to sit in a request path. This is a solved problem (inverted token index), but it is **unsolved in this prototype** and must not be waved away.
4. **Storage is a non-issue** [MEASURED]: 36,372 rows = 7.48 MB raw, **3.01 MB** as `{videoId,title}`, **0.96 MB gzipped** (83 B/row). It fits in a single Upstash value, or in process memory on every instance. 433 exact-duplicate titles across channels also means a dedupe pass is worth having.
5. **Freshness** is cheap and bounded: a full re-harvest is 741 units, so nightly is affordable and monthly is trivially inside the Developer Policies' 30-day refresh obligation.
6. **n is small.** 32 graded queries from one product's real traffic. The coverage *trend* across two index sizes is the robust part; the exact percentages are not precise to better than a few points.

### Proving the measurement can fail (`prove-your-test-can-fail`)

A hit-rate harness that scores the same with the matcher broken is measuring nothing, so the controls are built into `eval.mjs --controls` rather than claimed in prose. Four deliberate mutations, verbatim output:

```
[LOCAL FUZZY INDEX] n=32  hit@1 18 (56%)  hit@5 20 (63%)  hit@10 21 (66%)
   partial   hit@5 7/13
   typo      hit@5 1/5
   accent    hit@5 5/5
   complete  hit@5 7/9
[C1 empty index (must be 0%)] n=32  hit@1 0 (0%)  hit@5 0 (0%)  hit@10 0 (0%)
   partial   hit@5 0/13
   typo      hit@5 0/5
   accent    hit@5 0/5
   complete  hit@5 0/9
[C2 no matching at all, first N rows (must be ~0%)] n=32  hit@1 0 (0%)  hit@5 0 (0%)  hit@10 0 (0%)
   partial   hit@5 0/13
   typo      hit@5 0/5
   accent    hit@5 0/5
   complete  hit@5 0/9
[C3 substring-only (the naive baseline)] n=32  hit@1 17 (53%)  hit@5 17 (53%)  hit@10 17 (53%)
   partial   hit@5 8/13
   typo      hit@5 0/5
   accent    hit@5 4/5
   complete  hit@5 5/9
[C4 no diacritic folding + substring (must hurt accents)] n=32  hit@1 6 (19%)  hit@5 7 (22%)  hit@10 7 (22%)
   partial   hit@5 3/13
   typo      hit@5 0/5
   accent    hit@5 4/5
   complete  hit@5 0/9
```

- **C1 (empty index) → 0%** and **C2 (ranking replaced by the first N rows) → 0%**. The harness is not scoring on a constant, and the `hit()` predicate is not vacuously true. These are the negative controls that make every other number in Step 3 meaningful — without them, "66%" could have been an artefact of a matcher that returned anything.
- **C3 (exact substring only) → 53%.** This is the reverse-check analogue: it is roughly what the product does today against a cache key. The fuzzy matcher beats it by only **10 points** (63% vs 53%).
- **C4 (diacritic folding removed) → 22%.** Confirms accent folding is load-bearing: removing one normalisation step costs 41 points.

**And C3 is a finding, not a formality, exactly as the skill warns.** On the `partial` bucket the naive substring baseline scores **8/13 — better than the fuzzy matcher's 7/13.** All the fuzzy matcher's real gain is in the `typo` bucket (1/5 vs 0/5) and the `complete` bucket (7/9 vs 5/9); on partial words its coverage-weighted scoring actually *loses* one case to plain substring matching. So the honest reading is: **most of the value here is the index existing, not the cleverness of the matcher.** Anyone building this for real should start from normalise + substring + prefix and add fuzziness only where it measurably pays — not from this prototype's scoring function.

## Step 4 — `youtubei.js` assessed honestly, as a FALLBACK tier only

**It works, it is technically better than expected, and the one question that decides whether it is usable was not answerable from here.**

### The limitation that governs everything in this section

Every PASS below was measured from a **residential Brazilian-ISP IP**. Boraoke runs on **Vercel serverless — datacenter IPs**. A pass here is **not** evidence it works in production. This section answers *"is the library functional and are its results real"*; it does **not** answer *"will it work from Vercel."*

### It works today [MEASURED 2026-09-27]

`youtubei.js@18.1.0`, published 2026-09-22 (five days before the test; version independently confirmed via `npm view`). All five real production karaoke queries returned 20/20 results:

| Query | Results | Latency (warm) |
|---|---|---|
| `escurinho do cinema karaoke` | 20 | 726 ms |
| `evidências karaoke` | 20 | 721 ms |
| `zé ramalho karaoke` | 20 | 708 ms |
| `vida de gado karaoke` | 20 | 826 ms |
| `borbulhas de amor karaoke` | 20 | 712 ms |

**Results verified real, not stubs:** all 15 sampled videoIds match `^[A-Za-z0-9_-]{11}$` and are unique, and three were cross-checked through **YouTube oEmbed — a completely different code path, plain `curl`** — returning byte-identical titles and channels. Negative control: a bogus `ZZZZZZZZZZZ` id → HTTP 400, so the verifier discriminates. Notably, two of the five queries were **lyric fragments rather than titles** (`escurinho do cinema` → Rita Lee's *Flagra*; `vida de gado` → *Admirável Gado Novo*) and both resolved correctly — that is real YouTube relevance ranking, which a stub cannot fake. **This matters for Step 3:** it is exactly the class of query a local title index cannot answer.

**Latency is the operational catch.** Warm median 1482 ms (min 728, max 3124, n=10). **Cold start across five fresh processes: 1184 / 1610 / 1735 / 5506 / 10015 ms** — an 8× spread, with the variance concentrated in the `sw.js_data` bootstrap. A ~10s p100 per cold serverless invocation is not acceptable on a patron's first keystroke-free search without a warm-session strategy.

### The genuinely good news: search does not need a PoToken or the player JS [MEASURED + read in source]

This cuts *in favour* of the library and is the finding most likely to be wrong in people's heads:

- `create({ retrieve_player: false })` + `search()` → 20 results, with `session.player` absent and `po_token` undefined.
- Traced network calls for a search: `sw.js_data` + `youtubei/v1/config` + `youtubei/v1/search` — 3 cold, **1 warm**, all 200. `base.js` (the player JS) is fetched **only** when `retrieve_player: true`.
- Confirmed in the library's source: PoToken is injected at five call sites, all on `getInfo`/playback paths. `search()` never touches it.

**So a search-only fallback sheds the entire signature/n-sig deciphering fragility class that dominates this library's issue tracker.** The caveat holds: *"not required today from residential"* is not *"not required from Vercel,"* which is where a PoToken demand typically first appears.

### What breaks it [VERIFIED against the repo]

- **Maintenance cadence has halved, with a hole in it.** 7 npm publishes / 8 GitHub tags in the last 12 months, against **15 in the prior 12**. Release gaps: 3, 151, 98, 1, 49, 40 days — including a **151-day (5-month) window with no release at all** (2025-10-16 → 2026-03-16), confirmed on both npm and GitHub.
- **47% of in-window issues (26/55) are breakage-shaped.** YouTube has already forced a breaking change to search itself: v17.0.0 — *"Search: Update search filters to match YouTube changes (#1136)."*
- **Search-specific failure mode, and it is the nasty kind:** issues #1158 / #1166 report `/search` degrading to **empty results rather than an error** under rate limiting (maintainer: *"it must be some sort of rate limiting on YouTube's side"*). A fallback tier that silently returns zero results instead of failing loudly is a fallback that lies to the patron.
- **Fixes land fast, releases do not.** Code lands in 0–5 days; report→npm latency measured at 1, 11, 19, 32, 32 and **95** days.
- **Bus factor ≈ 1.** LuanRT authored 67 of ~105 human commits in window (~64%); one other sustained contributor; no support, SLA or compatibility statement anywhere in the README.

### Datacenter-IP exposure — the decisive unresolved risk [VERIFIED]

**The maintainer documents this as unsolved.** From https://ytjs.dev/guide/faq.html:

> "Why do video info requests fail in my server?" … "The most common one is that the server's IP address is blocked by YouTube. **Unfortunately, there is no known solution to this problem.**"

`"Sign in to confirm"` appears across **10 issues spanning 2023-03 to 2026-01**, recurring every few months. Issue **#977** (Cloud Run returns `undefined`, works on localhost) has been **open with zero maintainer comments for 15 months**. #1119 (bot detection) was closed same-day with a community workaround and no code fix. Only cookies are doc-recommended; proxies are supported but never endorsed as a bot-detection remedy.

**[ESTIMATE]** For search-*only* the exposure is narrower than the tracker suggests — nearly every datacenter report concerns `/player`, streaming or transcripts, not `/search`. But serverless is the worst case for it: fresh shared IPs, no session reuse, full bootstrap on every cold call.

### ToS exposure — quoted, not characterised

**YouTube ToS** (https://www.youtube.com/t/terms, "Dated: December 15, 2023"), *Permissions and Restrictions* — "You are not allowed to:"

> "access the Service using any automated means (such as robots, botnets or scrapers) except (a) in the case of public search engines, in accordance with YouTube's robots.txt file; or (b) with YouTube's prior written permission;"

**Developer Policies** (https://developers.google.com/youtube/terms/developer-policies, "Last updated 2026-09-14 UTC") — the sharpest, and **I re-fetched and re-verified these two verbatim myself rather than relaying them**:

> §III.D *Undocumented Services*: "You **must not use undocumented APIs** without express permission."
> "You **must not reverse engineer undocumented YouTube API services** or otherwise attempt to derive the underlying source code of these API services."

**API ToS** (https://developers.google.com/youtube/terms/api-services-terms-of-service, "Last updated 2026-09-14 UTC"):

> §15: "You and your API Client(s) will not, and will not attempt to, **exceed or circumvent use or quota restrictions**."
> §3.1: "YouTube may suspend or terminate your access … (including any credentials assigned to you or your API Client(s)) … for any violation."
> §24.2: "…terminate … at any time. … Although we will try to give you reasonable notice, **we have no obligation to do so**."
> §22: "YouTube will be entitled to seek temporary or permanent **injunctive relief**…"

**The exposure is dual — credential/account termination AND legal.** No penalty schedule, fine, or graduated-warning process exists in any of these documents ([VERIFIED as absent] over the four documents actually read).

**[ESTIMATE — a reading of how the documents interlock, not a quoted clause, and not legal advice]** `youtubei.js` uses no credentials, so on its own it engages the *consumer* ToS. But Boraoke **also holds an API project** for the primary `search.list` tier, and the Developer Policies bind "you and your API Clients," not merely the credentialed call path. So the plausible exposure is that an InnerTube fallback running *alongside* a credentialed project brings **that project's key and the Google account** into scope under §3.1/§24.2 — and §15's quota-circumvention clause is the clause that most directly describes a fallback whose stated purpose is serving search past a 100-call/day cap. **That risk judgement is the Tech Lead's, per the ticket's escalation list; this spike does not make it.**

### What could NOT be determined, stated plainly

1. **Whether it works from Vercel — the gating question.** Untested. Needs a deployed probe over several days.
2. **What a block looks like empirically.** No call failed, so there is no error string/status/stack for the failure mode. That is a gap, not a clearance.
3. **Sustained-rate behaviour.** Only ~25 searches from one IP; the rate-limit threshold and how often the #1158/#1166 silent-empty degradation fires are undocumented and unmeasured.
4. Session/player cache reuse across warm Vercel invocations (the obvious cold-start mitigation).
5. Whether YouTube enforces these clauses against this pattern in practice — no precedent or statement found.
6. Long-run stability. One clean day says nothing against a 47%-breakage-shaped base rate.
7. Which ToS entity/variant binds a Brazilian operator (Americas variant read; consumer-ToS date varies by region). **No legal review was performed.**

### A methodology note worth keeping

The research pass caught **its own silent false negative** mid-spike: an early network trace patched `globalThis.fetch` *after* import and duly reported *"search made 0 calls"* — which is indistinguishable from "the library makes no network calls" and was simply wrong (the library had already captured `fetch`). It was rewritten to use the library's injectable `fetch` **plus a control that exits non-zero if the tap records zero calls**. This is exactly the `proof-by-absence` hazard class, caught by a positive control rather than by luck. Nothing in this section rests on an uncontrolled empty result.

## Step 5 — Bounded Piped/Invidious re-probe (10 minutes, as instructed)

### Verdict: CHANGED — marginally. Substance of the August rejection still holds. [MEASURED 2026-09-27]

**Positive control first, so a dead instance cannot be confused with a dead probe** (`proof-by-absence`): the same `curl` invocation, same shell, same session — `google.com` 200 (0.49s), `api.github.com/zen` 200 (2.18s), `youtube.com` 200 (0.76s). A DNS control separated real NXDOMAIN from resolver failure (`api.invidious.io` and `api.piped.private.coffee` resolved; `api.piped.yt` and `pipedapi.drgns.space` are genuinely gone). **Every non-200 below is a real remote response or a real timeout, not a broken harness.**

**Invidious** — registry `https://api.invidious.io/instances.json` → 200, 8991 bytes. Still 11 instances, 5 genuinely clearnet (2 of the 7 `https` rows are Yggdrasil-overlay-only). Instances advertising `api: true`: **1, up from 0.**

| Instance | URL called | Status | Time | Usable results? |
|---|---|---|---|---|
| `invidious.f5.si` (`api:true`) | `/api/v1/search?q=karaoke+evidencias` | **200** | 2.37s | **YES** — 20-item array, top hit `Evidências - Chitãozinho e Xororó (Karaokê Version)` (`tfhwXKd1W_o`). 3/3 repeats 200. |
| `inv.nadeko.net` | same | 403 | 0.39s | No — body `Endpoint disabled` |
| `invidious.nerdvpn.de` | same | 401 | 1.44s | No — nginx auth wall |
| `invidious.tiekoetter.com` | same | 403 | 0.96s | No |
| `yt.chocolatemoo53.com` (new since Aug) | same | 403 | 3.11s | No — body `forbidden` |

**Piped** — the project's own instance list (`https://piped-instances.kavin.rocks/`) **times out**, so there is no reachable authoritative list. 12 hosts probed on `/search?q=karaoke&filter=videos`: **1 works.**

| Instance | Status | Time | Usable? |
|---|---|---|---|
| **`api.piped.private.coffee`** | **200** | 8.16s | **YES** — 20 `items`, real karaoke titles. 3/3 repeats 200 at 5.20/3.63/3.03s |
| `pipedapi.kavin.rocks` | 526 | 0.64s | No (unchanged since Aug) |
| `pipedapi.adminforge.de` | 301→404 HTML | 7.04s | No (unchanged) |
| `api.piped.yt` | NXDOMAIN | — | No — host gone |
| `pipedapi.leptons.xyz` | 502 | 3.76s | No (unchanged) |
| `pipedapi.ducks.party` | timeout | 12.01s | No |
| `pipedapi.drgns.space` | NXDOMAIN | — | No |
| `pipedapi.orangenet.cc` | TCP refused | 4.84s | No |
| `pipedapi.reallyaweso.me` | 502 | 1.33s | No |
| `pipedapi.phoenixthrush.com` | NXDOMAIN | — | No |
| `piped-api.lunar.icu` | 502 | 2.21s | No |
| `pipedapi.astartes.nl` | TLS `unrecognized name` | 1.99s | No |

**What this changes and what it does not.** The *technology* is demonstrably not dead — both codebases return correct, usable results for our real production query when an operator permits it, and Invidious returned the exactly-right video for `karaoke evidencias` faster than our own API path. But each network is down to **exactly one** working public endpoint, and the observed failure mode across 16 probed hosts is precisely *"operators disable the API or vanish."* A single surviving volunteer endpoint, with 3–8s latency in Piped's case, is not a dependency for the thing a patron does in front of a room of people. **The August verdict stands in substance.**

It does, however, reframe the open question: the only credible way to use either network is now **self-hosting**. Per the ticket's escalation list, **self-host vs public instance is the Tech Lead's decision and this spike does not make it** — it is surfaced in Step 6.

## Step 6 — Comparison and recommendation

### The comparison

| Option | Reliability | ToS risk | Breakage exposure | Latency | Infra cost | Effort | Quota effect |
|---|---|---|---|---|---|---|---|
| **A. Stop searching per keystroke** (search-on-submit / longer debounce / client-side narrowing) | Highest — removes calls, adds no dependency | **None** | None | Improves (fewer calls, fewer spinners) | Zero | **Hours** | **~4× more songs per day** [MEASURED 3.75 → ~1 call/song] |
| **B. Harvested local index** (`playlistItems.list`) | High — official API, no new failure mode; miss falls through to today's path | **None** — official API, used as intended | None from YouTube's side; index goes stale if the refresh cron dies | 91 ms at 36k rows in-process (naive scan; grows linearly) | ~1 MB gzipped, fits Upstash/memory; 741 units/refresh | 3–5 days + a real matcher | **66% of real queries answered with zero `search.list`** [MEASURED] |
| **C. File the quota extension form** | Unknown — discretionary audit, no SLA, no published rubric | None (if truthful) | None | N/A | Zero | 1–2 h + TL review | **Potentially raises the cap itself** — the only option that does. Per-day `search.list` field confirmed on the form [VERIFIED] |
| **D. `youtubei.js` fallback tier** | Unproven where it matters — works from residential, **untested from Vercel**, and the maintainer documents datacenter-IP blocking as having "no known solution" | **High** — Developer Policies §III.D forbids undocumented APIs and reverse engineering; API ToS §15 forbids circumventing quota restrictions; exposure is credential/account termination *and* reserved injunctive relief | High — 47% of issues breakage-shaped, release cadence halved, one 5-month gap, bus factor ≈1, and `/search` degrades to **silent empty results** under rate limiting | 728–3124 ms warm; **1.2–10 s cold** | Zero | 1–2 days + a Vercel probe | Unbounded in principle, unmeasurable in practice |
| **E. Piped / Invidious public instances** | **Effectively zero** — 1 working endpoint of 5 Invidious clearnet, 1 of 12 Piped; no reachable authoritative instance list | Inherits D's exposure plus dependence on volunteer infra Google has sent legal threats to | Extreme — the measured failure mode is "operators disable the API or vanish" | 2.4 s (Invidious) / 3–8 s (Piped) | Zero | Low | N/A |
| **F. Self-hosted Invidious/Piped** | Not assessed — the only credible way left to use E | Same as D/E | Shifts to *our* ops burden + our datacenter IP getting blocked | Unknown | A server we run | Unknown | **Tech Lead's decision, not made here** |
| **G. Direct scraping** | — | Rejected on ToS grounds (TICKET-85, unchanged) | — | — | — | — | — |

### Recommended layered design

**Do A first, alone, and re-measure before committing to anything else.**

1. **Tier 0 — don't spend the call (A).** Search on submit, or a much longer debounce plus a higher `MIN_CHARS`, and narrow the 50 already-fetched rows client-side instead of re-querying. This is hours of work, has no dependency, no ToS surface and no new failure mode, and the production data says it recovers ~4× of the cap. **At today's demand (~25 songs/day, never more) this alone takes the product from "cap exhausted in a 1.6-hour session" to comfortably inside budget.** It is also a UX improvement, not a tax.
2. **Tier 1 — the existing 12h cache**, unchanged, in front of everything. It is already correct; it was only ineffective because Tier 0's keystroke traffic made every key unique. With Tier 0 in place the *same* cache starts seeing repeat queries and its hit rate should rise on its own — which is a prediction that must be re-measured, not assumed.
3. **Tier 2 — the harvested local index (B).** Answers ~66% of real queries at zero `search.list` cost, for 7.4% of a daily pool we do not use. Build it *after* Tier 0, size the harvest from the measured coverage curve, and give it a real inverted index rather than this prototype's linear scan.
4. **Tier 3 — `search.list` for the long tail.** With Tiers 0–2 in front, 90 calls/day stops being the product's core interaction and becomes what it is adequate for: the ~22% of queries the index misses, plus lyric-fragment queries no title index can answer.
5. **File the form (C) in parallel, if the Tech Lead chooses to.** It is now confirmed to be the only path that raises the cap itself, and it is ~90% drafted. But it has no SLA, no published rubric, and cannot be sequenced ahead of anything.
6. **Do not adopt D or E as a tier yet.** `youtubei.js` is technically better than expected and its search path avoids the library's worst fragility class — but the gating question (does it work from Vercel?) is unanswered, and it is cheap to answer with a deployed probe before any design rests on it.

### Failure modes of the recommended design, stated

- **Tier 0 changes the interaction.** Patrons lose live-as-you-type results. Mitigation: keep the 50 fetched rows and narrow them locally, so typing still feels live after the first search. **Risk: if the TL judges search-as-you-type to be the product's feel, this becomes a longer-debounce/min-length tuning exercise instead, which recovers less.** That is a product call.
- **Tier 2 goes stale silently** if the refresh cron dies — patrons get an index that slowly drifts from YouTube. Mitigation: the index must carry a build timestamp and the fallthrough must be unconditional, so a stale index degrades to today's behaviour rather than to wrong answers.
- **Tier 2 raises a Developer Policies question the form must describe honestly.** The Policies forbid using API Services to create "a substitute for, or substantially similar service to, any YouTube Applications." A venue queue playing through the official IFrame embed is not that — but a searchable catalogue is the one component that could be *mistaken* for it, so the index must stay an internal implementation detail (never a public browsable catalogue) and the quota form must describe it plainly rather than omit it.
- **Tier 3 still dies at 90.** Nothing here removes the cap; A and B only make it sufficient at current and near-term demand. At 10× demand with a 66%-coverage index, the long-tail residue alone would approach the cap again. **The only option that raises the ceiling is C, and C is a lottery ticket.**
- **The whole design rests on n=2 busy days.** Ship the `cached: true|false` flag on `search_performed` (two lines) so the next re-measurement does not depend on reconstructing a Pacific day from a 36h-TTL counter, as this spike had to.

### For the Tech Lead — decisions this spike deliberately did not make

1. **Search-as-you-type vs search-on-submit.** The measured 4× quota recovery is worth it on the numbers, but it changes how the product feels, and that is a product call.
2. **Whether to file the quota extension form.** Now confirmed *not* a placebo — the form has a dedicated per-day `youtube.search.list` field. Remaining cost is the TL's own review, plus two corrections (§2 should describe TICKET-87's shipped bound; the ask must be denominated in the `search.list` per-day box, not "1,000,000 units/day").
3. **ToS-risk tolerance for any InnerTube path.** The clauses are quoted in Step 4 without softening. Boraoke is a public product intended to carry paying venues; this is a business risk.
4. **Self-host vs public instance**, if any proxy path is to be considered at all. The re-probe says self-hosting is the only credible version.

### Ticket housekeeping this spike did not do

- **Nothing was filed.** The quota form was not submitted.
- **No production code was changed.** The prototype is confined to `work/spikes/ticket-106/`.
- **No production write occurred.** Production Redis and the Vercel env were read only; the `search.list` bucket was not spent (the day's counter was read, never incremented). The 741 units consumed were `playlistItems`/`videos`/`channels` calls against the 10,000-unit pool, which is the whole point of the approach.
