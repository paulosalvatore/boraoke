/**
 * Cross-instance fixed-window failure counter (TICKET-48).
 *
 * A small, reusable per-key failure counter with a driver-resolution that
 * mirrors `lib/store.ts`: when Upstash is configured it uses Redis so the
 * counter is SHARED across all serverless instances (an attacker spraying
 * guesses across warm lambdas is actually rate-limited); otherwise it falls
 * back to the same in-process Map/LRU logic the standalone throttles have
 * always used, so local dev / CI and the zero-secret boot are byte-behavior
 * unchanged.
 *
 * WHY this exists: `lib/host-auth.ts`'s login throttle (and the room-create /
 * search limiters) were in-memory `Map` per process. On Vercel each lambda
 * keeps its own map, so the throttle is NOT a hard cross-instance cap — the
 * recorded PR #10 M-1 follow-up. This helper backs the login throttle with
 * Redis while preserving the exact current behavior when Upstash is absent, and
 * is deliberately generic (caller passes the full key) so the room-create and
 * search limiters can adopt it in their own follow-ups.
 *
 * Redis pattern: the standard fixed-window counter, but INCR + the
 * TTL-on-create are collapsed into ONE atomic Lua `EVAL` (`REGISTER_FAILURE_SCRIPT`,
 * mirroring `MERGE_SCRIPT` in lib/store/upstash.ts). Running both in a single
 * server-side script closes a TTL-less-counter race: with the old two-round-trip
 * `INCR` then conditional `EXPIRE`, a lost/failed second round-trip (fail-open
 * catch, crash between the two calls) left the key with NO TTL, so the counter
 * never expired and that key stayed throttled indefinitely (self-healing only on
 * a successful login via `resetKey`). INCR is atomic per key, so concurrent
 * failures on the same key from different instances all land on one counter, and
 * the TTL is now guaranteed to be set atomically with the create. `isThrottled`
 * reads the counter with GET (absent key → 0). `resetKey` DELs it.
 *
 * FAIL-OPEN: every Redis call is wrapped in try/catch. On any Redis error
 * `isThrottled` returns false and `registerFailure` no-ops — availability over
 * strict throttling. A blipped Redis must never lock out a legitimate host.
 * This matches the codebase's fail-open telemetry ethos. The in-memory LRU cap
 * still bounds heap on the memory path so a spoofed-key flood can't grow it
 * unbounded.
 */

import "server-only";

import { Redis } from "@upstash/redis";

