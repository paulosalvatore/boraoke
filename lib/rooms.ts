/**
 * Room model + persistence (TICKET-9).
 *
 * A room is a venue's own karaoke session: a short human slug, a display name,
 * a one-time host code (venue identity until accounts arrive in #14), and a
 * settings blob (mode placeholder for #10).
 *
 * WHY a parallel store (not the `QueueStore` interface): the TICKET-6 store
 * contract is frozen and this ticket must not touch `lib/store/**`. Rooms are a
 * new domain, so they get their own tiny persistence here, using the SAME key
 * namespace (`room:<id>:meta`, alongside `room:<id>:queue`) and the SAME driver
 * selection (memory | upstash) as `lib/store.ts`. This is the one deliberate
 * place outside `lib/store*` that talks to Redis directly — kept minimal and
 * documented so the schema stays coherent.
 *
 * Persistence is best-effort durable: with Upstash configured, room records
 * survive across serverless instances; with the memory driver (local dev / CI)
 * they live per-process, exactly like the queue store's memory driver.
 */

import "server-only";

import {
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual as nodeTimingSafeEqual,
} from "crypto";
import { Redis } from "@upstash/redis";
import { DEFAULT_ROOM } from "./store";
import {
  DEFAULT_ROOM_MODE,
  normalizeRoomMode,
  type RoomMode,
} from "./rotation-modes";
import { isLocale, normalizeLocale, type Locale } from "@/i18n/locales";
import { roomCreateSetOptions, roomRetentionSeconds, roomUpdateSetOptions } from "./retention";

export interface RoomSettings {
  /**
   * Venue rotation mode (TICKET-10). Persisted as a {@link RoomMode}. Legacy
   * records (pre-#10) stored `"full"` / entry-mode placeholders — those read
   * back through `normalizeRoomMode` as the default, with NO re-migration.
   */
  mode: RoomMode;
  /**
   * Room default UI language (TICKET-30, ADDITIVE + optional). The venue sets it
   * in admin; it drives the TV surface (which never follows a per-user cookie)
   * and the first-visit default for patrons who have no explicit locale cookie.
   * Legacy/absent → `DEFAULT_LOCALE` (pt-BR) via {@link normalizeLocale}, no
   * migration and no write.
   */
  language?: Locale;
  /**
   * Venue-optional song moderation (TICKET-44, ADDITIVE + optional). When true,
   * a patron submission is diverted to a parallel PENDING keyspace
   * (`lib/pending-store.ts`) and only enters the real queue when the host
   * approves — so unapproved entries never reach the rotation engine, the public
   * queue, or the TV. Default OFF: legacy/absent → `false` via
   * {@link getRoomModeration}, no migration and no write. Mirrors `language?`.
   */
  moderation?: boolean;
}

