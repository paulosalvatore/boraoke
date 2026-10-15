/**
 * Cross-instance DAILY `search.list` spend counter (TICKET-87).
 *
 * ─── The problem ────────────────────────────────────────────────────────────
 * Since 2026-06-01 Google allocates `search.list` its OWN hard cap of **100
 * calls per day, per project, platform-wide** — verified against primary docs
 * (https://developers.google.com/youtube/v3/getting-started and
 * .../determine_quota_cost): "Projects that enable the YouTube Data API have a
 * default quota allocation of 100 search.list calls, 100 videos.insert calls,
 * and 10,000 units per day combined for all other endpoints."
 *
 * Nothing in this codebase bounded the platform-wide DAILY TOTAL. The limiter in
 * lib/youtube-search.ts is a per-uuid/per-IP *velocity* window (5/uuid, 30/IP per
 * 10s) — it bounds how fast ONE actor may call, never how much the platform
 * spends in a day. At the per-IP ceiling a single client drains all 100 daily
 * searches in ~35 seconds, after which search is dead for EVERY venue until the
 * next reset. That is a cheap denial-of-service on the core feature.
 *
 * This module is the missing ceiling: an atomic, cross-instance, Pacific-day
 * counter that must be RESERVED before any outbound `search.list` call. It is
 * strictly ADDITIVE — it does not replace or weaken the velocity limiter, which
 * still runs first and still rejects with 429.
 *
 * ─── Day boundary ───────────────────────────────────────────────────────────
 * Google resets daily quotas at **midnight Pacific Time**, not UTC:
 *   "Daily quotas reset at midnight Pacific Time (PT)."
 *   — https://developers.google.com/youtube/v3/determine_quota_cost
 *   "For per-day quotas, the time period resets at midnight Pacific Time."
 *   — https://docs.cloud.google.com/docs/quotas/overview
 * and Pacific here is a WALL CLOCK, shifting with daylight saving (PST↔PDT):
 *   "Daily quotas refresh at midnight (0:00) Pacific Standard Time (PST) or
 *    Pacific Daylight Time (PDT), depending on the time of year."
 *   — https://docs.cloud.google.com/speech-to-text/docs/v1/quotas
 * So the counter is keyed to the calendar date in `America/Los_Angeles`, derived
 * via `Intl.DateTimeFormat` with that IANA zone — which is DST-correct by
 * construction and needs no offset arithmetic. Keying to UTC instead would have
 * rolled our counter over 7–8 hours BEFORE Google's, handing out a fresh 100 to
 * spend against a bucket Google still considers full: the failure mode is search
 * dying for the rest of the evening on a Google 403, which is the exact outcome
 * this ticket exists to prevent.
 *
 * ─── Reserve-before-spend, and NO refunds ───────────────────────────────────
 * `reserveSearchCall()` increments BEFORE the outbound call. Checking after (or
 * incrementing after) lets a concurrent burst all pass the check and overspend.
 *
 * A failed outbound call is NOT refunded, deliberately, for two reasons:
 *   1. Google's quota is charged on request RECEIPT, not on a 2xx. A 4xx/5xx
 *      answer means our call was received and billed; refunding it would
 *      systematically under-count real spend and walk us past the real cap.
 *   2. A refund-on-error path is directly exploitable: an attacker who can
 *      induce failures (malformed upstream conditions, forced timeouts) gets an
 *      unlimited number of *free* reservations, which converts the counter from
 *      a ceiling into decoration. Any refund rule is an attacker-triggerable
 *      credit, so there is no refund API here at all.
 * The cost of that choice is bounded and cheap: at worst a handful of the day's
 * budget is charged for calls that returned an error — and RESERVE_MARGIN below
 * exists precisely to absorb that.
 *
 * ─── Fail-CLOSED on an unreachable configured Redis ─────────────────────────
 * This is the load-bearing call, and it deliberately diverges from the fail-OPEN
 * ethos of lib/search-cache.ts and lib/rate-limit-counter.ts. Those fail open
 * because their failure is symmetric and cheap (a cache miss costs one quota
 * unit; a missed login-throttle tick costs a little brute-force headroom). Here
 * the asymmetry is severe and one-directional:
 *   - Fail OPEN during a Redis blip: every instance spends unaccounted. A blip
 *     that coincides with peak traffic (or with an attacker who is *watching*
 *     for one) burns the whole 100 and search is dead for every venue until
 *     midnight Pacific. NOT self-healing — the damage outlives the outage by
 *     hours and cannot be undone.
 *   - Fail CLOSED during a Redis blip: no NEW outbound searches for the duration
 *     of the blip. Self-healing the instant Redis returns; the in-process L1
 *     result cache still answers hot queries; and — the reason this is
 *     acceptable at all — the paste-a-YouTube-link path is completely unaffected,
 *     because it spends no `search.list` call. Patrons keep queueing songs.
 * Worst case fail-closed is strictly shorter-lived and strictly recoverable, so
 * fail-closed wins. A middle path (a small per-process emergency allowance
 * during an outage) was considered and REJECTED: serverless instance count is
 * unbounded, so any per-process allowance multiplies by an unbounded factor and
 * is not a bound at all.
 *
 * A DEPLOYED instance with NO Upstash configured is treated the same way —
 * denied, loudly (see `deployedWithoutStore`). Falling back to the in-process
 * counter there would be the per-process middle path rejected two paragraphs
 * above, granted silently as the default for a missing env var. The in-process
 * counter is therefore reached ONLY in local dev, CI and jest, where it is a
 * real ceiling for the single process that exists and keeps dev/CI behavior
 * unchanged.
 */