/** Fixed-window counter options. */
export interface CounterOptions {
  /** Failures allowed in a window before `isThrottled` returns true. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/** Namespace prefix for every Redis key this helper writes (collision-free with queue/room keys). */
const REDIS_PREFIX = "rl:";

/**
 * Atomic register-failure (TICKET-50, from TICKET-48 reviewer FU-1). Runs the
 * INCR and the TTL-on-create inside ONE EVAL, mirroring `MERGE_SCRIPT` in
 * lib/store/upstash.ts.
 *
 * KEYS[1] = counter key (`rl:<key>`).
 * ARGV[1] = window length in whole milliseconds (>= 1) for PEXPIRE.
 *
 * INCR the counter; iff the result is 1 (the counter was just created) set the
 * TTL in the SAME script via PEXPIRE — so the TTL can never be lost to a dropped
 * second round-trip or a crash between two calls, which is the whole point:
 * without it a fail-open-swallowed EXPIRE left a TTL-less key that never expired
 * and stayed throttled forever. Returns the post-INCR count (unused by the
 * caller today, but kept for parity/telemetry).
 *
 * Uses PEXPIRE (millisecond precision) rather than the old EXPIRE (ceil to whole
 * seconds): strictly more precise, and it never rounds a sub-second window up to
 * a full second.
 */
export const REGISTER_FAILURE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

/** Cap tracked keys on the memory path so a spoofed-key flood can't grow heap unbounded (LRU). */
const MAX_TRACKED_KEYS = 1000;

// ─── Driver resolution (mirrors lib/store.ts) ────────────────────────────────

function useUpstash(): boolean {
  const explicit = process.env.STORE_DRIVER?.toLowerCase();
  if (explicit === "upstash") return true;
  if (explicit === "memory") return false;
  // Auto: use Upstash when its REST URL is configured, else memory.
  return !!process.env.UPSTASH_REDIS_REST_URL;
}

/**
 * Lazily-built Redis client (same construction as `lib/store/upstash.ts` —
 * `Redis.fromEnv()` reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
 * Built on first use so the memory path never touches Upstash and the module
 * imports with zero secrets.
 */
let redisClient: Redis | null = null;
function getRedis(): Redis | null {
  if (!useUpstash()) return null;
  if (redisClient) return redisClient;
  try {
    redisClient = Redis.fromEnv();
    return redisClient;
  } catch {
    // Upstash selected but creds unusable — degrade to fail-open (no throttle)
    // rather than crash the route.
    return null;
  }
}

function redisKey(key: string): string {
  return `${REDIS_PREFIX}${key}`;
}

// ─── Memory path (byte-behavior identical to the standalone throttles) ───────

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

function memIsThrottled(key: string, { max, windowMs }: CounterOptions): boolean {
  const bucket = buckets.get(key);
  if (!bucket) return false;
  if (Date.now() - bucket.windowStart >= windowMs) {
    buckets.delete(key); // stale window — expired
    return false;
  }
  return bucket.count >= max;
}

function memRegisterFailure(key: string, { windowMs }: CounterOptions): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    // New or expired window. Evict the oldest-inserted entry when at capacity
    // (Map preserves insertion order — cheap LRU-ish bound).
    if (!buckets.has(key) && buckets.size >= MAX_TRACKED_KEYS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    buckets.delete(key); // re-insert to refresh insertion order
    buckets.set(key, { count: 1, windowStart: now });
    return;
  }
  bucket.count += 1;
}

function memResetKey(key: string): void {
  buckets.delete(key);
}

// ─── Public API (all async — Redis path is async, memory path resolves sync) ─

/** True when `key` has reached `max` failures within the current window. */
export async function isThrottled(
  key: string,
  opts: CounterOptions,
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return memIsThrottled(key, opts);
  try {
    const count = await redis.get<number>(redisKey(key));
    return (count ?? 0) >= opts.max;
  } catch {
    // Fail-open: a Redis blip must never lock out a legitimate caller.
    return false;
  }
}

/**
 * Record one failure for `key`. Redis path: a single atomic `EVAL` of
 * `REGISTER_FAILURE_SCRIPT` that INCRs the counter and, iff it was just created
 * (INCR === 1), sets the window TTL via PEXPIRE in the SAME script. Collapsing
 * the two round-trips into one server-side script means the TTL is guaranteed to
 * be set atomically with the create — a lost/failed second round-trip can no
 * longer leave a TTL-less counter that stays throttled forever. The window is
 * anchored at the FIRST failure and the key self-expires, so no cleanup pass is
 * needed.
 */
export async function registerFailure(
  key: string,
  opts: CounterOptions,
): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    memRegisterFailure(key, opts);
    return;
  }
  try {
    // PEXPIRE takes whole milliseconds; floor of 1ms so a zero/sub-ms window
    // still gets a positive TTL (mirrors the old EXPIRE's max(1, …) floor).
    const ttlMs = Math.max(1, Math.round(opts.windowMs));
    await redis.eval(REGISTER_FAILURE_SCRIPT, [redisKey(key)], [ttlMs]);
  } catch {
    // Fail-open: on any Redis error, silently skip recording the failure.
  }
}

/** Clear the counter for `key` (e.g. a successful login). */
export async function resetKey(key: string): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    memResetKey(key);
    return;
  }
  try {
    await redis.del(redisKey(key));
  } catch {
    // Fail-open: nothing to do — a lingering counter self-expires anyway.
  }
}

/**
 * Test-only helper: wipe all in-memory counters. Deliberately memory-only — it
 * never touches Redis so it can never flush production keys.
 */
export function _clearAll(): void {
  buckets.clear();
}