export interface Room {
  id: string;
  name: string;
  /**
   * HMAC-SHA256 of the host code — the raw code is NEVER stored (security
   * MEDIUM-2): a Redis credential leak yields hashes, not usable codes. The raw
   * code exists only in the `createRoom` return value (shown once at /new) and
   * on the submitted side of a login, where it is hashed before comparison.
   */
  hostCodeHash: string;
  createdAt: string; // ISO 8601
  settings: RoomSettings;
  /**
   * The registered anonymous identity (`identity:{uuid}`, TICKET-26) that
   * created this room, if identity registration succeeded at creation time.
   * Optional/absent for legacy rooms created before TICKET-26 and for rooms
   * created while the identity store was down (fail-open — creation never
   * blocks on this). This is the O(1) hook TICKET-28's OAuth claim reads via
   * `identity:{uuid}:rooms` — see `lib/identity-store.ts`. Server-side
   * bookkeeping only: deliberately NOT part of `PublicRoom` below.
   */
  creatorUuid?: string;
  /**
   * Hashes of the room's live ADMIN CLAIM TOKENS (TICKET-104, security round).
   *
   * This is the credential behind `POST /api/host/claim` — the no-typing way
   * back into admin. It is a purpose-built secret, deliberately NOT the
   * `creatorUuid` above: the security gate on PR #81 demonstrated that the
   * identity uuid is published to page JS (`POST /api/identity` echoes it, and
   * `cantai_patron_uuid` mirrors it in localStorage), which made it a portable,
   * unrevokable bearer token for host control. One value cannot be both
   * client-readable and secret, so the claim now has its own.
   *
   * Only HASHES are stored, like `hostCodeHash` — a store leak yields nothing
   * usable. The raw token exists only in the httpOnly `boraoke_claim_<room>`
   * cookie and is never returned in any response body.
   *
   * An ARRAY so a venue can hold the credential on more than one device (the
   * tablet and the owner's phone), capped at `MAX_CLAIM_TOKENS`. Clearing it is
   * the SERVER-SIDE revocation that logout performs — the property a marker
   * cookie in the victim's own jar could never provide, since it left a copied
   * token working for the attacker while locking the owner out.
   */
  claimTokenHashes?: string[];
  /**
   * Which entry of `claimTokenHashes` is the ROOM CREATOR's device (TICKET-120).
   *
   * A POINTER, not a second credential: `verifyRoomClaimToken` never reads it,
   * so it grants nothing on its own and a dangling value (its hash pruned or
   * revoked) pins nothing. Its only effect is on eviction — when the list is
   * full, `issueRoomClaimToken` evicts the oldest NON-owner hash, so other
   * people's logins can never push the creator's phone off the room.
   *
   * Set once, at room creation. Cleared by logout along with every hash. It is
   * deliberately NOT re-pinned on a later login: deciding "this login is the
   * owner" would need `creatorUuid`, which the TICKET-104 gate showed is
   * client-readable, so anyone holding the code and that label could take the
   * pin and evict the real owner — the lockout this field exists to prevent.
   */
  ownerClaimTokenHash?: string;
  /**
   * The room's HOST-SESSION EPOCH — the one rotatable component of the session
   * derivation, and the only thing that can end a host session (TICKET-118).
   *
   * WHY IT EXISTS. `lib/host-auth.ts`'s `sessionValue` was a pure function of
   * `hostCodeHash`, which is immutable (the raw code is shown once and never
   * stored, so it cannot be rotated). Every session cookie a room ever issued
   * was therefore the same 64 hex characters for the room's whole life, and
   * nothing anywhere could invalidate one. The TICKET-104 security re-gate
   * measured the consequence: after the owner logged out, an attacker's claim
   * correctly 401'd while the session that claim had ALREADY minted kept
   * moderating and kept rolling itself a fresh 30-day cookie, indefinitely. Two
   * separate logins returned the byte-identical session value, so re-entering
   * the code did not help either. There was no sequence of actions available to
   * a venue owner that ended an unauthorised session.
   *
   * Mixing this counter into the derivation gives one: bumping it invalidates
   * every outstanding session for the room at once.
   *
   * ABSENT MEANS 0, AND 0 MEANS THE LEGACY DERIVATION. Read through
   * `normaliseSessionEpoch`; at 0 the HMAC message is byte-identical to the
   * pre-TICKET-118 one, so shipping this logs nobody out and no migration write
   * is needed. Same optional-additive contract as `settings.language` /
   * `settings.moderation`.
   *
   * Deliberately NOT part of `PublicRoom` — server-side bookkeeping, like
   * `creatorUuid` and `claimTokenHashes`.
   *
   * WHERE THE VALUE REALLY LIVES — this field is a FLOOR, not the source of truth.
   * Every room mutation is a whole-record read-modify-write with no compare-and-
   * swap (TICKET-127), so if the epoch lived only here, a login or settings change
   * that read the record before a revoke and wrote it back after would roll the
   * epoch back and resurrect every session the owner had just ended. So the epoch
   * is bumped in its own key (`roomSessionEpochKey`) by an atomic increment that no
   * whole-record write ever touches, and the backend's `get` reports
   * `max(this field, that counter)`. Writers carry that effective value back into
   * this field, which keeps a copy in the record in case the counter key is ever
   * lost. A stale writer can lower this copy; it cannot lower the counter, so the
   * epoch a reader sees never goes backwards.
   */
  sessionEpoch?: number;
  /**
   * The session epoch `claimTokenHashes` was written for (TICKET-118). A claim
   * token is live only while this equals the room's current `sessionEpoch`.
   *
   * WHY. "Sign out all devices" has to end the other devices' claim credentials
   * as well as their sessions, because `POST /api/host/claim` turns a claim token
   * into a session. It prunes the list down to the acting device's hash. But a
   * stale whole-record write (TICKET-127) can put the pre-revoke list straight
   * back, the attacker's hash included. Tying the list to the epoch means a list
   * written by anything that read the room before the revoke carries the OLD
   * epoch, so it grants nothing: the race fails closed (claim tokens stop
   * working, the devices fall back to their session cookie or the host code)
   * instead of failing open (a revoked credential working again).
   *
   * Absent reads as 0, and an untouched room's epoch is 0, so every room that has
   * never been through a revoke behaves exactly as before.
   */
  claimTokenEpoch?: number;
}

/** Client-safe room view — never leaks the host-code hash. */
export type PublicRoom = Pick<Room, "id" | "name" | "createdAt"> & {
  settings: RoomSettings;
};

/**
 * Hash a raw host code for storage / comparison. Deterministic keyed HMAC (not
 * a per-value salt) so the stored hash doubles as the room's session-derivation
 * secret in `lib/host-auth.ts`. Fine for a 40-bit shown-once prototype secret;
 * #14's accounts replace host codes entirely.
 *
 * STORAGE-KEY NOTE (TICKET-33 rebrand): the `cantai-hostcode-v1` HMAC key is
 * DELIBERATELY kept under the old brand — every stored `hostCodeHash` was
 * minted with it, so renaming/rotating it invalidates all live host codes AND
 * host-session derivation. Never rotate without a migration. See
 * work/tickets/TICKET-33-code-rebrand.md.
 */
export function hashHostCode(code: string): string {
  return createHmac("sha256", "cantai-hostcode-v1").update(code).digest("hex");
}

/**
 * How many admin-claim tokens one room may hold at once (TICKET-104, TICKET-120).
 *
 * More than one because a venue legitimately has more than one device: the room
 * is created on a phone and later the code is entered on the bar tablet, and
 * BOTH should keep frictionless re-entry. Small because each is a standing
 * credential; once more than this many DEVICES hold one, the oldest falls off.
 * Logout clears them all.
 *
 * "Devices", not "issues", and both paths that touch the list now keep that
 * promise (TICKET-120 — before it, the docblock here was true on the roll path
 * and false on the login path, which is how it survived review):
 *   - A ROLL never mints: a device extending its window re-sends the token it
 *     already holds with a fresh Max-Age (`rollClaimCookie`). An earlier round-4
 *     attempt minted-and-replaced on every roll; two concurrent rolls both
 *     deleted the presented hash and a lost update left the device holding a
 *     dead cookie (measured: `aLives=false bLives=true`).
 *   - A LOGIN mints only for a device that does not already present a live
 *     token for the room; one that does gets its token re-sent, exactly like a
 *     roll (`POST /api/host/login`). Five logins from one tablet use one slot.
 *
 * And when genuinely new devices do fill the list, the oldest NON-OWNER hash is
 * the one evicted: the creator's device (`ownerClaimTokenHash`) is never pushed
 * out by other people's logins. Evicted devices are always ones that typed the
 * host code, so they can type it again. Logout clears them all.
 *
 * Raising this constant would not fix the eviction; a busy venue passes any
 * number. The property is the eviction ORDER, not the size.
 */
