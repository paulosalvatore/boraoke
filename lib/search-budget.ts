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
 * IMPORTANT — "fail closed" applies ONLY to a Redis that is CONFIGURED and
 * failing. When Upstash is not configured at all (local dev, CI, zero-secret
 * boot) this module uses the in-process counter, exactly like every sibling
 * store's driver resolution. That path is still a real ceiling for a
 * single-instance deployment, and it keeps dev/CI behavior unchanged.
 */

import "server-only";

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
 * `en-CA` yields ISO-ordered `YYYY-MM-DD` for the given zone; the IANA zone
 * makes this DST-correct with no offset math. Purely server-clock-derived — NO
 * caller/attacker input reaches this value, so the counter key cannot be
 * poisoned, split, or rotated by anything a patron sends.
 */
export function pacificDayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
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

// ─── In-process path (no Upstash configured: local dev / CI / single instance) ─

/**
 * Single-day in-process counter. Atomicity is free here: the read and the write
 * below happen in ONE synchronous block with no `await` between them, and JS is
 * single-threaded, so no interleaving is possible within an instance. It is NOT
 * cross-instance — which is exactly why the Redis path exists and why a
 * configured-but-broken Redis fails closed instead of landing here.
 */
let memDay = "";
let memUsed = 0;

function memReserve(day: string, budget: number): number {
  if (memDay !== day) {
    memDay = day;
    memUsed = 0;
  }
  if (memUsed >= budget) return -1;
  memUsed += 1;
  return budget - memUsed;
}

function memUsage(day: string): number {
  return memDay === day ? memUsed : 0;
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
  reason?: "cap" | "store";
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
): Promise<BudgetReservation> {
  const day = pacificDayKey(now);
  const budget = SEARCH_DAILY_BUDGET;

  if (configuredButUnavailable()) {
    logDenied(day, "store");
    return { ok: false, remaining: 0, day, reason: "store" };
  }

  const redis = getRedis();
  if (!redis) {
    const remaining = memReserve(day, budget);
    if (remaining < 0) {
      logDenied(day, "cap");
      return { ok: false, remaining: 0, day, reason: "cap" };
    }
    logSpend(day, remaining);
    return { ok: true, remaining, day };
  }

  let remaining: number;
  try {
    const res = await redis.eval(
      RESERVE_SEARCH_SCRIPT,
      [redisKeyFor(day)],
      [budget, Math.round(KEY_TTL_MS)],
    );
    remaining = Number(res);
    if (!Number.isFinite(remaining)) throw new Error("non-numeric EVAL reply");
  } catch (err) {
    // FAIL CLOSED. Unlike the cache and the login throttle, an unaccounted spend
    // here is unrecoverable for the rest of the Pacific day (header).
    console.warn(
      `[search-budget] counter store unreachable — DENYING search.list for ${day} (fail-closed):`,
      err,
    );
    return { ok: false, remaining: 0, day, reason: "store" };
  }

  if (remaining < 0) {
    logDenied(day, "cap");
    return { ok: false, remaining: 0, day, reason: "cap" };
  }
  logSpend(day, remaining);
  return { ok: true, remaining, day };
}

/**
 * Read-only usage probe for observability/tests. Never mutates and never denies;
 * returns `null` when the count cannot be read (so callers can render "unknown"
 * rather than a misleading zero).
 */
export async function getSearchBudgetUsage(
  now: Date = new Date(),
): Promise<{ day: string; used: number; remaining: number } | null> {
  const day = pacificDayKey(now);
  if (configuredButUnavailable()) return null;
  const redis = getRedis();
  if (!redis) {
    const used = memUsage(day);
    return { day, used, remaining: Math.max(0, SEARCH_DAILY_BUDGET - used) };
  }
  try {
    const raw = await redis.get<unknown>(redisKeyFor(day));
    const used = Number(raw ?? 0);
    if (!Number.isFinite(used)) return null;
    return { day, used, remaining: Math.max(0, SEARCH_DAILY_BUDGET - used) };
  } catch {
    return null;
  }
}

// ─── Observability ───────────────────────────────────────────────────────────

function logSpend(day: string, remaining: number): void {
  const line = `[search-budget] spent 1 search.list — ${remaining}/${SEARCH_DAILY_BUDGET} remaining for PT day ${day} (hard cap ${SEARCH_DAILY_CAP}, margin ${RESERVE_MARGIN})`;
  // Loud once the day is nearly gone so near-exhaustion is visible in logs
  // BEFORE search stops working, not discovered by a venue.
  if (remaining <= LOW_WATER_MARK) console.warn(line);
  else console.info(line);
}

function logDenied(day: string, reason: "cap" | "store"): void {
  console.warn(
    `[search-budget] DENIED search.list for PT day ${day} — reason=${reason} (budget ${SEARCH_DAILY_BUDGET} of hard cap ${SEARCH_DAILY_CAP}); paste-a-link is unaffected`,
  );
}

/**
 * Test-only: reset the in-process counter. Deliberately memory-only — it never
 * touches Redis, so it can never wipe a production day's counter.
 */
export function _resetSearchBudget(): void {
  memDay = "";
  memUsed = 0;
}

/** Test-only: drop the memoized Redis client so driver resolution re-runs. */
export function _resetBudgetClient(): void {
  redisClient = null;
}
