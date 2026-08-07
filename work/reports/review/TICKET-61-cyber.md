# TICKET-61 — Cyber Security Gate

**Scope reviewed:** working-tree diff in `.worktrees/ticket-61` (`app/api/queue/route.ts`, `lib/youtube.ts`, `app/(patron)/[room]/PatronRoom.tsx`, `messages/*.json`, tests). Note: the branch has no commits ahead of `origin/main` yet — `git diff origin/main...HEAD` is empty and the change is entirely uncommitted. Reviewed the working tree.

**Verdict: PASS** — with 3 MEDIUM follow-ups recommended before/shortly after merge. No CRITICAL or HIGH. The four things this gate was pointed at hardest (SSRF/injection, fail-open, response-shape leakage, call placement) are all correct and, in several places, better than the surrounding pre-existing code.

Findings: 0 CRITICAL, 0 HIGH, 3 MEDIUM, 3 LOW, 4 INFO.

---

## MEDIUM-1 — No cache on the outbound check: every repeat submit of the same video re-spends a quota unit

`lib/youtube.ts:81-113` — `checkEmbeddable` calls the Data API unconditionally on every paste-path submit. There is no memoization, no cross-instance cache, and no negative cache.

Contrast the sibling path: `/api/search` was deliberately given an Upstash-backed cross-instance cache in TICKET-55 (`app/api/search/route.ts:97-102`, "a hit burns zero quota"). The new path has nothing equivalent, even though its cache-hit rate would be far higher — embeddability of a given `videoId` is stable for days, and a bar re-queues the same handful of songs all night.

**Why it matters (security, not just cost):** the quota is a shared, exhaustible resource for the whole product. An unauthenticated caller can drive N submits → N quota units with zero reuse. With the current limiter (60/min/IP, `lib/queue-rate-limit.ts:26`) that is ~86,400 units/day/IP against a default 10,000-unit daily quota.

**Mitigating context that keeps this out of HIGH:** the dominant quota-drain vector is *pre-existing and far cheaper to exploit*. `/api/search` allows 30 req/10s/IP (`lib/youtube-search.ts:278-279`) at **100 quota units per `search.list`** — ~18,000 units/minute/IP, i.e. the entire daily quota in under 4 seconds from one IP, with distinct queries bypassing the cache. This ticket adds a 1-unit-per-request drain to a surface that already has a 100-unit-per-request drain. The marginal exposure is real but small.

**Recommendation:** reuse `lib/search-cache.ts`'s Upstash pattern keyed on `yt:embed:<videoId>` with a long TTL (24h for `embeddable`/`not-embeddable`, short TTL for `unknown` so a transient outage doesn't stick). This is the single highest-value change: it removes most of the drain and most of the added latency at once.

## MEDIUM-2 — The only control gating the outbound call is an in-memory, per-instance rate limiter

`lib/queue-rate-limit.ts:34` — `const hits = new Map<string, number[]>()`. Module-level in-process state. On Vercel this is per serverless instance, so the effective global limit is `60/min × (number of warm instances)`, and a burst that fans out across instances is barely limited at all. The house already recognised this class of problem and fixed it for the search *cache* (TICKET-55, cross-instance Upstash); the *limiter* was never migrated.

The change doesn't introduce this, but it makes the limiter load-bearing for a new thing (an external paid resource) that it wasn't designed to protect. The in-code claim at `app/api/queue/route.ts:218-221` — "after the dual-bucket rate limit … so a … throttled submit can never spend a quota unit" — is true per-instance and weaker than it reads globally.

**Recommendation:** either move the submit limiter to the Upstash backend, or (cheaper, and the better fix) add a dedicated cross-instance budget on the outbound call itself — a daily/hourly counter on `yt:quota:<date>` that short-circuits `checkEmbeddable` to `unknown` once a self-imposed ceiling is hit. That also protects `/api/search` from the new path and is the graceful-degradation control this feature is missing.

## MEDIUM-3 — Up to 1.5s of added serverless hold time on the happy path, before the write

`app/api/queue/route.ts:227-237` + `lib/youtube.ts:80` (`EMBEDDABLE_CHECK_TIMEOUT_MS = 1500`). The `await` sits on the accepted-submit path, between `checkSubmit` and `store.addEntry`. Worst case a paste submit now holds a function invocation ~1.5s longer than before while doing nothing.

An attacker who can reach a slow/blackholed upstream (or simply many concurrent paste submits) converts each request into 1.5s of held concurrency — function-duration billing and concurrency pressure amplification, on an endpoint with no authentication. 1.5s is a sane bound and much better than `lib/youtube-search.ts:175,193`, whose `fetch` calls have **no timeout at all**, so this is not the worst offender in the codebase. But it is new hold time on the most-hit mutation route.

**Recommendation:** the MEDIUM-1 cache removes this for the common case. Beyond that, consider tightening to ~800ms — the check is advisory, so a shorter budget costs only an occasional missing warning.

