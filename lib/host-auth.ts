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
 * TICKET-9 (per-room host codes) swaps ONLY the `resolveRoomToken` lookup —
 * every call site goes through this helper. Because the per-room host code now
 * lives in the (async) room store, `resolveRoomToken` and everything that
 * derives from it are async; call sites already run inside async routes and
 * simply `await`. The token lookup precedence is:
 *
 *   1. The room's own `hostCode` (the multi-room identity, #9).
 *   2. Env `HOST_TOKEN` — the legacy global secret; still governs the `default`
 *      room (which has no room record) so the pre-multi-room /admin keeps working.
 *   3. Dev fallback token (non-production only).
 *   4. null → host controls LOCKED (production with nothing configured).
 *
 * Cookie-per-room (opus-review heads-up): the session value is derived from the
 * token, and the cookie NAME is now room-scoped (`hostCookieName`). Two effects:
 * (a) a session minted for room A's code cannot authenticate room B (different
 * token → different session value), and (b) one browser can host multiple rooms
 * at once because each room's session lives in its OWN cookie. The `default`
 * room keeps the legacy `cantai_host` name for back-compat.
 */

import "server-only";

import { createHmac, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import { DEFAULT_ROOM, getRoom, hashHostCode, isValidRoomId } from "./rooms";

/**
 * Base cookie name (legacy `default` room). Per-room cookies append the room id
 * via `hostCookieName`. Kept exported for back-compat / tests.
 *
 * STORAGE-KEY NOTE (TICKET-33 rebrand): the `cantai_host*` cookie names and the
 * `cantai-*` HMAC salt strings in this file are DELIBERATELY kept under the old
 * brand. They are live auth state — renaming the cookie logs every active host
 * out, and rotating the salts invalidates every issued session. Cosmetic rename
 * is not worth that. See work/tickets/TICKET-33-code-rebrand.md.
 */
export const HOST_COOKIE = "cantai_host";

/**
 * The host session cookie name for a room. The legacy `default` room keeps the
 * bare `cantai_host` name; every other room gets `cantai_host_<roomId>` so one
 * browser can hold independent host sessions for multiple rooms at once.
 */
export function hostCookieName(roomId: string): string {
  return roomId === DEFAULT_ROOM ? HOST_COOKIE : `${HOST_COOKIE}_${roomId}`;
}

/**
 * Dev-only fallback token. NEVER accepted in production (see resolveRoomToken)
 * and NEVER a real secret — it exists purely so `npm run dev` / e2e work with
 * no env configured. Safe to keep in source.
 */
export const DEV_FALLBACK_TOKEN = "cantai-dev-host";

/** Session cookie lifetime — one long venue shift. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

/**
 * The effective host SECRET for a room (async — see file header for precedence).
 * For a created room this is its stored `hostCodeHash` — the raw code is never
 * persisted (security MEDIUM-2), so the hash is the room's server-side secret:
 * login hashes the submitted code before comparing (see `verifyHostToken`) and
 * session values derive from the hash. The legacy `default` room (no record)
 * falls back to env `HOST_TOKEN` then the dev token, compared RAW. Returns
 * `null` when host controls are locked (production with nothing configured).
 */
export async function resolveRoomToken(roomId: string): Promise<string | null> {
  // 1. Per-room host-code hash (the multi-room identity). Only for real rooms —
  //    the `default` room has no record and stays on the env-token path below.
  if (roomId !== DEFAULT_ROOM) {
    const room = await getRoom(roomId);
    if (room?.hostCodeHash) return room.hostCodeHash;
    // A non-default room id with no record is not a configured venue → locked,
    // regardless of any global env token (which governs `default` only).
    return null;
  }
  // 2/3/4. Legacy env token / dev fallback / locked — for the `default` room.
  const env = process.env.HOST_TOKEN?.trim();
  if (env) return env;
  if (process.env.NODE_ENV !== "production") return DEV_FALLBACK_TOKEN;
  return null; // locked: production must configure HOST_TOKEN
}

/** Whether host controls are currently usable for this room. */
export async function isHostConfigured(roomId: string): Promise<boolean> {
  return (await resolveRoomToken(roomId)) !== null;
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
 * Verify a token submitted at login against the room's configured secret.
 * For real rooms the stored secret is the host-code HASH (MEDIUM-2), so the
 * submitted raw code is hashed before comparison; the legacy `default` room's
 * env token is stored nowhere and compared raw. Returns false when host
 * controls are locked or the token is wrong/empty.
 */
export async function verifyHostToken(roomId: string, submitted: unknown): Promise<boolean> {
  const secret = await resolveRoomToken(roomId);
  if (!secret) return false;
  if (typeof submitted !== "string" || submitted.length === 0) return false;
  const comparable = roomId === DEFAULT_ROOM ? submitted : hashHostCode(submitted);
  return timingSafeHexEqual(comparable, secret);
}

/** Issue the session cookie value for a room, or null when locked. */
export async function issueSession(roomId: string): Promise<string | null> {
  const token = await resolveRoomToken(roomId);
  return token ? sessionValue(token) : null;
}

/** Verify a session cookie value against the room's configured token. */
export async function verifySessionValue(roomId: string, cookieValue: unknown): Promise<boolean> {
  const token = await resolveRoomToken(roomId);
  if (!token) return false;
  if (typeof cookieValue !== "string" || cookieValue.length === 0) return false;
  return timingSafeHexEqual(cookieValue, sessionValue(token));
}

/**
 * Path the session cookie is scoped to (least privilege, security LOW-1):
 * only the `/api/host/*` routes ever read it — the /admin page itself is a
 * public client bundle whose auth state comes from `GET /api/host/session`,
 * which lives under this path.
 */
export const HOST_COOKIE_PATH = "/api/host";

/** Cookie options for the host session cookie (httpOnly, prod-secure). */
export function hostCookieOptions() {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: HOST_COOKIE_PATH,
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

// ─── Login-failure throttle (security M-1) ───────────────────────────────────
//
// Per-IP failure throttle for POST /api/host/login: without it the token is
// open to unlimited online guessing. In-memory, per-process — on serverless
// hosting each lambda instance keeps its own buckets, so this is a strong
// attack-surface reduction, NOT a hard global cap (an edge/Upstash-backed
// throttle is a recorded follow-up). Same standalone pattern as TICKET-8's
// search limiter (deliberately not imported — parallel-wave file ownership).

const THROTTLE_MAX_FAILURES = 10;
const THROTTLE_WINDOW_MS = 60_000;
/** Cap tracked IPs so a spoofed-IP flood can't grow memory unbounded (LRU). */
const THROTTLE_MAX_TRACKED_IPS = 1000;

interface FailureBucket {
  count: number;
  windowStart: number;
}

const loginFailures = new Map<string, FailureBucket>();

/**
 * Best-effort client IP: first hop of x-forwarded-for (set by the platform
 * proxy on Vercel), x-real-ip fallback, then a shared "unknown" bucket.
 */
export function clientIpFrom(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** True when this IP has exhausted its failure budget for the current window. */
export function isLoginThrottled(ip: string): boolean {
  const bucket = loginFailures.get(ip);
  if (!bucket) return false;
  if (Date.now() - bucket.windowStart >= THROTTLE_WINDOW_MS) {
    loginFailures.delete(ip); // stale window — expired
    return false;
  }
  return bucket.count >= THROTTLE_MAX_FAILURES;
}

/** Record one failed login attempt for this IP. */
export function registerLoginFailure(ip: string): void {
  const now = Date.now();
  const bucket = loginFailures.get(ip);
  if (!bucket || now - bucket.windowStart >= THROTTLE_WINDOW_MS) {
    // New or expired window. Evict the oldest-inserted entry when at capacity
    // (Map preserves insertion order — cheap LRU-ish bound).
    if (!loginFailures.has(ip) && loginFailures.size >= THROTTLE_MAX_TRACKED_IPS) {
      const oldest = loginFailures.keys().next().value;
      if (oldest !== undefined) loginFailures.delete(oldest);
    }
    loginFailures.delete(ip); // re-insert to refresh insertion order
    loginFailures.set(ip, { count: 1, windowStart: now });
    return;
  }
  bucket.count += 1;
}

/** Clear the failure bucket for this IP (successful login). */
export function resetLoginThrottle(ip: string): void {
  loginFailures.delete(ip);
}

/** Test-only helper: wipe all throttle state. */
export function _clearLoginThrottle(): void {
  loginFailures.clear();
}

/**
 * Gate for host API routes. Reads the session cookie off the request and
 * verifies it. Every host route calls this first; on false, respond 401.
 */
export async function requireHost(req: NextRequest, roomId: string): Promise<boolean> {
  const cookie = req.cookies.get(hostCookieName(roomId))?.value;
  return verifySessionValue(roomId, cookie);
}

/**
 * Resolve the target room id for a host request from its `?room=` query param,
 * defaulting to the legacy `default` room. Returns null when the param is
 * present but malformed (routes reply 400) — never lets an unvalidated id reach
 * a Redis key. An absent param is the back-compat `default` room, not an error.
 */
export function roomIdFromRequest(req: NextRequest): string | null {
  const raw = req.nextUrl.searchParams.get("room");
  if (raw == null || raw === "") return DEFAULT_ROOM;
  return isValidRoomId(raw) ? raw : null;
}
