---
ticket: TICKET-153
product: boraoke
status: backlog
---

# TICKET-153 — A global daily budget for submit-path `videos.list` calls

**Filed:** 2026-10-15, by a Dev agent, from the TICKET-140 Cyber gate (LOW-2, `work/reports/security/TICKET-140-security.md`).
**Priority:** LOW (no security bypass; every outcome fails open).
**Type:** Abuse hardening / quota protection
**Size:** S
**Patron-facing:** no. **Gates:** Reviewer, Cyber.

## Problem

Since TICKET-140 every song submit asks `videos.list` (1 unit, `part=status,snippet,contentDetails`) on an `ec:` cache miss. A client that sends a fresh random 11-character id on each submit forces a miss every time. The submit limiter bounds that per instance at 10/min per patron and 60/min per IP, so one IP rotating patron UUIDs can spend about 3,600 units per hour.

That pool (about 10k/day) also feeds the nightly karaoke-index harvest (`playlistItems.list`) and the search durations. Draining it degrades the index and the durations. The bound was the same before TICKET-140 (a URL body always counted as a paste), so this is not new, but legitimate spend is higher now.

## Proposal

- A global daily budget (a Redis counter, same shape as `lib/search-budget.ts`) for submit-path `videos.list` calls. Once spent, the submit path falls back to oEmbed-only titles and an `unknown` embeddability verdict (fail-open, as today).
- Optional: cache a definite "no such video" (`videos.list` returns `items: []`, together with an oEmbed 404) as `missing` for longer, so a repeated random id costs nothing.

## Acceptance

- [ ] Submit-path `videos.list` calls stop at a configured daily cap; submits keep working past it.
- [ ] Tests prove the cap holds and that a submit past it still queues (fail-open).
- [ ] The harvest's share of the pool is protected (documented headroom).

## References

- TICKET-140 Cyber LOW-2; `lib/video-meta.ts` `lookupForSubmit`.
- Relates to TICKET-67 (cross-instance submit limiter).