export const MAX_CLAIM_TOKENS = 5;

/**
 * Hash an admin-claim token for storage / comparison. Its own HMAC key, distinct
 * from `hashHostCode`'s, so a claim token can never be confused with a host code
 * and neither hash is usable in the other's comparison. Brand-new in TICKET-104,
 * so it uses the current `boraoke` brand (no frozen-name constraint applies).
 */
export function hashClaimToken(token: string): string {
  return createHmac("sha256", "boraoke-claim-token-v1").update(token).digest("hex");
}

/**
 * Mint a fresh admin-claim token for a room, persist its HASH, and return the
 * RAW token for the caller to put in an httpOnly cookie. Returns null when the
 * room does not exist.
 *
 * 256 bits from the CSPRNG: unlike the 8-character host code (a human types it)
 * nothing has to read this out loud, so there is no reason for it to be
 * guessable at all.
 */
export async function issueRoomClaimToken(
  roomId: string,
  opts: { owner?: boolean } = {},
): Promise<string | null> {
  const room = await getRoom(roomId);
  if (!room) return null;
  const token = nodeRandomBytes(32).toString("base64url");
  const hash = hashClaimToken(token);
  // TICKET-118: a list written for an earlier epoch was revoked by "sign out all
  // devices" (or restored by a stale write after one), so none of it is live.
  // Start a fresh list rather than appending to it, and drop its owner pointer.
  const epoch = normaliseSessionEpoch(room.sessionEpoch);
  const bound = claimListIsLive(room);
  const base = bound ? room.claimTokenHashes ?? [] : [];
  const owner = opts.owner ? hash : bound ? room.ownerClaimTokenHash : undefined;
  const next: Room = { ...room, claimTokenHashes: capClaimHashes([...base, hash], owner) };
  if (owner !== undefined) next.ownerClaimTokenHash = owner;
  else delete next.ownerClaimTokenHash;
  // Only a room that has been through a revoke carries the field, so an
  // untouched room's record keeps its exact pre-TICKET-118 shape.
  if (epoch > 0 || next.claimTokenEpoch !== undefined) next.claimTokenEpoch = epoch;
  await roomBackend.update(next);
  return token;
}

/**
 * Whether the room's claim-hash list was written for its CURRENT session epoch,
 * and so may grant anything (TICKET-118; see `Room.claimTokenEpoch`).
 */
function claimListIsLive(room: Room): boolean {
  return normaliseSessionEpoch(room.claimTokenEpoch) === normaliseSessionEpoch(room.sessionEpoch);
}

/**
 * Trim a claim-hash list (oldest first) to MAX_CLAIM_TOKENS, never evicting
 * `owner`: the owner's hash is kept wherever it sits, and the remaining slots
 * go to the NEWEST other hashes. Order is preserved. Exported for tests.
 */
export function capClaimHashes(hashes: string[], owner?: string): string[] {
  if (hashes.length <= MAX_CLAIM_TOKENS) return hashes;
  const pinned = owner !== undefined && hashes.includes(owner) ? owner : undefined;
  const others = hashes.filter((h) => h !== pinned);
  const keep = new Set(others.slice(-(MAX_CLAIM_TOKENS - (pinned ? 1 : 0))));
  if (pinned) keep.add(pinned);
  return hashes.filter((h) => keep.has(h));
}

/**
 * Whether `token` is one of the room's live claim tokens. Constant-time against
 * every stored hash, and false for a room that holds none — which is the state
 * after a logout (revoked), for every room created before TICKET-104, and for
 * any room whose mint failed.
 */
export async function verifyRoomClaimToken(
  roomId: string,
  token: unknown,
): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0) return false;
  const room = await getRoom(roomId);
  if (!room || !claimListIsLive(room)) return false;
  const hashes = room.claimTokenHashes;
  if (!Array.isArray(hashes) || hashes.length === 0) return false;
  const candidate = hashClaimToken(token);
  // Compare against all of them, without short-circuiting on the first miss.
  let match = false;
  for (const stored of hashes) {
    if (typeof stored === "string" && timingSafeHexEqual(candidate, stored)) match = true;
  }
  return match;
}

/**
 * Revoke ONE device's claim token — the one it presents (logout, TICKET-112).
 *
 * The Tech Lead's decision (2026-10-15): a plain logout signs out only the device
 * it is tapped on. Before it, logout cleared every device's claim token and the
 * owner pin, so a staff member logging out at the end of a shift silently cost
 * the owner's phone its no-typing way back in, putting the owner back on a host
 * code shown once that they may not have. Ending everyone's access is now
 * the explicit "sign out all devices" action (`revokeRoomHostSessions`).
 *
 * Server-side, so a copy of THIS device's token stops working too. Re-entering
 * the host code on this device mints a fresh one (`POST /api/host/login`). If
 * the device's hash was the owner's, the pointer is cleared with it, which is
 * tidier than leaving it dangling (a dangling pointer pins nothing anyway).
 *
 * A no-op when the token is absent or not in the list, so a device with no claim
 * credential just has its cookies cleared by the route.
 */
