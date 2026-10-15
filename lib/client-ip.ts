/**
 * The ONE place a client IP is derived for use as a rate-limit / budget key.
 *
 * Every throttle in the app keys off this: host login and claim failures, room
 * creation, queue submits, telemetry beacons, and the search rate limiter and
 * per-IP daily search sub-budget. A key the client can choose is not a bound, so
 * what matters here is which header is TRUSTED, not which header is present.
 *
 * ─── What Vercel guarantees (primary source) ────────────────────────────────
 * https://vercel.com/docs/headers/request-headers :
 *   x-forwarded-for — "we currently overwrite the X-Forwarded-For header and do
 *     not forward external IPs. This restriction is in place to prevent IP
 *     spoofing." (A custom value survives only with the Enterprise Trusted Proxy
 *     add-on, which this project does not use.)
 *   x-vercel-forwarded-for — "identical to the x-forwarded-for header. However,
 *     x-forwarded-for could be overwritten if you're using a proxy on top of
 *     Vercel."
 *   x-real-ip — "identical to the x-forwarded-for header."
 * Verified against production on 2026-10-14, and only for `x-real-ip`: 14
 * failed claims, each sending a different forged value in all three headers,
 * returned 401 x10 then 429 x4 — one bucket. The deployed code at the time
 * keyed on `x-real-ip` first, so that run proves the edge overwrites a
 * client-sent `x-real-ip`. It says nothing about the other two headers, whose
 * client-sent copies were never read.
 *
 * So on Vercel `x-real-ip` is read first, because it is the header proven
 * against production. `x-vercel-forwarded-for` and then `x-forwarded-for` are
 * fallbacks for a request that somehow arrives without it; the docs say the
 * edge writes both, but a forged copy surviving is not ruled out by a probe.
 *
 * ─── Everywhere else nothing overwrites anything ────────────────────────────
 * Under `next start` / `next dev` / any other host, every one of these headers
 * is whatever the client typed. The earlier derivation fell back to them anyway,
 * which is how a rotating x-forwarded-for reset the host-code brute-force
 * throttle in a local re-gate (1200 rotating-key claims, 429 back to 401).
 * Off Vercel we therefore trust a header ONLY when the operator names it in
 * `TRUSTED_CLIENT_IP_HEADER` (the header their own trusted proxy sets). With no
 * declaration every request shares the single "unknown" bucket — fail-CLOSED:
 * over-throttling an undeclared deployment is a nuisance, an attacker-chosen
 * bucket is no throttle at all.
 *
 * IPv6 is keyed by its /64. One subscriber is normally delegated a whole /64,
 * so per-address keys would let a single host rotate through 2^64 buckets.
 */

/** The shared bucket for a request whose address cannot be trusted or found. */
export const UNKNOWN_CLIENT_IP = "unknown";

/** Headers Vercel's edge writes, production-verified first (see header). */
const VERCEL_IP_HEADERS = ["x-real-ip", "x-vercel-forwarded-for", "x-forwarded-for"] as const;

/** Longest value we will use as a key, so a hostile header cannot bloat one. */
const MAX_KEY_LENGTH = 64;

function onVercel(): boolean {
  return process.env.VERCEL === "1";
}

/** First comma-separated hop of a header value, trimmed; "" when absent. */
function firstHop(value: string | null): string {
  if (!value) return "";
  return value.split(",")[0]?.trim() ?? "";
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(s: string): boolean {
  const m = IPV4_RE.exec(s);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

/**
 * Expand an IPv6 literal into its eight 16-bit groups, or null when it is not
 * one. Handles `::` compression and an embedded trailing IPv4 (`::ffff:1.2.3.4`).
 */
function ipv6Groups(s: string): number[] | null {
  if (!s.includes(":") || !/^[0-9a-fA-F:.]+$/.test(s)) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (i === pieces.length - 1 && p.includes(".")) {
        if (!isIpv4(p)) return null;
        const o = p.split(".").map(Number);
        out.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * Normalise a raw client address into a bucket key:
 *   - IPv4 stays as-is;
 *   - an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) becomes the IPv4 it maps;
 *   - any other IPv6 address becomes its /64 prefix, `xxxx:xxxx:xxxx:xxxx::/64`;
 *   - anything else (not an address at all) is kept, trimmed and length-capped,
 *     so a garbled value is still ONE bucket rather than an error;
 *   - empty becomes the shared "unknown" bucket.
 */
export function normaliseIpBucket(raw: string): string {
  const s = raw.trim();
  if (s === "") return UNKNOWN_CLIENT_IP;
  if (isIpv4(s)) return s;
  const g = ipv6Groups(s);
  if (g) {
    const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
    if (mapped) return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    return `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
  }
  return s.slice(0, MAX_KEY_LENGTH);
}

/**
 * Client IP bucket key for a request. See the module header for the trust
 * rules: an explicitly declared `TRUSTED_CLIENT_IP_HEADER` wins; otherwise on
 * Vercel the edge-written headers are used; otherwise "unknown" (shared).
 */
export function clientIpFrom(req: { headers: Headers }): string {
  const declared = process.env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (declared) return normaliseIpBucket(firstHop(req.headers.get(declared)));
  if (onVercel()) {
    for (const h of VERCEL_IP_HEADERS) {
      const v = firstHop(req.headers.get(h));
      if (v) return normaliseIpBucket(v);
    }
  }
  return UNKNOWN_CLIENT_IP;
}
