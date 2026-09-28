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
import {
  DEFAULT_ROOM,
  getRoom,
  hashHostCode,
  isValidRoomId,
  issueRoomClaimToken,
  verifyRoomClaimToken,
} from "./rooms";

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
 * The ADMIN CLAIM cookie for a room (TICKET-104, redesigned after the PR #81
 * security gate).
 *
 * WHY THIS EXISTS AS ITS OWN CREDENTIAL — do not collapse it back onto the
 * identity uuid. Round 2 keyed the claim on `boraoke_identity` and the security
 * gate broke it end-to-end in real browsers: that uuid is published to page JS
 * twice over (`POST /api/identity` echoes the cookie's value in its response
 * body, and `cantai_patron_uuid` mirrors it in localStorage on every room
 * visit), and it is *required* to be client-readable for own-row highlighting
 * and the `?uuid=` pending poll. A value that page JS can read is not a
 * credential, so the gate exfiltrated it with one `fetch`, replayed it from a
 * different browser profile, and took real host control of someone else's room.
 * One value cannot be both client-readable and secret. So the claim gets its
 * own secret, and `creatorUuid` goes back to being a non-secret ownership label.
 *
 * The properties that make this one a credential rather than a label:
 *   - 256 CSPRNG bits, minted server-side, **never** returned in any response
 *     body, never mirrored into localStorage, never accepted as a request
 *     parameter. The only place it exists client-side is this httpOnly cookie.
 *   - Only its HASH is stored (`Room.claimTokenHashes`, `hashClaimToken`), so a
 *     store leak yields nothing replayable.
 *   - **Server-side revocable.** Logout clears the hashes, so a token already
 *     copied off the device stops working. The round-2 design could not do this
 *     — its opt-out was a marker cookie in the victim's OWN jar, which locked
 *     the owner out while leaving the attacker's copy at 200.
 *   - **Bounded, rolling lifetime** (below), rather than a lifetime that has to
 *     be reasoned about against another cookie's.
 */
export function claimCookieName(roomId: string): string {
  return `boraoke_claim_${roomId}`;
}

/**
 * Claim-cookie lifetime: 180 days, ROLLING (re-issued on every successful claim
 * and on every successful session probe).
 *
 * Deliberately NOT a "big number chosen to outlive another cookie" — that was
 * O3, and it was the wrong shape twice over: Chromium caps cookies at 400 days
 * so a 3-year value silently became 400 days, and the cookie it was supposed to
 * outlive *rolled* while the marker never did, so the opt-out quietly expired
 * back into auto-claim after ~13 months. Correctness here does not depend on
 * comparing two cookie lifetimes at all: revocation is server state.
 *
 * Rolling is what keeps "bounded" from meaning "eventually locks the owner out":
 * an active venue's credential never ages out, while a room nobody has touched
 * for six months stops carrying a standing admin credential on some old device.
 */
export const CLAIM_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

/** Cookie options for the admin-claim cookie — same least-privilege path as the session. */
export function claimCookieOptions() {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: HOST_COOKIE_PATH,
    maxAge: CLAIM_MAX_AGE_SECONDS,
  };
}

/** The raw claim token this request presents for `roomId`, if any. */
export function claimTokenFrom(req: NextRequest, roomId: string): string | undefined {
  return req.cookies.get(claimCookieName(roomId))?.value;
}

/**
 * Mint a claim token for a room and attach it to a response as the httpOnly
 * claim cookie. Used at room creation (the creator's device gets it immediately)
 * and on a successful host-code login (which is how a device that logged out, or
 * a room predating this design, gets one).
 *
 * Returns false when nothing was issued (room missing), so the caller can carry
 * on without failing the operation it was really doing — an un-issued claim
 * token costs the creator the no-typing path, never the room.
 */
export async function attachClaimCookie(
  res: { cookies: { set(name: string, value: string, opts: ReturnType<typeof claimCookieOptions>): unknown } },
  roomId: string,
): Promise<boolean> {
  const token = await issueRoomClaimToken(roomId);
  if (!token) return false;
  res.cookies.set(claimCookieName(roomId), token, claimCookieOptions());
  return true;
}

/**
 * Extend the window on the claim credential this request ALREADY holds, by
 * re-sending that same value with a fresh `Max-Age`. No new token, no store
 * write.
 *
 * PRECONDITION: callers must have verified the presented token first. Both call
 * sites do (`POST /api/host/claim` after `verifyClaim`, and `GET /api/host/session`
 * inside an `if (await verifyClaim(...))`), so this re-sends a known-good value
 * and can never mint authority for a caller that did not prove it.
 *
 * This is deliberately the SAME shape as the TICKET-76 rolling host session
 * above, which likewise re-sets the very cookie it just verified rather than
 * issuing a new one, and for the same reason: the goal is to extend a lifetime,
 * and minting is a strictly larger operation than that goal needs.
 *
 * Two defects came from getting this wrong, both measured and both recorded in
 * the dev report, because "roll" sounds like it ought to mean "rotate":
 *   - Minting-and-APPENDING on every roll grew the room's capped hash list, so an
 *     active device silently evicted other devices — the bar tablet dropped back
 *     onto the shown-once host code, the exact dead end TICKET-104 removes.
 *   - Minting-and-REPLACING fixed that but introduced a lost-update race: two
 *     concurrent rolls (a double-mounted effect, two tabs, SavedRooms racing
 *     AdminRoom) both deleted the presented hash, so whichever response the
 *     browser kept could be the dead one. Measured directly: `aLives=false`.
 * Re-sending the verified value has neither problem because it writes nothing.
 * Rotation is not what secures this credential — server-side revocation on logout
 * is, and that is unaffected.
 */