export async function revokeRoomClaimToken(roomId: string, token: unknown): Promise<void> {
  if (typeof token !== "string" || token.length === 0) return;
  const room = await getRoom(roomId);
  if (!room || !Array.isArray(room.claimTokenHashes)) return;
  const hash = hashClaimToken(token);
  if (!room.claimTokenHashes.includes(hash)) return;
  const rest = room.claimTokenHashes.filter((h) => h !== hash);
  const next: Room = { ...room };
  if (rest.length > 0) next.claimTokenHashes = rest;
  else delete next.claimTokenHashes;
  if (next.ownerClaimTokenHash === hash) delete next.ownerClaimTokenHash;
  await roomBackend.update(next);
}

/**
 * Normalise a stored `sessionEpoch` into the integer the derivation uses
 * (TICKET-118). Absent, or anything that is not a non-negative finite integer,
 * reads as **0**, which is the legacy derivation.
 *
 * A numeric STRING is accepted and coerced, deliberately: the Upstash backend
 * round-trips the record as JSON, and if some driver or hand-written record ever
 * handed back `"3"`, silently falling back to 0 would **resurrect every session
 * that epoch 3 revoked** — a security fail-open in the one function whose job is
 * to make revocation stick. So anything that reads unambiguously as a
 * non-negative integer is honoured.
 *
 * Genuinely un-interpretable input (undefined, null, NaN, Infinity, a negative,
 * a fraction, an object, `""`) falls back to 0, which fails *open*. That is the
 * considered direction rather than an oversight: an uninterpretable epoch is
 * indistinguishable from a legacy record that has no epoch at all, and every
 * room created before TICKET-118 is exactly that — so failing closed would
 * refuse every live session in the product on deploy. The state is also not
 * reachable from our own code, which only ever writes an integer via
 * `revokeRoomHostSessions`.
 */
export function normaliseSessionEpoch(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isInteger(n)) return 0;
  if (n < 0) return 0;
  return n;
}

/** The room's current host-session epoch (0 when the room or the field is absent). */
export async function getRoomSessionEpoch(roomId: string): Promise<number> {
  const room = await getRoom(roomId);
  return normaliseSessionEpoch(room?.sessionEpoch);
}

/** How many times `revokeRoomHostSessions` re-tries binding the claim list after a concurrent write clobbered it. */
const CLAIM_REBIND_ATTEMPTS = 4;

/**
 * END EVERY OUTSTANDING HOST SESSION for a room, and every admin-claim
 * credential except the one the acting device presents ("sign out all devices",
 * TICKET-118).
 *
 * This is the venue's recovery lever, the thing the TICKET-104 re-gate found did
 * not exist. Two halves, both needed, because `POST /api/host/claim` turns a
 * claim token into a session, so ending sessions without ending claims ends
 * nothing:
 *
 *   1. SESSIONS. The session epoch is bumped by `roomBackend.bumpSessionEpoch`, an
 *      atomic increment of a key no whole-record write ever touches. From the
 *      moment it returns, every session value derived from an earlier epoch fails
 *      to verify (`lib/host-auth.ts`, `sessionValue`), and nothing can bring it
 *      back: a stale login or settings write carries the old epoch only into the
 *      record's copy, and readers take the max of the two.
 *   2. CLAIMS. The claim-hash list is rewritten to just the presented token's
 *      hash, tagged with the new epoch (`claimTokenEpoch`). A stale write that
 *      puts the old list back also puts the old tag back, and a list tagged with
 *      an earlier epoch grants nothing (`claimListIsLive`). That race fails closed.
 *
 * WHY IT KEEPS THE CALLER'S OWN TOKEN RATHER THAN CLEARING ALL AND RE-MINTING.
 * This is the anti-lockout property. Every mechanism this ticket's predecessors
 * added on the authentication path recreated a lockout (a capped list that
 * evicted another device; then a rotation whose two concurrent rolls each deleted
 * the presented hash, so a device was locked out by its own successful
 * re-entry). Keeping the presented hash means:
 *   - the acting device's `boraoke_claim_<room>` cookie is UNTOUCHED and still
 *     live, so nothing has to reach the browser for it to keep access;
 *   - if the response is lost (a network drop after the write commits), the
 *     device's next admin mount auto-claims with that surviving token and gets a
 *     fresh session at the new epoch.
 * When the caller presents no live claim token, every hash is dropped and the
 * route mints the caller a fresh one instead; that path depends on the response.
 *
 * WHAT A CONCURRENT WRITE CAN STILL DO, stated rather than implied:
 *   - It can NOT undo the session half: the counter only goes up.
 *   - It can NOT resurrect a pruned claim token: a restored list carries its old
 *     epoch tag.
 *   - It CAN leave the claim list tagged with an old epoch, if it lands after the
 *     rebind below has finished. Then EVERY claim token is dead, the acting
 *     device's included. The acting device still holds the session cookie this
 *     route hands back, which keeps rolling, so it stays signed in; it loses only
 *     the no-typing fallback, and a later login re-creates the list. The
 *     remaining lockout needs this race AND a lost response: then the acting
 *     device needs the host code. That is the residual until room writes are
 *     atomic (TICKET-127).
 *   - A concurrent login by someone who TYPED THE HOST CODE gets in, as it would
 *     a second later. This lever ends copied sessions and claim tokens; it does
 *     not change the host code (option C, rejected in the plan).
 *
 * Returns `no-room` when there is no record (the `default` room is governed by
 * the env `HOST_TOKEN`, so it is not revocable here). There is no "contended"
 * failure any more: success means the atomic bump happened, and that alone is
 * what ends the sessions.
 */
