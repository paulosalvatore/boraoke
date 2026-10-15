---
ticket: TICKET-150
product: boraoke
status: filed
---

# TICKET-150 — Switch boraoke to Vercel Pro when it becomes a paid product

**Filed:** 2026-10-15, by the boraoke Tech Manager. TL decision 2026-10-15 (Global TM, prompt 022): stay on Hobby for now; track the switch as a backlog item.
**Priority:** LOW (backlog; trigger-based, not date-based)
**Type:** Ops / billing
**Size:** XS
**Patron-facing:** no. **TL decision and payment required.**

## Why

Vercel's fair-use guidelines (https://vercel.com/docs/limits/fair-use-guidelines, last_updated 2026-09-14): "Hobby teams are restricted to non-commercial personal use only. All commercial usage of the platform requires either a Pro or Enterprise plan." Their examples include "Any method of requesting or processing payment from visitors of the site." Once venues pay for boraoke it is commercial use.

## Trigger

The first moment boraoke charges anyone (a paid venue plan, ads, or any payment flow). Before that, nothing to do.

## What

Move the Vercel project to a Pro team, re-check cron settings (Pro allows finer intervals), function duration and the Upstash/Vercel limits that the catalogue epic budgeted against Hobby, and update any docs that say Hobby.

## Acceptance

- Project on Pro before the first paid venue goes live; deploy and crons verified after the move.

## References

- TICKET-141 (ruling 3), TICKET-146.
