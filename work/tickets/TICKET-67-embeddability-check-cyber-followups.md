# TICKET-67 — TICKET-61 cyber gate follow-ups: quota-drain, cross-instance limiter, added hold time

**Status:** OPEN — filed, not yet scheduled
**Filed:** 2026-08-06, interactive TM session (TL present)
**Priority:** MEDIUM (genuine, but marginal — see mitigating context below)
**Type:** Backend hardening. Source: the TICKET-61 Cyber Security gate
(`work/reports/review/TICKET-61-cyber.md` on `ticket/61-paste-embeddability-warning`), verdict
PASS with 3 MEDIUM follow-ups, 0 CRITICAL/HIGH.

## Why this exists

PR #45 (TICKET-61, non-blocking embeddability warning on paste-submit) went through the full gate
chain — Dev, App Tester PASS, Cyber PASS, Reviewer opus APPROVE-WITH-FOLLOWUPS — and is held open
awaiting TL review (patron-facing). The Cyber gate's PASS carried 3 MEDIUM findings that are
genuine but non-blocking. This ticket tracks them so they are not lost to a PR comment thread.

## The 3 MEDIUM findings

**MEDIUM-1 — No cache on the outbound embeddability check; every repeat paste-submit of the same
video re-spends a YouTube quota unit.** `lib/youtube.ts:81-113` `checkEmbeddable` calls the Data
API unconditionally on every paste-path submit — no memoization, no cross-instance cache, no
negative cache. Contrast: `/api/search` got an Upstash-backed cross-instance cache in TICKET-55
("a hit burns zero quota"); this new path has nothing equivalent, despite a far higher expected
hit rate (embeddability of a given `videoId` is stable for days; a bar re-queues the same handful
of songs all night). With the current limiter (60/min/IP), that is up to ~86,400 units/day/IP
against a default 10,000-unit daily quota. Recommended fix: reuse `lib/search-cache.ts`'s Upstash
pattern keyed on `yt:embed:<videoId>`, long TTL for `embeddable`/`not-embeddable`, short TTL for
`unknown`.

**MEDIUM-2 — The only control gating the outbound call is an in-memory, per-instance rate
limiter.** `lib/queue-rate-limit.ts:34` is module-level state (`Map`), so on Vercel the effective
global limit is `60/min × number of warm instances` — a burst fanning out across instances is
barely limited. TICKET-55 already fixed this class of problem for the search *cache*; the
*limiter* was never migrated. Recommended fix: move the submit limiter to Upstash, or (cheaper)
add a dedicated cross-instance daily/hourly quota-budget counter on the outbound call itself
(`yt:quota:<date>`) that short-circuits `checkEmbeddable` to `unknown` once a self-imposed ceiling
is hit — this also protects `/api/search`.

**MEDIUM-3 — Up to 1.5s of added serverless hold time on the happy path, before the write.**
`app/api/queue/route.ts:227-237` + `lib/youtube.ts:80`
(`EMBEDDABLE_CHECK_TIMEOUT_MS = 1500`). Worst case, a paste submit now holds a function invocation
~1.5s longer than before. An attacker reaching a slow/blackholed upstream (or just many concurrent
paste submits) converts each request into 1.5s of held concurrency, on an unauthenticated
endpoint. Not the worst offender in the codebase (`lib/youtube-search.ts:175,193` has no timeout
at all), but new hold time on the most-hit mutation route. MEDIUM-1's cache removes this for the
common case; beyond that, consider tightening to ~800ms since the check is advisory.

## Mitigating context (from the cyber report, keep this framing)

**The dominant quota-drain vector is pre-existing and far cheaper to exploit.** `/api/search`
allows 30 req/10s/IP at ~100 quota units per `search.list` call — ~18,000 units/minute/IP, i.e.
the entire daily quota in under 4 seconds from one IP, with distinct queries bypassing the cache.
TICKET-61 adds a 1-unit-per-request drain to a surface that already has a 100-unit-per-request
drain. The marginal exposure from TICKET-61 is real but small — this is why the gate PASSed
rather than blocked.

## Also noted by the same gate (LOW, not part of this ticket's scope but worth knowing)

LOW-1 (client-controllable `x-forwarded-for` leftmost-hop IP bucketing, pre-existing, duplicated
in `/api/search` too), LOW-2 (`getTranslations` on the success path is outside the fail-open
envelope — narrow window, all 3 locales carry the string so LOW not higher), LOW-3
(`YOUTUBE_API_ORIGIN` dev-only override sends the API key to an unvalidated origin — not
request-reachable, operational risk only). Full detail in the cyber report if these get picked up
later.

## Acceptance criteria (whichever subset is scheduled)

- MEDIUM-1: `checkEmbeddable` results cached cross-instance on Upstash, keyed on `videoId`,
  fail-open preserved, TTL split (long for definitive results, short for `unknown`).
- MEDIUM-2: submit-path rate limiting is cross-instance (Upstash-backed or a dedicated quota
  budget counter), not per-lambda in-memory.
- MEDIUM-3: re-measure added hold time after MEDIUM-1 lands; only tighten the timeout further if
  still warranted.

## Not in scope

The LOW/INFO items above — noted for completeness, not this ticket's acceptance bar.