export type RevokeHostSessionsResult =
  | { ok: true; epoch: number; keptClaimToken: boolean }
  | { ok: false; reason: "no-room" };

export async function revokeRoomHostSessions(
  roomId: string,
  opts: { presentedClaimToken?: string } = {},
): Promise<RevokeHostSessionsResult> {
  const presented =
    typeof opts.presentedClaimToken === "string" && opts.presentedClaimToken.length > 0
      ? hashClaimToken(opts.presentedClaimToken)
      : undefined;

  const before = await getRoom(roomId);
  if (!before) return { ok: false, reason: "no-room" };

  // Half 1, sessions. Atomic and monotonic: from here on the old sessions are dead.
  const bumped = await roomBackend.bumpSessionEpoch(
    roomId,
    normaliseSessionEpoch(before.sessionEpoch),
  );

  // Half 2, claims. Rewrite the list for the CURRENT epoch (ours, or a later one if
  // another revoke got there too), keeping only the acting device's hash. Then
  // re-read: if a concurrent write left the list tagged with an older epoch, do it
  // again. Every rewrite keeps only the PRESENTED hash, so a retry can never
  // re-validate a list somebody else restored.
  for (let attempt = 0; attempt < CLAIM_REBIND_ATTEMPTS; attempt++) {
    const room = await getRoom(roomId);
    if (!room) break;
    const epoch = normaliseSessionEpoch(room.sessionEpoch);
    // Keep the acting device's hash only if it is in the stored list. It has just
    // passed `requireHost`, so it is the owner of this action, but its presented
    // value is never written into the record on its own say-so.
    const live = Array.isArray(room.claimTokenHashes) ? room.claimTokenHashes : [];
    const keep = presented !== undefined && live.includes(presented) ? [presented] : [];

    const next: Room = { ...room, sessionEpoch: epoch, claimTokenEpoch: epoch };
    if (keep.length > 0) next.claimTokenHashes = keep;
    else delete next.claimTokenHashes;
    // The owner pointer survives only if it points at the hash we kept.
    if (next.ownerClaimTokenHash !== undefined && !keep.includes(next.ownerClaimTokenHash)) {
      delete next.ownerClaimTokenHash;
    }
    await roomBackend.update(next);

    const after = await getRoom(roomId);
    if (!after) break;
    if (claimListIsLive(after)) {
      return {
        ok: true,
        epoch: normaliseSessionEpoch(after.sessionEpoch),
        keptClaimToken:
          presented !== undefined &&
          Array.isArray(after.claimTokenHashes) &&
          after.claimTokenHashes.includes(presented),
      };
    }
  }
  // Every rebind was clobbered. The sessions ARE ended (the bump is atomic); the
  // claim list is tagged with an old epoch, so it grants nothing. The route mints
  // the caller a fresh claim token.
  return { ok: true, epoch: bumped, keptClaimToken: false };
}

/** Constant-time comparison of two hex strings (mirrors lib/host-auth.ts). */
function timingSafeHexEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return nodeTimingSafeEqual(ha, hb);
}

/** Redis key for a room's metadata record (sits beside `room:<id>:queue`). */
export const roomKey = (roomId: string) => `room:${roomId}:meta`;

/**
 * Redis key for a room's host-session epoch counter (TICKET-118). Kept OUT of the
 * record so the whole-record writes cannot roll it back (see `Room.sessionEpoch`).
 * A room deletion (TICKET-151) must delete this key too.
 */
export const roomSessionEpochKey = (roomId: string) => `room:${roomId}:session-epoch`;

/**
 * Valid room id: lowercase alnum + hyphen, 1–64 chars. SECURITY-CRITICAL — the
 * id is interpolated into Redis keys, so every route must validate it before
 * any store call to prevent key injection / cross-room access.
 */
const ROOM_ID_RE = /^[a-z0-9-]{1,64}$/;

export function isValidRoomId(id: unknown): id is string {
  return typeof id === "string" && ROOM_ID_RE.test(id);
}

/**
 * Room ids that a minted slug must NEVER equal (TICKET-20). These are real
 * top-level Next.js routes (`/new`, `/api`, `/tv`, `/admin`) plus the legacy
 * single-queue room (`default`). SECURITY-CRITICAL: TICKET-20 drops the old
 * always-on random suffix in favour of the clean slug, and that suffix was what
 * previously made a `tv`/`admin`/`api`/`new` collision impossible. With the
 * clean slug, a venue literally named "TV" would slugify to `tv` and shadow the
 * `/tv` route — so `createRoom` forces a suffix whenever the clean slug is
 * reserved (see below).
 */
export const RESERVED_ROOM_IDS: ReadonlySet<string> = new Set([
  "new",
  "api",
  "tv",
  "admin",
  DEFAULT_ROOM, // "default" — the legacy global queue; never re-mintable.
]);

/** Whether `id` collides with a reserved static route / legacy room. */
export function isReservedRoomId(id: string): boolean {
  return RESERVED_ROOM_IDS.has(id);
}