## LOW-1 — IP bucket keyed on the client-controllable leftmost `x-forwarded-for`

`lib/host-auth.ts:208-215` — `clientIpFrom` returns `xff.split(",")[0]`, the leftmost (client-supplied) hop. Where the platform *appends* rather than replaces, an attacker sets `X-Forwarded-For: <random>` per request and gets a fresh 60/min bucket every time, defeating the IP half of the dual bucket entirely (the uuid half is already defeatable — `patronUuid` is client-minted, `app/api/queue/route.ts:142-147` validates only its shape).

Pre-existing (identical pattern duplicated at `app/api/search/route.ts:38-45`), but it is the reason MEDIUM-1/MEDIUM-2 can't be waved off with "the rate limit covers it". Prefer `x-real-ip` first on Vercel, or take the rightmost trusted hop.

## LOW-2 — The one unguarded `await` on the success path: `getTranslations` is outside the fail-open envelope

`app/api/queue/route.ts:233-236`:

```ts
if (status === "not-embeddable") {
  const tw = await getTranslations("Errors");
  warning = tw("submitNotEmbeddable");
}
```

`checkEmbeddable` genuinely never throws (verified: `lib/youtube.ts:100-112`, single try/catch wrapping URL construction, fetch, and `res.json()`; every branch returns a value). But the *consumer* is not equally safe. `getTranslations` is a network/config-touching next-intl call, and here it runs on the **success** path for the first time — every other `getTranslations` in this route (`:157`, `:203`, `:257`, `:290`) is on an already-failing branch where a throw only changes a 4xx into a 5xx.

If next-intl throws here (missing namespace, locale-resolution failure, a message-loader error), a submit that was about to be accepted becomes an unhandled rejection → 500, and — because `store.addEntry` is at `:287`, *after* this block — the song is silently not queued. That is precisely the "a failure mode turns into a 5xx / a blocked submit" case this gate was asked to rule out. The window is narrow (requires `not-embeddable` **and** an i18n failure), and all three locales do carry `submitNotEmbeddable` (`messages/en.json:215`, `messages/es.json:215`, `messages/pt-BR.json:215`), so it is LOW, not higher.

**Recommendation:** wrap in try/catch and fall through with `warning = undefined`, or move the block after `store.addEntry`. The stated design rule ("NEVER blocks") should hold for the whole block, not just the helper.

## LOW-3 — `YOUTUBE_API_ORIGIN` sends the API key to an arbitrary operator-chosen origin (non-prod only)

`lib/youtube.ts:97-102`:

```ts
if (process.env.NODE_ENV !== "production" && process.env.YOUTUBE_API_ORIGIN) {
  return process.env.YOUTUBE_API_ORIGIN;
}
```

**On the SSRF question specifically: this is not request-reachable.** Nothing in the request body, headers, query, or path influences `apiOrigin()` — the value comes only from server process env. There is no user-controlled path into the host, and a request cannot set or influence `NODE_ENV`. The `NODE_ENV` guard is sufficient for the live site (Next sets `NODE_ENV=production` for `next build`/`next start`, and Vercel sets it for all deployments including previews).

The residual risk is operational, not request-driven: when the override *is* active, the real `YOUTUBE_API_KEY` is placed in the query string of a request to an unvalidated, unrestricted origin (`url.searchParams.set("key", key)`, `lib/youtube.ts:106`) — any scheme, any host, including `http://` and a remote host. A dev with a real key in `.env.local` plus a copy-pasted `YOUTUBE_API_ORIGIN` exfiltrates that key in cleartext. The variable is also undocumented (no `.env.example` entry, no mention anywhere outside `lib/youtube.ts`), so the constraint lives only in a comment.

