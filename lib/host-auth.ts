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
import {
  isThrottled,
  registerFailure,
  resetKey,
  _clearAll,
  type CounterOptions,
} from "./rate-limit-counter";
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

/**
 * Session cookie lifetime — 30 days, ROLLING (TICKET-76).
 *
 * Why this is long: the host code is shown ONCE and is deliberately never
 * persisted anywhere (see the SECURITY INVARIANT in lib/room-memory.ts — only
 * `hostCodeHash` is stored, so the raw code is unrecoverable and NON-ROTATABLE).
 * That makes the session cookie the ONLY non-punishing way back into a room's
 * admin. A 12h window meant a host who ran a venue night on Friday had to
 * retype an unrecoverable code on Saturday. The rejected alternatives (code in
 * the URL, code in localStorage) would both turn a permanent credential into a
 * leakable one — see work/tickets/TICKET-76-*.md.
 *
 * Why raising it is cheap in security terms: the session value is a
 * deterministic HMAC of the room secret (`sessionValue`), so it never changes
 * and cannot be revoked server-side. An attacker who has ALREADY exfiltrated
 * the cookie value can replay it indefinitely by setting their own expiry —
 * `maxAge` bounds nothing for them. It bounds only how long the LEGITIMATE
 * browser keeps the cookie on disk.
 *
 * The real, accepted cost is therefore device-sharing, not theft: on a shared
 * venue tablet the next person to pick it up is host for 30 days. Logout
 * (`POST /api/host/session`) is the mitigation and must stay reachable.
 *
 * ROLLING: a successful `GET /api/host/session` re-issues the cookie with a
 * fresh 30 days, so an active host effectively never falls out. A FAILED probe
 * (401) must never mint or extend anything.
 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

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
 * Cookie marking "this device asked to be logged OUT of this room" (TICKET-104).
 *
 * Auto-claim would otherwise make logout a no-op: the creator's identity cookie
 * lives 2 years, so clearing the host session and reloading `/<room>/admin` would
 * silently claim straight back in. That would break the one control this module
 * names as the mitigation for the shared-venue-tablet case (see the 30-day note
 * above) — the next person to pick up the tablet would be host again.
 *
 * So logout sets this marker and the claim route refuses while it is present.
 * A successful host-code LOGIN clears it: someone who can present the code has
 * proved possession, and re-enabling their frictionless re-entry is the whole
 * point of the ticket. New cookie, so it uses the current `boraoke` brand (no
 * legacy-name constraint, same reasoning as `boraoke_identity`).
 */
export function hostNoClaimCookieName(roomId: string): string {
  return `boraoke_noclaim_${roomId}`;
}

/**
 * Lifetime of the no-claim marker. It must OUTLIVE the identity cookie it
 * suppresses (2 years, `lib/identity.ts`), or logout would quietly expire back
 * into auto-claim; 3 years gives it margin without being literally forever.
 */
export const NO_CLAIM_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 3;

/** Cookie options for the no-claim marker — same scope as the session cookie. */
export function noClaimCookieOptions() {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: HOST_COOKIE_PATH,
    maxAge: NO_CLAIM_MAX_AGE_SECONDS,
  };
}

/** True when this device opted out of auto-claim for this room (logged out). */
export function hasNoClaimMarker(req: NextRequest, roomId: string): boolean {
  return Boolean(req.cookies.get(hostNoClaimCookieName(roomId))?.value);
}

/**
 * Whether `identityUuid` is the registered creator of `roomId` (TICKET-104).
 *
 * This is the no-typing re-entry proof. The creator's identity uuid is held in
 * the httpOnly, root-path, 2-year `boraoke_identity` cookie (`lib/identity.ts`)
 * — 24x the host session's 30-day window — and the room stores the same value as
 * `creatorUuid`, which is server-side bookkeeping never exposed to any client
 * (`PublicRoom` omits it; `__tests__/rooms.test.ts` asserts that). So a returning
 * creator proves ownership with a cookie they cannot read, forge, or leak via
 * JS, and NOTHING has to be persisted in localStorage — `lib/room-memory.ts`'s
 * never-store-the-host-code invariant stands untouched.
 *
 * Hard preconditions, all deliberate:
 *   - The caller MUST pass a uuid read from the identity COOKIE. Never accept
 *     one from a request body or query string: that would turn the localStorage
 *     mirror `cantai_patron_uuid` into a bearer credential for host access.
 *     See the ADOPTION GUARD in `lib/identity.ts`, which closes the matching
 *     hole on the cookie-minting side.
 *   - A room with no `creatorUuid` (legacy rooms, or created while the identity
 *     store was down — creation is fail-open) is NOT claimable. An absent
 *     creator must never match an absent/blank uuid.
 *
 * Comparison is constant-time for uniformity with the rest of this module;
 * uuids are not guessable by timing in practice, but nothing here needs to be
 * the one place that compares identity material with `===`.
 */