import "server-only";

import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";

/**
 * Google's hard platform-wide `search.list` allocation (see header). Not a knob:
 * changing it does not change what Google enforces.
 */
export const SEARCH_DAILY_CAP = 100;

/**
 * Headroom deliberately left unspent by patron traffic.
 *
 * We stop at SEARCH_DAILY_CAP - RESERVE_MARGIN = 90 rather than 100 so that
 * late in a drained day there is still budget for (a) a manual smoke test or a
 * support/debug search, (b) a handful of reservations charged for calls that
 * errored and are never refunded (see header), and (c) drift between our count
 * and Google's if any call is billed that we did not account for. Spending to
 * exactly 100 guarantees the first person to investigate the outage cannot even
 * reproduce it.
 */
export const RESERVE_MARGIN = 10;

/** Patron-reachable daily budget (90). */
export const SEARCH_DAILY_BUDGET = SEARCH_DAILY_CAP - RESERVE_MARGIN;

/** Remaining-budget level at or below which every spend logs a loud warning. */
export const LOW_WATER_MARK = 15;

// ─── Per-person daily sub-budgets (TICKET-126) ──────────────────────────────
//
// The 90 above bounds the PLATFORM's day. Nothing bounded one person's share of
// it, so a single patron (or a single script) could still spend all 90 and end
// search for every venue until midnight Pacific. Two sub-budgets sit inside it,
// both counted on the same Pacific day, in the same atomic script:
//
//   per DEVICE (default 10). Measured cost after the karaoke index and the
//   Enter/idle protocol: ~0.89 billed calls per queued song (replayed over
//   real production traces, work/measurements/ticket-125), ~1.3 on a bad night
//   of retries. A patron queues ~3-6 songs a night, so 6 x 1.3 = ~8: ten binds
//   only someone who is not queueing what they search, and caps one device at
//   ~11% of the day instead of 100%. The device key is client-minted (an
//   identity cookie or the uuid param), so this is a FAIRNESS bound for honest
//   patrons, not a security control.
//
//   per IP (default 45 = half the platform day). This is the anti-drain bound,
//   and it is only meaningful because the IP is edge-written and keyed by /64
//   (lib/client-ip.ts, TICKET-119). It has to be large: a venue night's patrons
//   share ONE bar Wi-Fi address, and a busy night (~60 songs) costs ~50 billed
//   calls. 90/day only buys ~100 queued songs platform-wide, so one busy bar is
//   most of the platform's capacity whatever the cap is. The line drawn is "no
//   single network takes more than half the day", which always leaves 45 for a
//   second venue. The trade-off, stated: a cap low enough to stop a one-IP
//   attacker taking a big share (say 15) starves an ordinary bar by its 15th
//   live search; at 45 a one-IP attacker can take half. A many-IP attacker can
//   still drain the day 45 at a time — the platform cap stays the hard ceiling.
//
// A capped person keeps everything free: cache hits and karaoke-index answers
// never reach a reservation, and paste-a-link costs nothing.
//
// Env-overridable (SEARCH_DEVICE_DAILY_CAP / SEARCH_IP_DAILY_CAP) so the
// numbers can be tuned without a code change once real telemetry exists. An
// override must be a positive integer and is clamped to the platform budget;
// anything else is ignored with a warning, so a typo can never remove a cap.

