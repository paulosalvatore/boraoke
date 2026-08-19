# TICKET-87 — Cross-instance daily `search.list` spend counter (highest-priority open item)

**Filed:** 2026-08-19, interactive TM session (TL present)
**Priority:** HIGH
**Size:** M
**Type:** Security / quota-protection hardening

## Why this exists

TICKET-85's spike (PR #58) established that the real post-2026-06-01 YouTube quota model puts
`search.list` in its own hard cap: **100 calls/day, platform-wide, per API key** — not the old
"10,000 units/day ≈ 99 searches" framing this board carried until this session. `videos.list` /
`playlistItems.list` etc. sit in a separate, barely-touched 10,000-unit pool.

The existing search rate limiter (`lib/youtube-search.ts`) is a per-uuid/per-IP sliding window
sized for the *old* abundant-quota world:

```ts
const RATE_MAX = 5;       // per-uuid requests per 10s window
const RATE_IP_MAX = 30;   // per-IP requests per 10s window
const RATE_WINDOW_MS = 10_000;
```

`RATE_IP_MAX = 30` per 10s means **one IP alone can issue 30 `search.list` calls every 10
seconds**. At that rate, draining the entire **100-call/day platform cap** takes only
`100 / 30 × 10s ≈ 33–35 seconds` — confirmed by reading the constants directly, not estimated.

This is **pre-existing, not a regression from TICKET-83** (TICKET-83 reduced the common-path call
count per search, which helps, but does nothing about a single actor blasting the limiter's own
generous per-IP ceiling). The new hard 100-call/day cap turns what used to be "a slightly generous
per-IP allowance" into a **cheap, trivial denial-of-service on the product's core feature** — one
malicious or misbehaving client (or one aggressive bot) can exhaust the daily search budget for
**every venue on the platform** in well under a minute, long before any human notices.

## What's needed

The per-uuid/per-IP sliding-window limiter is necessary but not sufficient — it bounds a single
actor's burst rate, but nothing today bounds the **platform-wide daily total** against the
100-call/day cap. Needs a **cross-instance daily spend counter** (Upstash-backed, matching the
pattern already used for the search cache and the pending-store — `INCR`/`EXPIRE` or a Lua EVAL
for atomicity) that:

- Tracks total `search.list` calls issued today, shared across all serverless instances.
- Refuses new searches once a safety margin below 100 is reached (fail toward "no more calls
  today", not fail-open — unlike the cache, which is allowed to fail open because a cache miss
  only costs quota, whereas an unbounded counter failure risks silently exhausting the cap).
- Resets on a clear daily boundary (UTC day, matching however Google resets the cap — the exact
  reset time is unconfirmed; verify before implementing the reset logic).
- Is visible in the existing rate-limit/telemetry surface so a near-exhaustion event is loud, not
  discovered only when every venue's search stops working.

Out of scope for this ticket: retuning `RATE_MAX`/`RATE_IP_MAX` themselves (a separate, smaller
follow-up) and the unresolved question from TICKET-85 of whether a quota-increase-form approval
raises the **call** cap at all post-June (see the `youtube-quota-form.md` correction ticket).

## Acceptance criteria

- A cross-instance counter blocks new `search.list` calls once the platform is within a defined
  safety margin of the 100-call/day cap, verified under concurrent/parallel requests (not just a
  single-instance test).
- The existing per-uuid/per-IP window limiter is untouched or only tightened, never loosened.
- Behavior on counter-store failure is deliberate and documented (recommend fail-closed for this
  one, unlike the cache and most other Upstash-backed features in this repo, given the asymmetry
  between "search briefly slower" and "platform search dead for the rest of the day").
- A test proves the 100th-call boundary is enforced deterministically, not racily.
