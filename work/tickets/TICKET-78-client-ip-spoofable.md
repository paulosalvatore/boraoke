# TICKET-78 — `clientIpFrom` trusts a client-supplied `x-forwarded-for` (rate-limit bucket spoofable)

**Filed:** 2026-08-08, interactive TM session (TL present)
**Priority:** MED
**Size:** S
**Type:** Pre-existing security hardening gap. Source: found incidentally by the TICKET-72 (PR #57) reviewer while auditing an unrelated diff — not introduced by that PR.

## Why this exists

`clientIpFrom` (`lib/host-auth.ts:234`) derives the per-IP bucket key for the login-failure
throttle (and any other caller that uses it) from the `x-forwarded-for` header, taking the first
value in the list with no trusted-proxy pinning:

```ts
export function clientIpFrom(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  ...
}
```

Any client can set `x-forwarded-for` on its own request. On Vercel the platform does prepend the
real client IP as the first hop before forwarding, but nothing in this function verifies that the
header actually originated at Vercel's edge rather than being supplied — and forwarded verbatim —
by the client itself if a proxy in front of the app ever passes it through unmodified, or in any
deployment target other than Vercel's own edge. In production today this makes the IP used as the
rate-limit bucket key **client-controllable in principle**: an attacker can rotate the claimed IP
per request to spread failed-login attempts across many buckets instead of hitting one.

**Why this hasn't been an active incident:** `lib/rate-limit-counter.ts`'s login throttle also
keys per-`patronUuid` (or equivalent per-identity dimension) as a backstop, so a pure IP-rotation
attack does not by itself remove all rate limiting — it degrades the IP-side bucket, not the whole
defense. This is why the finding is MED, not HIGH.

## The fix

Pin IP derivation to a trusted-proxy model appropriate for the actual deploy target: on Vercel,
prefer `req.headers.get("x-real-ip")` or Vercel's own forwarded-IP mechanism where available, or at
minimum document and enforce that only the edge-appended value (last hop from a known proxy count)
is trusted rather than the client-suppliable first hop. If multi-target deploy is a real
possibility, make the trust boundary configurable rather than hardcoded to "first XFF entry."

## Acceptance criteria

- IP-derived rate-limit buckets can no longer be rotated by a client supplying arbitrary
  `x-forwarded-for` values on Vercel's actual request path.
- Existing login-throttle tests still pass; add a regression test asserting a forged `x-forwarded-for`
  does not let a request evade its IP bucket in the real deploy configuration.
- No change to the per-`patronUuid` backstop bucket.

## Not in scope

Redesigning the rate-limiting scheme itself; this is narrowly about trusting the right header/hop
for IP derivation.