/** Default per-device daily sub-budget (see above). */
export const DEFAULT_DEVICE_DAILY_CAP = 10;
/** Default per-IP daily sub-budget (see above). */
export const DEFAULT_IP_DAILY_CAP = 45;

/**
 * Parse a cap override: a positive integer, clamped to the platform budget.
 * Absent → the default. Malformed → the default, with a warning.
 */
export function parseCapOverride(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1) {
    console.warn(`[search-budget] ignoring ${name}=${JSON.stringify(raw)} (not a positive integer); using ${fallback}`);
    return fallback;
  }
  return Math.min(n, SEARCH_DAILY_BUDGET);
}

/** Effective per-device cap (read per call so an env change needs no reload logic). */
export function deviceDailyCap(): number {
  return parseCapOverride(process.env.SEARCH_DEVICE_DAILY_CAP, DEFAULT_DEVICE_DAILY_CAP, "SEARCH_DEVICE_DAILY_CAP");
}

/** Effective per-IP cap. */
export function ipDailyCap(): number {
  return parseCapOverride(process.env.SEARCH_IP_DAILY_CAP, DEFAULT_IP_DAILY_CAP, "SEARCH_IP_DAILY_CAP");
}

/** Who a billed search is charged to (both keys are required together). */
export interface SearchPrincipal {
  /** Device key (identity cookie, else uuid, else anon@ip) — see the route. */
  device: string;
  /** Client IP bucket from lib/client-ip.ts. */
  ip: string;
}

/**
 * Opaque, fixed-length counter-key component. Not anonymisation (an IPv4 space
 * is small enough to enumerate); it keeps raw addresses and ids out of key
 * names and bounds key length whatever a client sent. Counters expire in 36h.
 */
function principalDigest(kind: "ip" | "dev", value: string): string {
  return createHash("sha256").update(`boraoke-search-${kind}-v1\0${value}`).digest("hex").slice(0, 32);
}

/** Namespace prefix — collision-free with `sc:` (search cache) and `rl:` (counters). */
const REDIS_PREFIX = "sb:";

/**
 * Key TTL. The DAY BOUNDARY IS CARRIED BY THE KEY NAME, not by this TTL — the
 * key embeds the Pacific calendar date, so a new day simply lands on a new key
 * that starts at zero. The TTL is pure garbage collection, which is why it is a
 * flat 36h rather than a computed "ms until the next Pacific midnight": a
 * computed TTL would reintroduce exactly the DST offset arithmetic the
 * `Intl`-based key exists to avoid, and getting it wrong would expire a live
 * counter early — silently handing out a second full budget mid-day. 36h > the
 * longest possible day (25h at the DST fall-back) with margin.
 */
const KEY_TTL_MS = 36 * 60 * 60 * 1000;

/**
 * Calendar date in `America/Los_Angeles` as `YYYY-MM-DD`.
 *
 * The IANA zone makes this DST-correct with no offset math, and the parts are
 * assembled by hand so the shape never depends on ICU locale data (see below).
 * Purely server-clock-derived — NO
 * caller/attacker input reaches this value, so the counter key cannot be
 * poisoned, split, or rotated by anything a patron sends.
 */