**Recommendation:** constrain the override to loopback (`localhost`/`127.0.0.1`) and reject non-`http(s)`; and/or skip sending `key` at all when the override is in effect (a stub doesn't need it). Document the var.

## INFO-1 — Video-id handling in the outbound URL is correct (verified, no issue)

Recorded because it was the primary question. Defense in depth is properly layered:

- Route-level: `isValidVideoId(resolvedVideoId)` at `app/api/queue/route.ts:125` rejects before anything downstream.
- Helper-level re-validation: `lib/youtube.ts:92` — `if (!isValidVideoId(videoId)) return "unknown"` — the helper does not trust its caller.
- The regex is strictly anchored and character-classed: `/^[A-Za-z0-9_-]{11}$/` (`lib/youtube.ts:58`). No `.`, `/`, `?`, `&`, `#`, `%`, `:` can survive it, so path traversal, query injection (`&key=`, extra `part=`), and fragment tricks are all structurally impossible.
- URL construction is safe by mechanism, not by escaping discipline: `new URL(VIDEOS_ENDPOINT_PATH, apiOrigin())` with a **constant** path against a non-user origin, then `searchParams.set()` for every parameter (`lib/youtube.ts:103-107`). No string concatenation anywhere.
- Parameter order also matters and is right: `part` and `id` are set before `key`, and `set()` (not `append()`) means a duplicate can't shadow.

Conclusion: **no SSRF, no query injection, no user influence over host/path/params.** This is the correct pattern.

## INFO-2 — No data leakage; the TICKET-54 trimmed response shape is preserved

Verified against all three response sites:

- 201: `{ ok: true, ...(warning ? { warning } : {}) }` (`app/api/queue/route.ts:309`)
- 202: `{ pending: true, pendingId, ...(warning ? { warning } : {}) }` (`:280`)
- `warning` is only ever a message from the `Errors` namespace, and the three translations are **static strings with no ICU interpolation** (`messages/en.json:215`, `es.json:215`, `pt-BR.json:215`).

No `QueueEntry`, no `patronUuid`, no `videoId`, no title, no room state, no upstream YouTube payload, no API key, and no upstream error detail reaches the client — `checkEmbeddable` collapses every upstream response to a three-value enum before the route ever sees it, which structurally prevents Google error bodies (which can echo the key in some error shapes) from leaking. The spread-only-when-present form also means the response is byte-identical to today whenever there is no warning, so no existing consumer or test contract shifts.

Client render is safe too: plain text child in JSX (`PatronRoom.tsx:445-449`), React-escaped, no `dangerouslySetInnerHTML`, and guarded by `typeof w === "string"` (`:299-300`) so a hostile/garbled body can't inject an object into render.

## INFO-3 — Minor unauthenticated oracle for YouTube embeddability

A caller who completes a submit learns one bit about an arbitrary `videoId` (definitively not-embeddable vs. everything else), computed with our API key. Deliberately narrow: `unknown` conflates deleted, private, non-existent, quota-exhausted, and timed-out (`lib/youtube.ts:110-112`), so existence is *not* disclosed. Cost to the attacker is a completed queue submit. Not worth mitigating; noted for completeness.

## INFO-4 — Server-only helper now lives in a module a client component imports

`lib/youtube.ts` is imported by `components/SongSearch.tsx:5` (a client component, for `parseYouTubeVideoId`). `checkEmbeddable`/`apiOrigin` are now in that same module. No secret is at risk — the key is passed as an argument from the route and never read inside the module, and `process.env.YOUTUBE_API_ORIGIN` is not `NEXT_PUBLIC_`-prefixed so it inlines to `undefined` client-side. Production tree-shaking should drop the unused exports. Worth watching only as a bundle-hygiene point: a future edit that reads `process.env.YOUTUBE_API_KEY` *inside* this module would be a real leak. Consider splitting server-only helpers into `lib/youtube-server.ts` (or adding `import "server-only"` to a dedicated module).

---

## Things the change got right (worth recording)

- **Call placement is exactly right.** After body/size/JSON validation (`:63-78`), after id validation (`:125`), after uuid validation (`:142`), after the dual-bucket limiter (`:154`), after `checkSubmit` (`:198`). A malformed, throttled, or business-rule-refused submit spends zero quota. Placing it before `addEntry` also means an i18n failure can't leave a half-written state.
- **A timeout exists**, which is more than the pre-existing `searchYouTube`/`videos.list` calls can say (`lib/youtube-search.ts:175,193` have none). `AbortSignal.timeout` is the right primitive and the route runs on the Node runtime (no `export const runtime` override).
- **Fail-open is genuinely total inside the helper** — no key, invalid id, network error, abort, non-2xx, malformed JSON, and missing/non-boolean `status.embeddable` all return `"unknown"`, and only the explicit `"not-embeddable"` produces user-visible output.
- **Quota exhaustion degrades gracefully end to end.** `/api/search` already returns `200 { degraded: true, reason: "quota", results: [] }` on `YouTubeQuotaError` (`app/api/search/route.ts:112-114`), pushing patrons to the paste path — and the paste path's new check then returns `"unknown"`, so it adds no second failure. Nothing 5xxes, nothing blocks, no submit is lost.
- **The `source` hint is correctly treated as untrusted.** It is fenced to a fail-safe default (`app/api/queue/route.ts:122-123`: unknown value → `"search"`) and provably cannot influence acceptance, storage, authorization, or the response shape — only whether one advisory call is made. The comment at `:116-121` states this correctly. A malicious `source: "paste"` buys the attacker exactly the one quota unit covered by MEDIUM-1.
- **Client-side failure handling is right**: `await res.json().catch(() => null)` (`PatronRoom.tsx:298`) ensures an unparseable success body cannot flip a successful submit into an error.

## Recommended follow-up ticket (not merge-blocking)

One ticket covering MEDIUM-1 + MEDIUM-2: cache `checkEmbeddable` results in the existing Upstash layer, and add a self-imposed cross-instance daily quota ceiling that short-circuits both the embeddable check and `/api/search` to their degraded paths. That closes most of the new drain, most of the added latency, and — because it also covers the far larger pre-existing `/api/search` exposure — leaves the product's quota posture better than before this ticket.
