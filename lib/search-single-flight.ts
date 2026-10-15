/**
 * Single-flight for billed searches (TICKET-126).
 *
 * WHY: the search cache (lib/search-cache.ts) only helps AFTER a query has been
 * answered once. N patrons typing the same song at the same moment — the
 * ordinary case for a song the whole bar is singing along to — all miss the
 * cache together, and each of the N instances spends one of the platform's 100
 * daily `search.list` calls on the identical question. This module makes that
 * ONE call: the first request to miss takes a short cross-instance lock and
 * becomes the LEADER; everyone else becomes a WAITER and reads the leader's
 * answer out of the cache when it lands. Waiters are never charged anything.
 *
 * Protocol (Redis path):
 *   acquire  — `SET sf:lock:<cacheKey> <random token> NX PX LOCK_TTL_MS`.
 *              "OK" → leader. null → waiter. A thrown Redis error → "solo".
 *   release  — compare-and-delete in a script, so a leader whose lock already
 *              expired can never delete the NEXT leader's lock. A failed
 *              upstream call first sets a short `sf:err:<cacheKey>` marker so
 *              waiters stop waiting instead of timing out. The next leader
 *              to acquire clears that marker, so it never outlives its flight.
 *   wait     — poll the cache every POLL_MS until DEADLINE_MS. A hit → the
 *              page. The err marker → "failed". The lock gone with no page
 *              (the leader was denied a reservation, or died) → "vacant", and
 *              the caller may try once to become leader itself. Deadline →
 *              "timeout", which the route answers with a deferred retry rather
 *              than a billed call.
 *
 * FAIL-OPEN on the lock, deliberately the opposite of the budget: a Redis error
 * while acquiring yields "solo" (proceed uncoordinated). Single-flight is an
 * optimisation; the reservation that follows it (lib/search-budget.ts) is still
 * fail-CLOSED, so the worst a Redis blip can do here is N billed calls that are
 * each inside every cap — exactly the behaviour before this module existed.
 *
 * Without Upstash (local dev / CI / one process) an in-process promise map gives
 * the same property within the process.
 *
 * Residual, stated: if Google takes longer than LOCK_TTL_MS the lock expires and
 * one waiter can become a second leader. Bounded to one extra call per
 * LOCK_TTL_MS per query, and every such call is still capped.
 */

import "server-only";

import { randomBytes } from "node:crypto";
import { Redis } from "@upstash/redis";

import { getCachedSearchPage } from "./search-cache";
import type { SearchPage } from "./youtube-search";

/** Lock lifetime — comfortably above a normal search.list round trip. */
export const LOCK_TTL_MS = 10_000;
/** How long a failed-upstream marker tells waiters to give up. */
export const ERROR_MARKER_TTL_MS = 3_000;
/** How long a waiter waits for the leader before deferring. */
export const WAIT_DEADLINE_MS = 6_000;
/** Waiter poll interval. */
export const WAIT_POLL_MS = 150;

// The lock and the error marker each get their own fixed namespace IN FRONT of
// the cache key. The cache key ends in user-typed query text, so a marker
// appended AFTER it can be forged: with `sf:<key>` / `sf:<key>:err`, the query
// "abc:err" owned a lock key equal to query "abc"'s error marker. Distinct
// leading prefixes cannot collide, whatever the query contains.
const LOCK_PREFIX = "sf:lock:";
const ERR_PREFIX = "sf:err:";

export function lockKey(cacheKey: string): string {
  return `${LOCK_PREFIX}${cacheKey}`;
}
export function errKey(cacheKey: string): string {
  return `${ERR_PREFIX}${cacheKey}`;
}

/**
 * Delete the lock only if it still holds OUR token. A plain DEL would let a
 * leader whose lock expired mid-call delete a newer leader's lock.
 */
export const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

// ─── Driver resolution (mirrors lib/search-cache.ts) ───────────────────────

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
    return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** How the leader's attempt ended — tells waiters what to do next. */
export type FlightOutcome = "filled" | "failed" | "abandoned";

export type Flight =
  | { role: "leader"; release: (outcome: FlightOutcome) => Promise<void> }
  | { role: "waiter" }
  | { role: "solo" };

export type FlightWait =
  | { kind: "page"; page: SearchPage }
  | { kind: "failed" }
  | { kind: "vacant" }
  | { kind: "timeout" };