export function pacificDayKey(now: Date = new Date()): string {
  // `formatToParts` + manual assembly rather than relying on a locale's output
  // ORDER: under a small-ICU Node build an `en-CA` format string silently falls
  // back to `en-US` and yields "08/19/2026". That would still be a unique key
  // per day (so the counter would keep working), but the key shape is part of
  // this module's operational contract — it is what an operator greps for in
  // Redis — so it is pinned deterministically instead of inherited from ICU.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function redisKeyFor(day: string): string {
  return `${REDIS_PREFIX}${day}`;
}

/**
 * ATOMIC reserve-one. The whole check-then-increment runs inside ONE `EVAL`, so
 * Redis's single-threaded execution serializes it against every other instance's
 * attempt — the same reason lib/pending-store.ts's REJECT_ALL_PENDING_SCRIPT and
 * lib/rate-limit-counter.ts's REGISTER_FAILURE_SCRIPT are scripts rather than
 * command sequences. A client-side `GET` then `INCR` (two round-trips) is a
 * read-modify-write: N instances that all read 89 would all pass the check and
 * all increment, silently overspending by N-1. The stateless Upstash REST
 * transport has no WATCH and its MULTI/EXEC only pipelines a fixed command list,
 * so a script is the only primitive that can do this.
 *
 * KEYS[1] = counter key (`sb:<pacific-YYYY-MM-DD>`)
 * ARGV[1] = budget (max reservations allowed for the day)
 * ARGV[2] = key TTL in whole milliseconds
 *
 * Returns the number of reservations REMAINING after this one, or -1 when the
 * budget is exhausted and nothing was incremented. -1 is unambiguous: the
 * success branch can only return values >= 0.
 *
 * cjson is NOT used here, deliberately. TICKET-63 pinned the invariant that the
 * Lua round-trip in pending-store is lossless only because every persisted field
 * is a string or boolean — cjson coerces numbers through a double and would be a
 * live hazard for a counter. This script stores a bare Redis integer string and
 * returns a Lua number, which Redis converts to an exact integer reply. No JSON,
 * no float, no coercion.
 */
export const RESERVE_SEARCH_SCRIPT = `
local budget = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

local raw = redis.call('GET', KEYS[1])
local used = 0
if raw then used = tonumber(raw) or 0 end

if used >= budget then
  return -1
end

local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ttl)
end

return budget - count
`;

/**
 * ATOMIC reserve-one against THREE counters (TICKET-126): the platform day, the
 * caller's IP and the caller's device. All three are checked first, then all
 * three are incremented — or none is. A denial therefore never charges anyone,
 * and a grant charges everyone it should, in one serialized step (same
 * reasoning as RESERVE_SEARCH_SCRIPT above; the production Upstash database is
 * `redis_mode:standalone`, `cluster_enabled:0`, so a multi-key script needs no
 * hash tags — checked 2026-10-14).
 *
 * The platform cap is checked FIRST so a drained day reports as the day's
 * limit, not as one person's.
 *
 * KEYS[1] = platform key  KEYS[2] = ip key  KEYS[3] = device key
 * ARGV[1] = platform budget  ARGV[2] = ip cap  ARGV[3] = device cap  ARGV[4] = TTL ms
 *
 * Returns remaining platform budget (>= 0) on success, -1 platform exhausted,
 * -2 IP sub-budget exhausted, -3 device sub-budget exhausted.
 */
export const RESERVE_PRINCIPAL_SCRIPT = `
local budget = tonumber(ARGV[1])
local ipCap = tonumber(ARGV[2])
local devCap = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local function used(key)
  local raw = redis.call('GET', key)
  if raw then return tonumber(raw) or 0 end
  return 0
end

if used(KEYS[1]) >= budget then return -1 end
if used(KEYS[2]) >= ipCap then return -2 end
if used(KEYS[3]) >= devCap then return -3 end

local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ttl) end
for i = 2, 3 do
  if redis.call('INCR', KEYS[i]) == 1 then redis.call('PEXPIRE', KEYS[i], ttl) end
end

return budget - count
`;

// ─── Driver resolution (mirrors lib/store.ts / lib/rate-limit-counter.ts) ─────