/**
 * Best-effort human name recovered from a room id (TICKET-20) — used to prefill
 * the "recriar sala com este nome" path on the room-404 page. Drops a trailing
 * 4-char base32 collision/legacy suffix, turns hyphens into spaces, and
 * title-cases. Purely cosmetic (the user can edit before recreating).
 */
export function deriveRoomName(id: string): string {
  const parts = id.split("-").filter(Boolean);
  if (parts.length > 1 && /^[0-9a-hjkmnp-tv-z]{4}$/.test(parts[parts.length - 1])) {
    parts.pop();
  }
  const name = parts.join(" ").trim();
  if (!name) return "";
  return name.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Slug + host-code generation ─────────────────────────────────────────────

/** Crockford base32 alphabet (no I/L/O/U — avoids ambiguity when typed). */
const B32 = "0123456789abcdefghjkmnpqrstvwxyz";

function randomBase32(len: number): string {
  const bytes = nodeRandomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += B32[bytes[i] % 32];
  return out;
}

/**
 * Slugify a venue name into a short, human, CLEAN room id (TICKET-20 \u2014 no random
 * suffix). Strips accents, lowercases, keeps [a-z0-9], collapses runs of
 * non-alnum to single hyphens. Empty/degenerate names fall back to "sala".
 * `createRoom` is the sole place that appends a `-<suffix>` \u2014 and only on a
 * reserved-id or existing-id collision.
 */
export function slugify(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics (combining marks)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "sala";
}

/** One-time host code: 8-char Crockford base32 (~40 bits). Shown once. */
export function generateHostCode(): string {
  return randomBase32(8);
}

// ─── Persistence ─────────────────────────────────────────────────────────────

interface RoomBackend {
  get(id: string): Promise<Room | null>;
  /** Persist a NEW room record (also advances the creation counter). */
  create(room: Room): Promise<void>;
  /**
   * Persist an UPDATED room record in place (TICKET-10, additive — does NOT
   * touch the creation counter). No-op if the room does not exist.
   */
  update(room: Room): Promise<void>;
  /** Total rooms ever created (ceiling input — see ROOM_MAX). */
  count(): Promise<number>;
  /**
   * Atomically advance the room's session epoch counter (TICKET-118) and return
   * the new value, which is always greater than both the counter's previous value
   * and `floor` (the effective epoch the caller read). The counter lives in its
   * own key, which no whole-record `update` touches, so nothing but this call can
   * change it and it never goes down. `get` reports `max(record field, counter)`
   * as `sessionEpoch`.
   */
  bumpSessionEpoch(id: string, floor: number): Promise<number>;
}

/**
 * Report the effective session epoch on a record read from the store: the larger
 * of the record's own copy and the atomic counter (TICKET-118, see
 * `Room.sessionEpoch`). Leaves the record untouched when both are 0, so a room
 * that never went through a revoke reads back exactly as stored.
 */
function withEffectiveEpoch(room: Room, counter: unknown): Room {
  const stored = normaliseSessionEpoch(room.sessionEpoch);
  const effective = Math.max(stored, normaliseSessionEpoch(counter));
  return effective === stored ? room : { ...room, sessionEpoch: effective };
}

class MemoryRoomBackend implements RoomBackend {
  private rooms = new Map<string, Room>();
  private epochs = new Map<string, number>();
  async get(id: string): Promise<Room | null> {
    const room = this.rooms.get(id);
    return room ? withEffectiveEpoch(room, this.epochs.get(id)) : null;
  }
  async bumpSessionEpoch(id: string, floor: number): Promise<number> {
    // Synchronous between the read and the write, so atomic in one process, which
    // is what INCR gives the Upstash backend.
    const next = Math.max((this.epochs.get(id) ?? 0) + 1, floor + 1);
    this.epochs.set(id, next);
    return next;
  }
  async create(room: Room): Promise<void> {
    this.rooms.set(room.id, room);
  }
  async update(room: Room): Promise<void> {
    if (this.rooms.has(room.id)) this.rooms.set(room.id, room);
  }
  async count(): Promise<number> {
    return this.rooms.size;
  }
}

/**
 * Exported for its unit test only (TICKET-118), which drives it with a fake
 * `Redis`; production code reaches it through `roomBackend`.
 */
export class UpstashRoomBackend implements RoomBackend {
  constructor(private readonly redis: Redis) {}
  async get(id: string): Promise<Room | null> {
    // ONE round trip for the record and its epoch counter (TICKET-118), so the
    // revocation lever adds no extra request and no write to the auth path.
    const [room, counter] = await this.redis.mget<[Room | null, number | string | null]>(
      roomKey(id),
      roomSessionEpochKey(id),
    );
    return room ? withEffectiveEpoch(room, counter) : null;
  }
  async bumpSessionEpoch(id: string, floor: number): Promise<number> {
    const key = roomSessionEpochKey(id);
    let next = Number(await this.redis.incr(key));
    // The counter can only be behind the record's copy if the key was lost. Jump
    // past the copy so the bump still ends every session the copy describes.
    if (next <= floor) next = Number(await this.redis.incrby(key, floor + 1 - next));
    // TICKET-91: when retention is on, the counter expires with its room rather
    // than outliving it. Copied from the record's remaining TTL (the record keeps
    // its create-time TTL across updates), so both go at the same moment.
    if (roomRetentionSeconds() != null) {
      const ttl = await this.redis.pttl(roomKey(id));
      if (ttl > 0) await this.redis.pexpire(key, ttl);
    }
    return next;
  }
  async create(room: Room): Promise<void> {
    // TICKET-91: apply the configurable retention TTL at first write. Default
    // is no-expiry (roomCreateSetOptions() → undefined ⇒ a plain SET), so this
    // is byte-for-byte the previous behavior until ROOM_RETENTION_DAYS is set.
    await this.redis.set(roomKey(room.id), room, roomCreateSetOptions());
    // Monotonic creation counter — the ceiling input. Cheaper and simpler than
    // SCANning the keyspace; slightly over-counts if rooms are ever deleted or
    // expire, which only makes the ceiling MORE conservative, never less.
    await this.redis.incr(ROOMS_COUNT_KEY);
  }
  async update(room: Room): Promise<void> {
    // In-place overwrite (no counter change). The caller only invokes this for a
    // room it already read, so a `set` here never creates a phantom record.
    // TICKET-91: when retention is ON, preserve the create-time TTL with
    // keepTtl so a host mode/language/moderation change does not silently reset
    // the expiry window; when OFF this is a plain SET (no behavior change).
    await this.redis.set(roomKey(room.id), room, roomUpdateSetOptions());
  }
  async count(): Promise<number> {
    const v = await this.redis.get<number | string>(ROOMS_COUNT_KEY);
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  }
}

/** Redis key holding the global room-creation counter. */
export const ROOMS_COUNT_KEY = "rooms:count";

function resolveDriver(): "memory" | "upstash" {
  const explicit = process.env.STORE_DRIVER?.toLowerCase();
  if (explicit === "upstash" || explicit === "memory") return explicit;
  return process.env.UPSTASH_REDIS_REST_URL ? "upstash" : "memory";
}

function createBackend(): RoomBackend {
  if (resolveDriver() === "upstash") {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error(
        "Upstash driver selected but UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set.",
      );
    }
    return new UpstashRoomBackend(new Redis({ url, token }));
  }
  return new MemoryRoomBackend();
}

