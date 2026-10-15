---
ticket: TICKET-146
product: boraoke
status: filed
---

# TICKET-146 — Refresh scale-out and 30-day-safe by-ID refresh

**Filed:** 2026-10-15, by the boraoke Tech Manager, from `work/plans/EPIC-song-catalogue-plan.md` (section (e) and its "Independent verification (2026-10-15)" table). TL decisions 2026-10-15 (Global TM, prompt 022): epic approved, file 141-149 in the plan order after #90 and TICKET-140; patron-facing parts need a TL OK (via the Global TM) before merge.
**Priority:** MEDIUM
**Type:** Cron / retention
**Size:** S (shrunk from S–M)
**Patron-facing:** no.

## Correction from the verification

The plan assumed a 60 s Hobby function limit. That is boraoke's own `maxDuration = 60` (`app/api/cron/karaoke-index/route.ts:24`). Vercel Hobby with fluid compute allows up to **300 s** (https://vercel.com/docs/functions/configuring-functions/duration, 2026-08-24). Whether this project has fluid compute on is UNVERIFIABLE from the repo. So first try raising `maxDuration` and the run cutoffs (~5x channels per run, ~18 to ~90) before adding crons. Only if that does not bring the cycle under the limit, add N daily slot crons (Hobby allows 100, once per day each).

## What

- Raise `maxDuration` and the cutoffs (`refresh.ts:40-46`), confirming fluid compute on the project.
- Slot crons over disjoint shard slices only if needed. Shared Redis daily unit counter (cap per the plan's budget table: <= 600 existing, <= 3,000 new harvest, <= 500 by-ID).
- `videos.list` by-ID refresh for `ki:obs` links queued again within 30 days (renews them); others expire.

## Acceptance

- Test: a simulated 600-channel set cycles in under 21 days at 0.8 s/call, with the measured per-run capacity.
- No link served past 30 days (retention guard from 144).

## References

- `lib/karaoke-index/refresh.ts`, `vercel.json`, `app/api/cron/karaoke-index/route.ts`, TICKET-137, 144.
