/**
 * Host auth — minimal admin-token model (TICKET-7).
 *
 * The venue host authenticates once with a shared secret (`HOST_TOKEN`) at
 * `/admin`. On success we set an httpOnly cookie holding an HMAC-derived
 * *session value* (never the raw secret) so the token never travels in a
 * client-readable form and never lands in the client bundle. Every host API
 * route calls `requireHost(req)` to verify the cookie server-side.
 *
 * Auth model (deliberately locked-safe in production):
 *   - HOST_TOKEN set                  → that token is required.
 *   - HOST_TOKEN unset + development   → a well-known dev fallback token is
 *                                        accepted so local dev / e2e boots with
 *                                        zero secrets (mirrors the store's
 *                                        zero-credential default).
 *   - HOST_TOKEN unset + production    → host controls are LOCKED (deny all).
 *                                        The bar owner must configure a token.
 *
 * TICKET-9 (per-room host codes) swaps ONLY `resolveRoomToken` — every call
 * site goes through this helper, so the lookup changes, not the callers.
 */

import "server-only";

import { createHmac, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";

/** Cookie name holding the host session value. */
export const HOST_COOKIE = "cantai_host";

/**
 * Dev-only fallback token. NEVER accepted in production (see resolveRoomToken)
 * and NEVER a real secret — it exists purely so `npm run dev` / e2e work with
 * no env configured. Safe to keep in source.
 */
export const DEV_FALLBACK_TOKEN = "cantai-dev-host";

/** Session cookie lifetime — one long venue shift. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

/**
 * The effective host token for a room. Until TICKET-9 introduces per-room
 * codes this ignores `roomId` and reads the single `HOST_TOKEN` env secret,
 * with a development-only fallback. Returns `null` when host controls are
 * locked (production with no token configured).
 */
export function resolveRoomToken(_roomId: string): string | null {
  const env = process.env.HOST_TOKEN?.trim();
  if (env) return env;
  if (process.env.NODE_ENV !== "production") return DEV_FALLBACK_TOKEN;
  return null; // locked: production must configure HOST_TOKEN
}

/** Whether host controls are currently usable for this room. */
export function isHostConfigured(roomId: string): boolean {
  return resolveRoomToken(roomId) !== null;
}

/**
 * The opaque session value derived from a token. Storing this (not the token)
 * in the cookie means the raw secret is never held client-side.
 */
function sessionValue(token: string): string {
  return createHmac("sha256", token).update("cantai-host-session-v1").digest("hex");
}

/** Constant-time comparison of two hex strings of arbitrary length. */
function timingSafeHexEqual(a: string, b: string): boolean {
  // Hash to a fixed length first so lengths always match and no length signal
  // leaks; timingSafeEqual then compares in constant time.
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Verify a token submitted at login against the room's configured token.
 * Returns false when host controls are locked or the token is wrong/empty.
 */
export function verifyHostToken(roomId: string, submitted: unknown): boolean {
  const token = resolveRoomToken(roomId);
  if (!token) return false;
  if (typeof submitted !== "string" || submitted.length === 0) return false;
  return timingSafeHexEqual(submitted, token);
}

/** Issue the session cookie value for a room, or null when locked. */
export function issueSession(roomId: string): string | null {
  const token = resolveRoomToken(roomId);
  return token ? sessionValue(token) : null;
}

/** Verify a session cookie value against the room's configured token. */
export function verifySessionValue(roomId: string, cookieValue: unknown): boolean {
  const token = resolveRoomToken(roomId);
  if (!token) return false;
  if (typeof cookieValue !== "string" || cookieValue.length === 0) return false;
  return timingSafeHexEqual(cookieValue, sessionValue(token));
}

/** Cookie options for the host session cookie (httpOnly, prod-secure). */
export function hostCookieOptions() {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

/**
 * Gate for host API routes. Reads the session cookie off the request and
 * verifies it. Every host route calls this first; on false, respond 401.
 */
export function requireHost(req: NextRequest, roomId: string): boolean {
  const cookie = req.cookies.get(HOST_COOKIE)?.value;
  return verifySessionValue(roomId, cookie);
}
