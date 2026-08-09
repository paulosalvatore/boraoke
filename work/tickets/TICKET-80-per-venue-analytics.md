# TICKET-80 — Per-venue analytics (TICKET-77 exposed the gap)

**Filed:** 2026-08-08, interactive TM session (TL present)
**Priority:** MED
**Size:** Needs scoping — likely M/L (new authenticated, room-scoped endpoint + UI)
**Type:** Product gap, needs a Tech-Lead call on timing.

## Why this exists

`/admin/analytics` (`app/admin/analytics/page.tsx`, from TICKET-31) is deliberately **global,
site-wide** and gated on the single site-wide `HOST_TOKEN` secret (see the page's own header
comment: "reuses the SAME host-session gate as `/[room]/admin`... i.e. the site's existing
HOST_TOKEN"). TICKET-77 (PR #56, merged) surfaced a link to this page from the per-room admin
header whenever the session is authorised — but authorisation there is the same single site-wide
token, not anything scoped to the venue/room the host actually runs.

**The real gap this exposes:** a venue host who only knows their own room's host code has no way
to reach analytics for their own room at all — the only analytics surface is the global one, gated
on a secret venue hosts don't hold. Today's per-room host dashboard shows only live, in-session
queue counters; there is no history view scoped to a single room.

**This is the thing a real venue host actually wants** — "how did my Tuesday night go, what got
played, how many singers" — not the operator's cross-venue rollup.

## Shape of the fix (not yet designed)

- A room-scoped, authenticated analytics endpoint (`/api/host/analytics?room=<slug>` or similar),
  gated on that room's own host session (the same per-room auth `/[room]/admin` already uses), not
  the site-wide `HOST_TOKEN`.
- A room-scoped analytics view reachable from a room's own admin dashboard.
- Decide whether this reuses/generalizes `lib/analytics.ts`'s existing aggregation logic
  room-filtered, or needs new query shapes.

## TL decision needed

Whether this lands as a near-term ticket or waits for Phase 2 (the anon-identity-registry /
accounts work already tracked under TICKET-26/28's growth arc) — a real per-venue accounts model
may be the more natural place to hang room-scoped analytics auth, rather than building a second
one-off room-scoped auth path ahead of it.

## Not in scope (yet)

Implementation — this ticket exists to record the gap and get a priority/timing call before any
design work starts.