export async function verifyCreatorClaim(
  roomId: string,
  identityUuid: unknown,
): Promise<boolean> {
  if (typeof identityUuid !== "string" || identityUuid.length === 0) return false;
  // `default` has no room record and therefore no creator — it stays on the
  // env-token path exclusively.
  if (roomId === DEFAULT_ROOM) return false;
  const room = await getRoom(roomId);
  const creator = room?.creatorUuid;
  if (typeof creator !== "string" || creator.length === 0) return false;
  return timingSafeHexEqual(identityUuid, creator);
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
// open to unlimited online guessing. This now delegates to the shared
// `lib/rate-limit-counter` helper, which is CROSS-INSTANCE when Upstash is
// configured (INCR-based fixed-window counter in Redis) and falls back to the
// same in-process Map/LRU logic when it is not — so on Vercel an attacker
// spraying guesses across warm lambdas is actually capped, while dev/CI and the
// zero-secret boot keep the exact prior behavior. This closes the recorded
// PR #10 M-1 follow-up ("Host login throttle → edge/Upstash-backed"). The
// functions are async because the Redis path is async; call sites already run
// in async routes and simply `await`.

const THROTTLE_MAX_FAILURES = 10;
const THROTTLE_WINDOW_MS = 60_000;
const LOGIN_THROTTLE_OPTS: CounterOptions = {
  max: THROTTLE_MAX_FAILURES,
  windowMs: THROTTLE_WINDOW_MS,
};

/** Namespaced counter key for a login-failure IP (helper prefixes `rl:`). */
function loginKey(ip: string): string {
  return `login:${ip}`;
}

// ─── Creator-claim throttle (TICKET-104, rescoped after the PR #81 review) ───
//
// Two things about this bucket are deliberate, and the SECOND one was a shipped
// availability defect the opus review measured before it reached production.
//
// 1. It is NOT the login bucket. Sharing it would let claim failures spend the
//    budget a legitimate host needs for the code gate.
//
// 2. It is keyed on the caller's IDENTITY, not on their IP, and only a caller
//    who actually presented a valid identity cookie is ever charged. Keyed on IP
//    it did the exact damage separation was meant to prevent, one layer down:
//    `AdminRoom` POSTs claim on EVERY session-less admin render, and the route
//    charged a failure even with no identity cookie at all, so ten ordinary
//    session-less loads from one public IP inside a minute 429'd the CREATOR's
//    own claim — and a 429 renders as the code gate, i.e. precisely the
//    unrecoverable-code dead end this ticket exists to remove. Measured on a
//    venue-shaped IP: 3 failures in 7 full-suite runs as shipped, 0 in 3 with
//    the ceiling raised and nothing else changed.
//
// Why identity-keyed bucketing is sound HERE, where it would be naive elsewhere:
// this route has no guessable secret. The caller cannot supply a uuid (the route
// reads the cookie and nothing else), so the only "attack" is sweeping room ids
// hoping one has `creatorUuid` equal to your own uuid — a v4 collision. Rotating
// to a fresh identity therefore buys an attacker nothing, because a fresh
// identity owns nothing and matches nothing. The bucket is not an anti-guessing
// control; it is a cheap bound on one device's pointless retry loop. A caller
// with no identity cookie is not charged and is not bounded here, which matches
// the posture of the app's other unauthenticated single-store-read endpoints
// (`GET /api/rooms?id=`, `GET /api/host/session`); the expensive write path has
// its own throttle (`lib/room-create-throttle.ts`).
const CLAIM_THROTTLE_OPTS: CounterOptions = LOGIN_THROTTLE_OPTS;

/**
 * Namespaced counter key for a claim-failure bucket. The argument is the
 * caller's own identity uuid — NEVER an IP, so one device can never spend
 * another device's budget (see the note above).
 */
function claimKey(identityUuid: string): string {
  return `hostclaim:${identityUuid}`;
}

/** True when this IDENTITY has exhausted its creator-claim failure budget. */
export function isClaimThrottled(identityUuid: string): Promise<boolean> {
  return isThrottled(claimKey(identityUuid), CLAIM_THROTTLE_OPTS);
}

/** Record one failed creator-claim attempt for this IDENTITY. */
export function registerClaimFailure(identityUuid: string): Promise<void> {
  return registerFailure(claimKey(identityUuid), CLAIM_THROTTLE_OPTS);
}

/** Clear the creator-claim failure bucket for this IDENTITY (successful claim). */
export function resetClaimThrottle(identityUuid: string): Promise<void> {
  return resetKey(claimKey(identityUuid));
}

/**
 * Best-effort client IP used as a rate-limit bucket key.
 *
 * Trust boundary (TICKET-78): the first hop of `x-forwarded-for` is
 * client-suppliable — an attacker can set it directly and rotate the claimed
 * IP per request to spread a failed-login / submit flood across many buckets.
 * We therefore trust the edge-set `x-real-ip` FIRST: on Vercel that header is
 * written by the platform edge to the true client IP and overwrites any value
 * the client sends, so it is not client-controllable. `x-forwarded-for`'s first
 * hop is used only as a fallback for deploy targets / local dev that don't set
 * `x-real-ip`. For a non-Vercel deployment behind a different trusted proxy,
 * `TRUSTED_CLIENT_IP_HEADER` names the single header whose value the edge is
 * known to set, and it takes precedence over both.
 */
export function clientIpFrom(req: NextRequest): string {
  const trustedHeader = process.env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (trustedHeader) {
    const configured = req.headers.get(trustedHeader)?.trim();
    if (configured) return configured;
  }
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

/** True when this IP has exhausted its failure budget for the current window. */
export function isLoginThrottled(ip: string): Promise<boolean> {
  return isThrottled(loginKey(ip), LOGIN_THROTTLE_OPTS);
}

/** Record one failed login attempt for this IP. */
export function registerLoginFailure(ip: string): Promise<void> {
  return registerFailure(loginKey(ip), LOGIN_THROTTLE_OPTS);
}

/** Clear the failure bucket for this IP (successful login). */
export function resetLoginThrottle(ip: string): Promise<void> {
  return resetKey(loginKey(ip));
}

/** Test-only helper: wipe all in-memory throttle state (memory path only). */
export function _clearLoginThrottle(): void {
  _clearAll();
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
