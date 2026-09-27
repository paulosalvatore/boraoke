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

_(in progress — written in as soon as it lands)_

---

## Step 3 — Harvested-index prototype

_(pending)_

## Step 4 — `youtubei.js` as a fallback tier

_(pending)_

## Step 5 — Bounded Piped/Invidious re-probe

_(pending)_

## Step 6 — Comparison and recommendation

_(pending)_
