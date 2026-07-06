/**
 * Room-creation throttle (security HIGH-1, TICKET-9).
 *
 * POST /api/rooms is unauthenticated by design (no accounts until #14), so
 * without a cap an attacker can flood Redis with `room:<id>:meta` keys at zero
 * cost. This is the house standalone dual-bucket/LRU pattern (same shape as
 * TICKET-7's login throttle and TICKET-8's search limiter — deliberately not
 * imported from them, per the parallel-wave file-ownership rule).
 *
 * Semantics: counts SUCCESSFUL room creations per client IP in a rolling
 * window. In-process, per-instance — on serverless hosting each lambda keeps
 * its own buckets, so this is a strong attack-surface reduction, NOT a hard
 * global cap (the hard cap is the ROOM_MAX ceiling in `lib/rooms.ts`; an
 * edge/Upstash-backed limiter is a recorded #14 follow-up).
 *
 * Tunables:
 *   ROOM_CREATE_LIMIT — creations per IP per window (default 3).
 *   Window is fixed at 1 hour.
 */

import "server-only";

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_LIMIT = 3;
/** Cap tracked IPs so a spoofed-IP flood can't grow memory unbounded (LRU). */
const MAX_TRACKED_IPS = 1000;

interface CreationBucket {
  count: number;
  windowStart: number;
}

const creations = new Map<string, CreationBucket>();

/** Creations allowed per IP per hour (env-tunable, default 3). */
export function roomCreateLimit(): number {
  const raw = Number(process.env.ROOM_CREATE_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIMIT;
}

/** True when this IP has exhausted its creation budget for the current window. */
export function isRoomCreateThrottled(ip: string): boolean {
  const bucket = creations.get(ip);
  if (!bucket) return false;
  if (Date.now() - bucket.windowStart >= WINDOW_MS) {
    creations.delete(ip); // stale window — expired
    return false;
  }
  return bucket.count >= roomCreateLimit();
}

/** Record one successful room creation for this IP. */
export function registerRoomCreation(ip: string): void {
  const now = Date.now();
  const bucket = creations.get(ip);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    // New or expired window. Evict the oldest-inserted entry when at capacity
    // (Map preserves insertion order — cheap LRU-ish bound).
    if (!creations.has(ip) && creations.size >= MAX_TRACKED_IPS) {
      const oldest = creations.keys().next().value;
      if (oldest !== undefined) creations.delete(oldest);
    }
    creations.delete(ip); // re-insert to refresh insertion order
    creations.set(ip, { count: 1, windowStart: now });
    return;
  }
  bucket.count += 1;
}

/** Test-only helper: wipe all throttle state. */
export function _clearRoomCreateThrottle(): void {
  creations.clear();
}