export function rollClaimCookie(
  res: { cookies: { set(name: string, value: string, opts: ReturnType<typeof claimCookieOptions>): unknown } },
  req: NextRequest,
  roomId: string,
): boolean {
  const token = claimTokenFrom(req, roomId);
  if (!token) return false;
  res.cookies.set(claimCookieName(roomId), token, claimCookieOptions());
  return true;
}

/**
 * Whether this request presents a live claim token for `roomId`.
 *
 * `default` is excluded: it has no room record, so it has no claim tokens, and it
 * is governed by the shared env `HOST_TOKEN` instead.
 */
export async function verifyClaim(req: NextRequest, roomId: string): Promise<boolean> {
  if (roomId === DEFAULT_ROOM) return false;
  return verifyRoomClaimToken(roomId, claimTokenFrom(req, roomId));
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

// ─── Admin-claim throttle (TICKET-104; re-shaped twice, so read the history) ──
//
// Round 1 keyed this on the IP and charged a failure even when the caller
// presented nothing. `AdminRoom` claims on every session-less admin render, so
// ten ordinary admin-URL opens from a venue's shared wifi 429'd the CREATOR's
// own claim, and a 429 rendered as the code gate — the unrecoverable-code dead
// end this ticket exists to remove, delivered to the room's owner. Measured: 3
// failing runs out of 5.
//
// Round 2 re-keyed it on the caller's identity uuid, which fixed that shared
// fate but handed an unauthenticated caller an unbounded supply of
// CLIENT-CHOSEN bucket keys. The security gate measured the consequence: 1100
// claims with a fresh uuid each evicted the `login:<ip>` bucket from the shared
// process-wide LRU (`lib/rate-limit-counter.ts`, MAX_TRACKED_KEYS = 1000), so
// the host-code brute-force control became resettable at will.
//
// So this round takes both lessons at once, and the shape is what matters:
//
//   * The key is **server-derived** (the edge-set client IP), never a value the
//     caller chose. Bucket cardinality is therefore bounded by real clients, the
//     same bound `login:<ip>` has always had — a claim flood can no longer evict
//     anything that a login flood could not already.
//   * A **valid credential is never denied by it.** The route verifies the claim
//     token FIRST and only consults or charges this counter on a failure. That is
//     what kills round 1's shared fate at the root rather than by re-keying: the
//     creator's own request succeeds, so no amount of other traffic on their IP
//     can stand between them and their room.
//   * Only a request that actually PRESENTED a token is charged. A caller with no
//     claim cookie — every patron who ever opens an admin URL — is free, and
//     short-circuits before any store read.
//
// It is still not an anti-guessing control and should not be mistaken for one: a
// 256-bit token is not guessable. It is a cheap bound on repeated failures.
const CLAIM_THROTTLE_OPTS: CounterOptions = LOGIN_THROTTLE_OPTS;

/**
 * Namespaced counter key for a claim-failure bucket. The argument is the
 * SERVER-DERIVED client IP (see `clientIpFrom`) — never a client-chosen value,
 * which is what made round 2's keyspace unbounded.
 */
function claimKey(ip: string): string {
  return `hostclaim:${ip}`;
}

/**
 * True when this IP has exhausted its claim-FAILURE budget. Callers must consult
 * this only after a claim has already failed verification — a valid token is
 * never subject to it.
 */
export function isClaimThrottled(ip: string): Promise<boolean> {
  return isThrottled(claimKey(ip), CLAIM_THROTTLE_OPTS);
}

/** Record one failed claim attempt for this IP. */
export function registerClaimFailure(ip: string): Promise<void> {
  return registerFailure(claimKey(ip), CLAIM_THROTTLE_OPTS);
}

/** Clear the claim-failure bucket for this IP (successful claim). */
export function resetClaimThrottle(ip: string): Promise<void> {
  return resetKey(claimKey(ip));
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
 * Whether this request is POSITIVELY IDENTIFIABLE as coming from another site.
 *
 * Second, independent layer under the B-S2 fix. `requireHost` is the one that
 * makes the gate's measured attack a 401 — a cross-site top-level POST carries no
 * `SameSite=Lax` cookie, so it cannot prove host authority. This adds the check
 * that does not depend on a cookie attribute holding, because the whole lesson of
 * this round is that a security property resting on one mechanism nobody attacked
 * is a property nobody has verified. A future `SameSite=None`, a browser quirk, or
 * a same-site-but-not-same-origin subdomain would each quietly re-open the route;
 * this closes it on the request's own provenance instead.
 *
 * Deliberately FAIL-OPEN when provenance is unstated, and that is a considered
 * trade rather than an oversight. A non-browser client (curl, the unit suite, a
 * venue's own integration) sends neither header, and there is no way to tell it
 * apart from a browser that withheld them — so treating absence as hostile would
 * break legitimate callers to defend against an attacker who, per the paragraph
 * above, is already stopped by `requireHost` and would in any case be a *browser*
 * and therefore send the headers. Absence is not the attack shape; a stated
 * foreign origin is.
 *
 * `Sec-Fetch-Site` first (set by the browser, unforgeable by page JS, and it
 * distinguishes the top-level-navigation case the gate actually exploited).
 * `same-site` passes as well as `same-origin` so an apex/`www` deployment split
 * cannot break the shared-venue tablet's real logout; `cross-site` and `none` are
 * refused. `Origin` is the fallback for clients that send it but not
 * `Sec-Fetch-Site`; an unparseable or literal-`null` Origin is not ours.
 */
export function isCrossSiteRequest(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site) return !(site === "same-origin" || site === "same-site");
  const origin = req.headers.get("origin")?.trim();
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.get("host");
  } catch {
    return true;
  }
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
