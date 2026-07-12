/**
 * Room-creation throttle (security HIGH-1, TICKET-9).
 *
 * POST /api/rooms is unauthenticated by design (no accounts until #14), so
 * without a cap an attacker can flood Redis with `room:<id>:meta` keys at zero
 * cost.
 *
 * This now delegates to the shared `lib/rate-limit-counter` helper (TICKET-52 /
 * TICKET-48 FU-2), exactly as `lib/host-auth.ts`'s login throttle does. When
 * Upstash is configured the counter is CROSS-INSTANCE (INCR-based fixed-window
 * counter in Redis), so on serverless hosting an attacker spraying creations
 * across warm lambdas is actually capped — previously each lambda kept its own
 * in-memory Map, making this a per-instance guard only (the recorded #14
 * follow-up). When Upstash is absent it falls back to the same in-process
 * Map/LRU logic, so local dev / CI and the zero-secret boot are byte-behavior
 * unchanged. Fixed-window semantics are identical (window anchored at the first
 * hit, self-expiring), so the trip point and 1h window are unchanged. The hard
 * global cap remains the ROOM_MAX ceiling in `lib/rooms.ts`.
 *
 * NOTE: the shared counter's memory-path LRU cap (MAX_TRACKED_KEYS = 1000) is
 * now SHARED across all its consumers (login + room-create keys), where
 * room-create previously had its own private 1000-entry cap. This is an
 * intentional consolidation consequence — still a strong heap bound, and
 * irrelevant on the Redis/prod path.
 *
 * Semantics: counts SUCCESSFUL room creations per client IP in a fixed 1h
 * window. Functions are async because the Redis path is async; the sole call
 * site already runs in an async route and simply `await`s.
 *
 * Tunables:
 *   ROOM_CREATE_LIMIT — creations per IP per window (default 3).
 *   Window is fixed at 1 hour.
 */

import "server-only";

import {
  isThrottled,
  registerFailure,
  _clearAll,
  type CounterOptions,
} from "./rate-limit-counter";

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_LIMIT = 3;

/** Creations allowed per IP per hour (env-tunable, default 3). */
export function roomCreateLimit(): number {
  const raw = Number(process.env.ROOM_CREATE_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIMIT;
}

/**
 * Counter options for room-create. `max` is evaluated at call time so a live
 * ROOM_CREATE_LIMIT env override still applies.
 */
function roomCreateOpts(): CounterOptions {
  return { max: roomCreateLimit(), windowMs: WINDOW_MS };
}

/** Namespaced counter key for a room-create IP (helper prefixes `rl:`). */
function roomCreateKey(ip: string): string {
  return `room-create:${ip}`;
}

/** True when this IP has exhausted its creation budget for the current window. */
export function isRoomCreateThrottled(ip: string): Promise<boolean> {
  return isThrottled(roomCreateKey(ip), roomCreateOpts());
}

/** Record one successful room creation for this IP. */
export function registerRoomCreation(ip: string): Promise<void> {
  return registerFailure(roomCreateKey(ip), roomCreateOpts());
}

/** Test-only helper: wipe all in-memory throttle state (memory path only). */
export function _clearRoomCreateThrottle(): void {
  _clearAll();
}