export interface WaitOptions {
  deadlineMs?: number;
  pollMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// In-process flights: one settle-promise per key.
interface MemFlight {
  settled: Promise<FlightOutcome>;
}
const memFlights = new Map<string, MemFlight>();

/** Try to become the leader for `cacheKey`. Never throws. */
export async function acquireSearchFlight(cacheKey: string): Promise<Flight> {
  const redis = getRedis();
  if (!redis) {
    if (useUpstash()) return { role: "solo" }; // configured but unusable: uncoordinated
    if (memFlights.has(cacheKey)) return { role: "waiter" };
    let settle!: (o: FlightOutcome) => void;
    const settled = new Promise<FlightOutcome>((r) => (settle = r));
    const flight: MemFlight = { settled };
    memFlights.set(cacheKey, flight);
    let done = false;
    return {
      role: "leader",
      release: async (outcome) => {
        if (done) return;
        done = true;
        if (memFlights.get(cacheKey) === flight) memFlights.delete(cacheKey);
        settle(outcome);
      },
    };
  }

  const token = randomBytes(16).toString("hex");
  let got: unknown;
  try {
    got = await redis.set(lockKey(cacheKey), token, { nx: true, px: LOCK_TTL_MS });
  } catch {
    return { role: "solo" }; // fail-open: see header
  }
  if (got !== "OK") return { role: "waiter" };
  // A failed PREVIOUS flight's error marker outlives its lock by up to
  // ERROR_MARKER_TTL_MS. It describes that flight, not this one: left in place,
  // this leader's waiters would read it and give up while this leader is about
  // to answer. Clearing it here scopes the marker to the flight that set it.
  // Best-effort: a failure only means waiters may degrade early, as before.
  try {
    await redis.del(errKey(cacheKey));
  } catch {
    /* see above */
  }
  let done = false;
  return {
    role: "leader",
    release: async (outcome) => {
      if (done) return;
      done = true;
      try {
        if (outcome === "failed") {
          await redis.set(errKey(cacheKey), "1", { px: ERROR_MARKER_TTL_MS });
        }
        await redis.eval(RELEASE_LOCK_SCRIPT, [lockKey(cacheKey)], [token]);
      } catch {
        // The lock expires on its own within LOCK_TTL_MS; waiters time out at
        // worst. Never let a release error break the leader's response.
      }
    },
  };
}

/**
 * Wait for the current leader of `cacheKey`. Never throws. A store error while
 * waiting is reported as "timeout" (defer, do not bill).
 */
export async function waitForSearchFlight(
  cacheKey: string,
  opts: WaitOptions = {},
): Promise<FlightWait> {
  const deadline = Date.now() + (opts.deadlineMs ?? WAIT_DEADLINE_MS);
  const poll = opts.pollMs ?? WAIT_POLL_MS;
  const redis = getRedis();

  if (!redis) {
    const flight = memFlights.get(cacheKey);
    if (flight) {
      // Clear the deadline timer once the leader settles, so a fast answer
      // does not leave a 6 s timer pending behind every waiter.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), Math.max(0, deadline - Date.now()));
      });
      const outcome = await Promise.race([flight.settled, timedOut]).finally(() => clearTimeout(timer));
      if (outcome === "timeout") return { kind: "timeout" };
      if (outcome === "failed") return { kind: "failed" };
    }
    const page = await getCachedSearchPage(cacheKey);
    return page ? { kind: "page", page } : { kind: "vacant" };
  }

  while (Date.now() < deadline) {
    await sleep(poll);
    const page = await getCachedSearchPage(cacheKey);
    if (page) return { kind: "page", page };
    let lock: unknown;
    let err: unknown;
    try {
      [lock, err] = await redis.mget<[unknown, unknown]>(lockKey(cacheKey), errKey(cacheKey));
    } catch {
      return { kind: "timeout" };
    }
    if (err) return { kind: "failed" };
    if (!lock) {
      // The leader may have filled the cache and released between the two
      // reads above; look once more before calling the flight vacant.
      const late = await getCachedSearchPage(cacheKey);
      return late ? { kind: "page", page: late } : { kind: "vacant" };
    }
  }
  return { kind: "timeout" };
}

/** Test-only: forget in-process flights. */
export function _resetSearchFlights(): void {
  memFlights.clear();
}

/** Test-only: drop the memoized Redis client. */
export function _resetFlightClient(): void {
  redisClient = null;
}
