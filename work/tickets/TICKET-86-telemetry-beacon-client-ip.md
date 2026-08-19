# TICKET-86 — `/api/t` telemetry beacon still derives its rate-limit IP bucket from the spoofable `x-forwarded-for` first hop

**Filed:** 2026-08-19, heartbeat fire (Product TM, unattended)
**Priority:** MED
**Size:** S
**Type:** Security hardening — the duplicate of TICKET-78 left behind in a second file.

## Why this exists

TICKET-78 (PR #59, merged `f9f648d`) fixed `clientIpFrom` in `lib/host-auth.ts` so the per-IP
rate-limit bucket is derived from the edge-set `x-real-ip` (which Vercel writes and overwrites at
the edge) rather than the client-suppliable first hop of `x-forwarded-for`. That fire explicitly
surfaced — and deliberately left out of scope, to keep the increment bounded — a **second copy of
the same pattern** in `app/api/t/route.ts`:

```ts
function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() ?? "";
}
```

This value is the IP half of the beacon's dual-bucket limiter
(`beaconRateLimitOk(rateKey, clientIp(req))`, `lib/telemetry-rate-limit.ts`, 300 events/min/IP).
A caller that rotates a forged `x-forwarded-for` per request spreads its beacon traffic across
unlimited IP buckets, so the IP ceiling stops binding and the only remaining limit is the
session bucket — which is itself client-minted (`uuid`/`sessionKey`), exactly the rotation the
dual-bucket design exists to defend against.

**Severity is MED, not HIGH**, for the same reason TICKET-78 was: the impact is a degraded
rate-limit dimension on a fail-open, write-only telemetry endpoint (over-limit events are silently
dropped with a 204; nothing here authenticates or mutates product state). The concrete exposure is
telemetry-store pollution / write amplification, not account or queue compromise.

## The fix

Use the already-hardened, already-reviewed `clientIpFrom` from `lib/host-auth.ts` instead of
keeping a second, divergent copy of the derivation. Do **not** edit `lib/host-auth.ts` — import it.
(Four sibling ticket branches are concurrently in flight against that file's history; this ticket
stays import-only and file-disjoint from all of them by design.)

Trust ordering inherited from TICKET-78: optional `TRUSTED_CLIENT_IP_HEADER` override →
edge-set `x-real-ip` → `x-forwarded-for` first hop (dev / non-Vercel fallback) → `"unknown"`.

### The one behavioural seam that must be handled deliberately

`clientIpFrom` returns the sentinel string `"unknown"` when no header is present;
the current `clientIp` returns `""`. Those are **not** interchangeable here:
`beaconRateLimitOk` documents `""` as "bucket unavailable → this bucket does not apply", whereas
`"unknown"` would become a real, shared 300/min bucket that every header-less caller charges
together. Unit tests and local dev issue header-less requests.

Decide and implement one of these explicitly, with a test pinning the choice:

- **(preferred)** map the sentinel back to the beacon's own convention — `const ip = clientIpFrom(req); return ip === "unknown" ? "" : ip;` — preserving today's fail-open behaviour exactly for header-less requests while closing the spoof vector for real ones; or
- adopt the shared `"unknown"` bucket deliberately, and update the limiter's contract comment plus any test that depends on header-less requests being IP-unlimited.

## Acceptance criteria

1. `app/api/t/route.ts` no longer reads `x-forwarded-for` ahead of `x-real-ip`; the beacon's IP
   bucket key comes from the shared, hardened derivation.
2. `lib/host-auth.ts` is **unmodified** (import only).
3. A test proves the spoof is closed: a request carrying both `x-real-ip: <edge>` and a forged
   `x-forwarded-for: <attacker>` buckets under `<edge>`. The test must be **discriminating** —
   verify it fails against the old implementation before accepting it.
4. A test pins the header-less behaviour chosen above (no silent change to fail-open telemetry).
5. Full `npx jest` suite green, `npx next build` exit 0, `tsc --noEmit` shows no new errors beyond
   the known pre-existing baseline (`__tests__/youtube.test.ts`, e2e specs).

## Out of scope

Any change to `lib/host-auth.ts`, `lib/telemetry-rate-limit.ts`'s limits, or the beacon's
fail-open posture. No UI, no route-shape change.