/**
 * Process-wide room backend singleton (mirrors the queue store singleton) —
 * pinned to `globalThis` (TICKET-116), for the reason documented at length on
 * `store` in `lib/store.ts`: an unpinned module-level singleton is DISCARDED on
 * module re-evaluation, which under `next dev` happens on first compile of every
 * route and again after each ~25s idle eviction. A room seeded by a test was
 * gone by the time the next request arrived, and `getRoomLanguage` fell back to
 * the app default — which is exactly how `served-lang.spec.ts:105` failed while
 * the product was correct. Pinning makes re-evaluation rebind to the SAME
 * instance. Unconditional: the e2e suite runs a production build on the memory
 * driver, and the Upstash backend holds no local state.
 */
const globalForRooms = globalThis as unknown as { __boraokeRoomBackend?: RoomBackend };
export const roomBackend: RoomBackend =
  globalForRooms.__boraokeRoomBackend ?? (globalForRooms.__boraokeRoomBackend = createBackend());

/**
 * The active room-store driver ("memory" | "upstash"), TICKET-20. Mirrors the
 * queue store's driver selection.
 */
export function roomStoreDriver(): "memory" | "upstash" {
  return resolveDriver();
}

/**
 * Whether rooms are EPHEMERAL in the current deployment (TICKET-20). True when a
 * production build is running on the memory driver — i.e. Upstash is not
 * provisioned, so a created room lives only on the lambda that made it and any
 * other lambda 404s it. Drives the honest "salas ainda são temporárias" notice
 * on `/new` (success) and the room-404 page. In dev/CI (memory but NOT
 * production) this stays false, so it never leaks into local UX or tests.
 */