function useUpstash(): boolean {
  const explicit = process.env.STORE_DRIVER?.toLowerCase();
  if (explicit === "upstash") return true;
  if (explicit === "memory") return false;
  return !!process.env.UPSTASH_REDIS_REST_URL;
}

let redisClient: Redis | null = null;
function getRedis(): Redis | null {
  if (!useUpstash()) return null;
  if (redisClient) return redisClient;
  try {
    redisClient = Redis.fromEnv();
    return redisClient;
  } catch {
    // Upstash SELECTED but unusable (missing/garbled creds). This is a
    // configuration failure, not a transient blip — and per the fail-closed
    // rationale in the header we must NOT silently fall back to the in-process
    // counter, which would be an unaccounted per-instance budget. Signal "no
    // client" and let the caller deny (see `configuredButUnavailable`).
    return null;
  }
}

/** True when Upstash is the selected driver but no client could be built. */
function configuredButUnavailable(): boolean {
  return useUpstash() && getRedis() === null;
}

/**
 * True in a real deployed environment (as opposed to local dev, CI, or jest).
 * Vercel sets VERCEL_ENV on every deployment including previews; NODE_ENV is
 * the fallback for any other host. Under jest NODE_ENV is "test" and VERCEL_ENV
 * is absent, so the suite gets the in-process path by default and opts INTO the
 * deployed path by setting VERCEL_ENV — deliberately, rather than the guard
 * special-casing "test" and thereby making itself untestable.
 */
function isDeployed(): boolean {
  return !!process.env.VERCEL_ENV || process.env.NODE_ENV === "production";
}

/**
 * SECURITY (review finding F-2): a DEPLOYED instance with no Upstash configured
 * must NOT fall back to the in-process counter.
 *
 * The header argues at length that a per-process allowance is not a bound at
 * all, because serverless instance count is unbounded — so silently landing on
 * `memReserve` in production would be that exact rejected middle path, granted
 * as the DEFAULT for a missing env var. One dropped secret on an env promotion
 * would silently un-do this whole ticket, and the only log output would be the
 * ordinary "spent 1 search.list" line, indistinguishable from healthy
 * operation. Measured in review: 5 simulated instances granted 450 reservations
 * against a hard cap of 100, with no warning emitted.
 *
 * So a deployed instance without Upstash is treated exactly like a configured
 * store that is unreachable: deny, and say so loudly. Local dev, CI and jest
 * are unaffected — they keep the in-process counter, which IS a real ceiling
 * for a single process.
 */
function deployedWithoutStore(): boolean {
  return isDeployed() && !useUpstash();
}

let warnedNoStore = false;
function warnDeployedWithoutStore(): void {
  if (warnedNoStore) return;
  warnedNoStore = true;
  console.error(
    "[search-budget] MISCONFIGURED: deployed without UPSTASH_REDIS_REST_URL, so the daily search.list budget cannot be enforced across instances. Denying all search.list spend (fail-closed). Paste-a-link is unaffected. Set the Upstash credentials to restore search.",
  );
}

// ─── In-process path (no Upstash configured: local dev / CI / single instance) ─

/**
 * Single-day in-process counter. Atomicity is free here: the read and the write
 * below happen in ONE synchronous block with no `await` between them, and JS is
 * single-threaded, so no interleaving is possible within an instance. It is NOT
 * cross-instance — which is exactly why the Redis path exists and why a
 * configured-but-broken Redis fails closed instead of landing here.
 */
/**
 * Counts keyed BY DAY rather than a single "current day + count" pair (review
 * finding F-5). A single pair resets on ANY day change, including a BACKWARDS
 * one — an NTP correction across the Pacific midnight, or simply two calls
 * whose clock readings straddle it out of order, re-granted a whole fresh
 * budget each time it flipped (measured: 3 budgets from a day2→day1→day2
 * sequence). Keying by day makes revisiting a day resume its count, which is
 * the same property the Redis path gets for free from the key name.
 *
 * Bounded to the two most recent days so it cannot grow.
 */
