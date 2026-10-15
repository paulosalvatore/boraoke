# TICKET-131 — One IPv6 subscriber can drain the platform's daily search budget: the per-IP cap is half the day and IPv6 is keyed at /64

**Filed:** 2026-10-15, by the TICKET-126 Dev, from Cyber Security finding M-2 on PR #90 (`work/reports/security/TICKET-126-security.md`). Accepted residual of TICKET-126, not fixed there.
**Priority:** MED
**Type:** Security / abuse resistance (billed-search budget)
**Size:** S

## What

TICKET-126 splits the platform's daily `search.list` budget (90 usable calls) into per-device (10) and per-IP (45) daily shares. The per-IP cap is exactly half the platform day, and `lib/client-ip.ts` keys IPv6 addresses at their /64.

Many ISPs delegate a /56 (256 /64s) or a /48 (65,536 /64s) to a single subscriber. Every /64 inside that delegation is a separate per-IP bucket, so one ordinary home or mobile subscriber, not a botnet, can spend the whole platform day by rotating source addresses across two /64s. A dual-stack phone already has two buckets for free (its IPv4 plus its IPv6 /64), which is exactly 2 x 45 = 90.

## Evidence (Cyber Security probe P1, 2026-10-15)

- 256 addresses taken from one /56 → **256 distinct buckets** from `clientIpFrom`.
- 256 addresses taken from one /64 → **1 bucket** (the /64 keying itself is correct).

## Why it matters

When the platform day is spent, every patron in every venue loses live search until the next day (they keep the karaoke index, the cache and paste-a-link). TICKET-126 is still a clear improvement on the previous state, where one device could spend 100% of the day; this ticket closes the remaining "one subscriber" gap.

## What's needed

Pick one or combine:

- **Key IPv6 at /56** instead of /64 (one subscriber normally holds at least a /56). Cost: patrons sharing a /56 share a bucket, which is rare outside one household or one venue network.
- **Add a coarser counter** (/56 or /48) inside the same atomic reserve script, alongside the /64 bucket, so a /64-rotating subscriber hits the coarser cap.
- **Lower the per-IP cap below half the day** (for example 30 of 90), so draining the day takes three or more networks rather than two.

Whichever is chosen, the cap value and keying rule should be stated in the `lib/client-ip.ts` module header and `lib/search-budget.ts`.

## Constraints

- Read **`prove-your-test-can-fail`**: the regression test must rotate addresses across one /56 (or across a /48, if that is the chosen boundary) and must FAIL against today's /64 keying or today's cap.
- The reserve must stay one atomic script (all counters charged or none), as in TICKET-126.
- Keep IPv4-mapped IPv6 (`::ffff:a.b.c.d`) folding to the IPv4 address.