export function isEphemeralRoomStore(): boolean {
  return resolveDriver() === "memory" && process.env.NODE_ENV === "production";
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Fetch a room record (server-side; includes the host-code hash). */
export async function getRoom(roomId: string): Promise<Room | null> {
  if (!isValidRoomId(roomId)) return null;
  return roomBackend.get(roomId);
}

/** Fetch a client-safe room view (no host-code material). */
export async function getPublicRoom(roomId: string): Promise<PublicRoom | null> {
  const room = await getRoom(roomId);
  if (!room) return null;
  return {
    id: room.id,
    name: room.name,
    createdAt: room.createdAt,
    settings: room.settings,
  };
}

/**
 * Global active-room ceiling (security HIGH-1) — the hard cap an IP-rotating
 * attacker hits after the per-IP throttle. Env-tunable; default 500. The
 * counter is monotonic and stays a conservative ceiling even as records expire:
 * TICKET-91 adds a configurable TTL on the `room:<id>:meta` write path (OFF by
 * default — see lib/retention.ts), and expiring the frozen queue store's
 * `room:<id>:{queue,paused}` keys remains the coordinated follow-up.
 */
export function roomMax(): number {
  const raw = Number(process.env.ROOM_MAX);
  return Number.isFinite(raw) && raw >= 0 ? raw : 500;
}

/** Result of a successful creation — the ONLY place the raw host code exists. */
export interface CreatedRoom {
  room: Room;
  /** Raw one-time host code. Shown once at /new; only its hash is stored. */
  hostCode: string;
}

/**
 * Create a room from a venue name. Generates a unique slug (retrying on the
 * rare suffix collision) and a one-time host code, storing only the code's
 * hash (MEDIUM-2). Returns `null` when the global ROOM_MAX ceiling is reached
 * (HIGH-1) — callers reply 503 "estamos lotados".
 *
 * TICKET-75 — `language` seeds `settings.language` from the CREATOR's locale.
 * The venue TV (`/[room]/tv`) deliberately follows the ROOM's language, never a
 * patron cookie (one screen cannot arbitrate 40 phones), but until now nothing
 * ever wrote that field: every room was born pt-BR and an English-speaking host
 * got a Portuguese TV. The parameter is OPTIONAL and only written when a valid
 * {@link Locale} is passed — omitting it reproduces the previous record shape
 * byte-for-byte (no `language` key), so the "additive, no-migration" contract of
 * {@link getRoomLanguage} is unchanged and the host's admin override
 * ({@link setRoomLanguage}) still wins, since it writes after creation.
 */
export async function createRoom(
  name: string,
  creatorUuid?: string,
  language?: Locale,
): Promise<CreatedRoom | null> {
  if ((await roomBackend.count()) >= roomMax()) return null;
  const trimmed = name.trim().slice(0, 60);
  const base = slugify(trimmed);
  // TICKET-20: use the CLEAN slug by default. Append a `-<4-char>` suffix ONLY
  // when the clean id is reserved (would shadow a static route — see
  // RESERVED_ROOM_IDS) or already taken. The loop condition is checked BEFORE
  // the body, so a free, non-reserved base keeps its clean id; the bound guards
  // against a pathological suffix-collision streak (resolves in 1 in practice).
  let id = base;
  for (
    let attempt = 0;
    attempt < 8 && (isReservedRoomId(id) || (await roomBackend.get(id)) !== null);
    attempt++
  ) {
    id = `${base}-${randomBase32(4)}`;
  }
  const hostCode = generateHostCode();
  const room: Room = {
    id,
    name: trimmed || "sala",
    hostCodeHash: hashHostCode(hostCode),
    createdAt: new Date().toISOString(),
    settings: {
      mode: DEFAULT_ROOM_MODE,
      // TICKET-75: seed only when the caller supplied a SUPPORTED locale.
      // `isLocale` re-validates at the storage boundary so an untrusted value
      // (a spoofed NEXT_LOCALE cookie, an untyped JS caller) can never land in
      // stored room state; anything else omits the key entirely and falls
      // through to DEFAULT_LOCALE via `getRoomLanguage`, exactly as before.
      ...(isLocale(language) ? { language } : {}),
    },
    ...(creatorUuid ? { creatorUuid } : {}),
  };
  await roomBackend.create(room);
  return { room, hostCode };
}

/**
 * Read a room's current rotation mode, normalized (TICKET-10). Rooms without a
 * record (e.g. the legacy DEFAULT_ROOM) or with a legacy settings value read
 * back as the default — no re-migration, no write.
 */
export async function getRoomMode(roomId: string): Promise<RoomMode> {
  const room = await getRoom(roomId);
  return normalizeRoomMode(room?.settings?.mode);
}

/**
 * Set a room's rotation mode (TICKET-10, additive host mutator). Persists in
 * place via the backend `update`. Returns the new mode on success, or `null`
 * when the room does not exist (mode-switch is host-authed, so this only fires
 * for a real, host-owned room). Idempotent.
 */
export async function setRoomMode(
  roomId: string,
  mode: RoomMode,
): Promise<RoomMode | null> {
  const room = await getRoom(roomId);
  if (!room) return null;
  const next: Room = { ...room, settings: { ...room.settings, mode } };
  await roomBackend.update(next);
  return mode;
}

/**
 * Read a room's default UI language, normalized (TICKET-30). Rooms without a
 * record or without the (optional, additive) `language` field read back as the
 * default locale (pt-BR) — no re-migration, no write. Mirrors `getRoomMode`.
 */
export async function getRoomLanguage(roomId: string): Promise<Locale> {
  const room = await getRoom(roomId);
  return normalizeLocale(room?.settings?.language);
}

/**
 * Set a room's default UI language (TICKET-30, additive host mutator). Persists
 * in place via the backend `update`. Returns the new language on success, or
 * `null` when the room does not exist (language-set is host-authed, so this only
 * fires for a real, host-owned room). Idempotent. Mirrors `setRoomMode`.
 */
export async function setRoomLanguage(
  roomId: string,
  language: Locale,
): Promise<Locale | null> {
  const room = await getRoom(roomId);
  if (!room) return null;
  const next: Room = {
    ...room,
    settings: { ...room.settings, language },
  };
  await roomBackend.update(next);
  return language;
}

/**
 * Read a room's moderation flag, normalized (TICKET-44). Rooms without a record
 * or without the (optional, additive) `moderation` field read back as `false`
 * (moderation OFF = current behavior) — no re-migration, no write. Mirrors
 * `getRoomLanguage`. This is the single gate the submission route branches on.
 */
export async function getRoomModeration(roomId: string): Promise<boolean> {
  const room = await getRoom(roomId);
  return room?.settings?.moderation === true;
}

/**
 * Set a room's moderation flag (TICKET-44, additive host mutator). Persists in
 * place via the backend `update`. Returns the new value on success, or `null`
 * when the room does not exist (moderation-set is host-authed, so this only
 * fires for a real, host-owned room). Idempotent. Mirrors `setRoomLanguage`.
 */
export async function setRoomModeration(
  roomId: string,
  moderation: boolean,
): Promise<boolean | null> {
  const room = await getRoom(roomId);
  if (!room) return null;
  const next: Room = {
    ...room,
    settings: { ...room.settings, moderation },
  };
  await roomBackend.update(next);
  return moderation;
}

/** The legacy single-queue room id (pre-multi-room prototype). */
export { DEFAULT_ROOM };