const memCounts = new Map<string, number>();
const MEM_DAYS_KEPT = 2;

function memReserve(day: string, budget: number): number {
  const used = memCounts.get(day) ?? 0;
  if (used >= budget) return -1;
  memCounts.set(day, used + 1);
  while (memCounts.size > MEM_DAYS_KEPT) {
    const oldest = memCounts.keys().next().value;
    if (oldest === undefined) break;
    memCounts.delete(oldest);
  }
  return budget - (used + 1);
}

/**
 * In-process per-person counters (TICKET-126), keyed `<day>|<ip|dev>|<digest>`.
 * Same single-synchronous-block atomicity as `memReserve`. Bounded: only the
 * two most recent days are kept, and at most MEM_PRINCIPAL_KEYS keys in total
 * (oldest evicted) — this path serves local dev / CI / a single process only,
 * where an evicted count merely re-grants a little headroom.
 */
const memPrincipal = new Map<string, number>();
const MEM_PRINCIPAL_KEYS = 5000;

function memReservePrincipal(
  day: string,
  budget: number,
  who: SearchPrincipal,
  ipCap: number,
  devCap: number,
): number {
  const ipKey = `${day}|ip|${principalDigest("ip", who.ip)}`;
  const devKey = `${day}|dev|${principalDigest("dev", who.device)}`;
  if ((memCounts.get(day) ?? 0) >= budget) return -1;
  if ((memPrincipal.get(ipKey) ?? 0) >= ipCap) return -2;
  if ((memPrincipal.get(devKey) ?? 0) >= devCap) return -3;
  const remaining = memReserve(day, budget);
  for (const k of [ipKey, devKey]) {
    const n = (memPrincipal.get(k) ?? 0) + 1;
    memPrincipal.delete(k);
    memPrincipal.set(k, n);
  }
  for (const k of memPrincipal.keys()) {
    if (memPrincipal.size <= MEM_PRINCIPAL_KEYS && memCounts.has(k.slice(0, k.indexOf("|")))) break;
    memPrincipal.delete(k);
  }
  return remaining;
}


// ─── Public API ──────────────────────────────────────────────────────────────

export interface BudgetReservation {
  /** True when one `search.list` call may now be issued. */
  ok: boolean;
  /** Reservations left for the Pacific day after this one (0 when denied). */
  remaining: number;
  /** The Pacific calendar day this decision was made against. */
  day: string;
  /**
   * Why a denial happened — `"cap"` (budget genuinely exhausted) or `"store"`
   * (the configured counter store was unreachable, so we fail closed rather than
   * spend unaccounted). Absent on success. Never surfaced to the patron: both
   * degrade to the same message, so the response body cannot be used to probe
   * infrastructure state.
   */
  reason?: "cap" | "store" | "ip" | "device";
}

/**
 * Reserve ONE `search.list` call. MUST be called immediately before the outbound
 * request, and its result MUST gate that request. There is no refund (header).
 *
 * Returns `{ ok: false }` when the day's budget is spent OR when a configured
 * Redis is unreachable (fail-closed — see header). Never throws.
 */
