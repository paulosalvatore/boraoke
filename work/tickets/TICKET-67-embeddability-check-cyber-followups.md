---
ticket: TICKET-67
title: Submit-path rate limiter is per-instance, not cross-instance
product: boraoke
status: filed
---

# TICKET-67 — Submit-path rate limiter is per-instance, not cross-instance

**Filed:** 2026-08-06, from the TICKET-61 Cyber Security gate (`work/reports/review/TICKET-61-cyber.md` on `ticket/61-paste-embeddability-warning`), MEDIUM-2.
**Rescoped:** 2026-10-15 backlog cleanup (`work/cleanup/2026-10-15/LEDGER.md`). This card originally carried three MEDIUM findings. Two have shipped and are out of scope now:

- MEDIUM-1 (no cache on the embeddability check) shipped in #74: cross-instance cache in `lib/embed-cache.ts`.
- MEDIUM-3 (1.5 s added hold time) shipped: `EMBEDDABLE_CHECK_TIMEOUT_MS = 800` in `lib/youtube.ts:102`.

## The one open item

The only control gating the outbound embeddability call on paste-submit is an in-memory, per-instance rate limiter. `lib/queue-rate-limit.ts:34` is module-level state (`const hits = new Map<string, number[]>()`), so on Vercel the effective global limit is `60/min x number of warm instances`. A burst that fans out across instances is barely limited. TICKET-55 fixed this class of problem for the search cache, but the submit limiter was never migrated.

Overlaps TICKET-140 item 8, but 140's acceptance criteria do not require fixing it, so it stays here.

## Fix options

- Move the submit limiter to Upstash (same pattern as `lib/search-cache.ts`), or
- (cheaper) add a cross-instance daily/hourly quota-budget counter on the outbound call itself (`yt:quota:<date>`) that short-circuits `checkEmbeddable` to `unknown` once a self-imposed ceiling is hit. This also protects `/api/search`.

## Acceptance

- Submit-path rate limiting is cross-instance (Upstash-backed or a dedicated quota-budget counter), not per-lambda in-memory.
- Fail-open behaviour on the paste path is preserved.
