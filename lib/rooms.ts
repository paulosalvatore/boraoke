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
import { roomCreateSetOptions, roomUpdateSetOptions } from "./retention";

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
   */
  sessionEpoch?: number;
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
 * How many admin-claim tokens one room may hold at once (TICKET-104).
 *
 * More than one because a venue legitimately has more than one device: the room
 * is created on a phone and later the code is entered on the bar tablet, and
 * BOTH should keep frictionless re-entry. Small because each is a standing
 * credential; once more than this many DEVICES hold one, the oldest falls off.
 * Logout clears them all.
 *
 * "Devices", not "issues", and that distinction is what keeps this cap safe to
 * hold small. It is enforced by NOT minting on a roll at all: a device extending
 * its window re-sends the token it already holds with a fresh Max-Age
 * (`rollClaimCookie`), so the list only ever grows when a genuinely new device
 * earns a credential. An earlier round-4 attempt instead minted-and-replaced on
 * every roll; that is recorded in the dev report as a defect, because two
 * concurrent rolls both deleted the presented hash and a lost update left the
 * device holding a dead cookie (measured: `aLives=false bLives=true`). There are
 * regression tests for both the eviction property and the concurrency one.
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
export async function issueRoomClaimToken(roomId: string): Promise<string | null> {
  const room = await getRoom(roomId);
  if (!room) return null;
  const token = nodeRandomBytes(32).toString("base64url");
  const next = [...(room.claimTokenHashes ?? []), hashClaimToken(token)].slice(
    -MAX_CLAIM_TOKENS,
  );
  await roomBackend.update({ ...room, claimTokenHashes: next });
  return token;
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
  const hashes = room?.claimTokenHashes;
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
 * Revoke EVERY claim token for a room (logout). This is server-side state, so a
 * token already copied off the device stops working too — the whole point.
 * Re-entering the host code mints a fresh one (`POST /api/host/login`).
 */
export async function revokeRoomClaimTokens(roomId: string): Promise<void> {
  const room = await getRoom(roomId);
  if (!room) return;
  if (!room.claimTokenHashes?.length) return;
  const next = { ...room };
  delete next.claimTokenHashes;
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

/** How many times `revokeRoomHostSessions` re-tries a bump that a concurrent write clobbered. */
const EPOCH_BUMP_ATTEMPTS = 4;

/**
 * END EVERY OUTSTANDING HOST SESSION for a room, and every admin-claim
 * credential except the one the acting device presents (TICKET-118).
 *
 * This is the venue's recovery lever — the thing the TICKET-104 re-gate found did
 * not exist. It does both halves in ONE read-modify-write, because doing them in
 * two would let a concurrent write land between them and leave the room in a
 * state where sessions are dead but a stolen claim token can mint a fresh one:
 *
 *   1. `sessionEpoch` is bumped, so every session value derived from the old
 *      epoch stops verifying (`lib/host-auth.ts`, `sessionValue`).
 *   2. `claimTokenHashes` is pruned to just the presented token's hash, so a
 *      copied claim credential cannot immediately re-claim a new session. Both
 *      halves are needed: `POST /api/host/claim` converts a claim token into a
 *      session, so revoking sessions without revoking claims revokes nothing.
 *
 * WHY IT KEEPS THE CALLER'S OWN TOKEN RATHER THAN CLEARING ALL AND RE-MINTING —
 * this is the anti-lockout property, and it is the whole reason the function is
 * shaped this way. Every mechanism this ticket's predecessors added on the
 * authentication path recreated a lockout (a capped list that evicted another
 * device, then a rotation whose two concurrent rolls each deleted the presented
 * hash, so a device was locked out by its own successful re-entry). Keeping the
 * presented hash means:
 *   - the acting device's `boraoke_claim_<room>` cookie is UNTOUCHED and still
 *     live, so nothing has to reach the browser for it to retain access;
 *   - if the response is lost entirely — a network drop after this write commits
 *     — the device's next admin mount auto-claims with that surviving token and
 *     gets a fresh session at the new epoch. There is no response-delivery
 *     lockout window, which a clear-all-and-re-mint design would have.
 * When the caller presents no live claim token, every hash is dropped and the
 * route mints the caller a fresh one instead; that path depends on the response,
 * and the route documents it.
 *
 * LOST UPDATES. There is no compare-and-swap for room records (`RoomBackend` is
 * get/create/update/count; the Upstash `update` is a plain `SET`), so a
 * concurrent `issueRoomClaimToken` / `setRoomMode` can clobber this write — the
 * pre-existing whole-record read-modify-write hazard. We therefore re-read and
 * confirm the epoch actually advanced, retrying a bounded number of times. The
 * failure mode that survives is "the revocation did not take", reported to the
 * caller as a failure; it is never "the owner is locked out", because the
 * caller's replacement session is derived AFTER this returns, from whatever
 * epoch is actually stored (see the route).
 *
 * The two failure reasons are returned DISTINCTLY, because they mean different
 * things to a venue owner: `no-room` is "there is nothing here to revoke" (the
 * `default` room has no record and is governed by the env `HOST_TOKEN`, so it is
 * not revocable here), while `contended` is "try again" — a transient loss to a
 * concurrent write, where the sessions are still live.
 */
export type RevokeHostSessionsResult =
  | { ok: true; epoch: number; keptClaimToken: boolean }
  | { ok: false; reason: "no-room" | "contended" };

export async function revokeRoomHostSessions(
  roomId: string,
  opts: { presentedClaimToken?: string } = {},
): Promise<RevokeHostSessionsResult> {
  const presented =
    typeof opts.presentedClaimToken === "string" && opts.presentedClaimToken.length > 0
      ? hashClaimToken(opts.presentedClaimToken)
      : undefined;

  for (let attempt = 0; attempt < EPOCH_BUMP_ATTEMPTS; attempt++) {
    const room = await getRoom(roomId);
    if (!room) return { ok: false, reason: "no-room" };
    const current = normaliseSessionEpoch(room.sessionEpoch);
    const target = current + 1;

    // Keep the acting device's hash only if it is genuinely live right now —
    // never trust the presented value into the record on its own say-so.
    const live = Array.isArray(room.claimTokenHashes) ? room.claimTokenHashes : [];
    const keep = presented !== undefined && live.includes(presented) ? [presented] : [];

    const next: Room = { ...room, sessionEpoch: target };
    if (keep.length > 0) next.claimTokenHashes = keep;
    else delete next.claimTokenHashes;
    await roomBackend.update(next);

    // Confirm the write landed. A concurrent whole-record update can clobber it;
    // ANY advance past `current` is success (a racing revoke that bumped further
    // has already invalidated the same sessions this call was asked to end).
    const after = await getRoom(roomId);
    if (!after) return { ok: false, reason: "no-room" };
    const landed = normaliseSessionEpoch(after.sessionEpoch);
    if (landed > current) {
      const keptClaimToken =
        keep.length > 0 &&
        Array.isArray(after.claimTokenHashes) &&
        after.claimTokenHashes.includes(presented!);
      return { ok: true, epoch: landed, keptClaimToken };
    }
  }
  // Every attempt was clobbered. Report failure rather than a false success —
  // the caller must not tell a venue owner that sessions were ended when they
  // were not.
  return { ok: false, reason: "contended" };
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
}

class MemoryRoomBackend implements RoomBackend {
  private rooms = new Map<string, Room>();
  async get(id: string): Promise<Room | null> {
    return this.rooms.get(id) ?? null;
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

class UpstashRoomBackend implements RoomBackend {
  constructor(private readonly redis: Redis) {}
  async get(id: string): Promise<Room | null> {
    return (await this.redis.get<Room>(roomKey(id))) ?? null;
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