export async function reserveSearchCall(
  now: Date = new Date(),
  who?: SearchPrincipal,
): Promise<BudgetReservation> {
  const day = pacificDayKey(now);
  const budget = SEARCH_DAILY_BUDGET;
  const ipCap = ipDailyCap();
  const devCap = deviceDailyCap();

  if (deployedWithoutStore()) {
    warnDeployedWithoutStore();
    logDenied(day, "store");
    return { ok: false, remaining: 0, day, reason: "store" };
  }

  if (configuredButUnavailable()) {
    logDenied(day, "store");
    return { ok: false, remaining: 0, day, reason: "store" };
  }

  const redis = getRedis();
  if (!redis) {
    const remaining = who
      ? memReservePrincipal(day, budget, who, ipCap, devCap)
      : memReserve(day, budget);
    if (remaining < 0) return denied(day, remaining);
    logSpend(day, remaining);
    return { ok: true, remaining, day };
  }

  let remaining: number;
  try {
    const res = who
      ? await redis.eval(
          RESERVE_PRINCIPAL_SCRIPT,
          [
            redisKeyFor(day),
            `${REDIS_PREFIX}${day}:ip:${principalDigest("ip", who.ip)}`,
            `${REDIS_PREFIX}${day}:dev:${principalDigest("dev", who.device)}`,
          ],
          [budget, ipCap, devCap, Math.round(KEY_TTL_MS)],
        )
      : await redis.eval(
          RESERVE_SEARCH_SCRIPT,
          [redisKeyFor(day)],
          [budget, Math.round(KEY_TTL_MS)],
        );
    // SECURITY (review finding F-1) — validate the TYPE before any coercion.
    //
    // The previous guard was `Number(res)` + `Number.isFinite`, which is a
    // fail-OPEN hole punched straight through this fail-CLOSED module:
    // `Number(null)`, `Number("")`, `Number([])` and `Number(false)` are all
    // `0` — finite, not negative — so an EVAL reply of `null` fell through to
    // "reservation granted, 0 remaining" and kept granting FOREVER, with no
    // denial and no error log. Measured in review: 1000/1000 requests granted.
    // That is strictly worse than the fail-open behaviour this module's header
    // spends twenty lines arguing against, and it is reachable from any
    // REST-transport anomaly that returns 200 with an absent/null result
    // (gateway rewrite, an Upstash response-shape change, a stubbed client in a
    // preview environment).
    //
    // The script's only legitimate reply is a Redis integer, so anything that
    // is not an integer number/bigint is an anomaly and must DENY, not coerce.
    if (typeof res === "bigint") remaining = Number(res);
    else if (typeof res === "number" && Number.isInteger(res)) remaining = res;
    else throw new Error(`unexpected EVAL reply (${typeof res}): ${String(res)}`);
  } catch (err) {
    // FAIL CLOSED. Unlike the cache and the login throttle, an unaccounted spend
    // here is unrecoverable for the rest of the Pacific day (header).
    console.warn(
      `[search-budget] counter store unreachable — DENYING search.list for ${day} (fail-closed):`,
      err,
    );
    return { ok: false, remaining: 0, day, reason: "store" };
  }

  if (remaining < 0) return denied(day, remaining);
  logSpend(day, remaining);
  return { ok: true, remaining, day };
}

/**
 * Map a script/memory denial code to a reservation. -1 is the platform cap;
 * -2 / -3 are the caller's IP / device sub-budget. Any other negative is
 * treated as the platform cap (deny, never grant).
 */
function denied(day: string, code: number): BudgetReservation {
  const reason = code === -2 ? "ip" : code === -3 ? "device" : "cap";
  logDenied(day, reason);
  return { ok: false, remaining: 0, day, reason };
}

// ─── Observability ───────────────────────────────────────────────────────────

function logSpend(day: string, remaining: number): void {
  const line = `[search-budget] spent 1 search.list — ${remaining}/${SEARCH_DAILY_BUDGET} remaining for PT day ${day} (hard cap ${SEARCH_DAILY_CAP}, margin ${RESERVE_MARGIN})`;
  // Loud once the day is nearly gone so near-exhaustion is visible in logs
  // BEFORE search stops working, not discovered by a venue.
  if (remaining <= LOW_WATER_MARK) console.warn(line);
  else console.info(line);
}

function logDenied(day: string, reason: "cap" | "store" | "ip" | "device"): void {
  console.warn(
    `[search-budget] DENIED search.list for PT day ${day} — reason=${reason} (budget ${SEARCH_DAILY_BUDGET} of hard cap ${SEARCH_DAILY_CAP}); paste-a-link is unaffected`,
  );
}

/**
 * Test-only: reset the in-process counter. Deliberately memory-only — it never
 * touches Redis, so it can never wipe a production day's counter.
 */
export function _resetSearchBudget(): void {
  memCounts.clear();
  memPrincipal.clear();
  warnedNoStore = false;
}

/** Test-only: drop the memoized Redis client so driver resolution re-runs. */
export function _resetBudgetClient(): void {
  redisClient = null;
}
