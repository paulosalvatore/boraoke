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

import { createHmac, randomBytes as nodeRandomBytes } from "crypto";
import { Redis } from "@upstash/redis";
import { DEFAULT_ROOM } from "./store";
import {
  DEFAULT_ROOM_MODE,
  normalizeRoomMode,
  type RoomMode,
} from "./rotation-modes";

export interface RoomSettings {
  /**
   * Venue rotation mode (TICKET-10). Persisted as a {@link RoomMode}. Legacy
   * records (pre-#10) stored `"full"` / entry-mode placeholders — those read
   * back through `normalizeRoomMode` as the default, with NO re-migration.
   */
  mode: RoomMode;
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
 */
export function hashHostCode(code: string): string {
  return createHmac("sha256", "cantai-hostcode-v1").update(code).digest("hex");
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
    await this.redis.set(roomKey(room.id), room);
    // Monotonic creation counter — the ceiling input. Cheaper and simpler than
    // SCANning the keyspace; slightly over-counts if rooms are ever deleted
    // (none are yet — expiry is a #14 follow-up), which only makes the ceiling
    // MORE conservative, never less.
    await this.redis.incr(ROOMS_COUNT_KEY);
  }
  async update(room: Room): Promise<void> {
    // In-place overwrite (no counter change). The caller only invokes this for a
    // room it already read, so a `set` here never creates a phantom record.
    await this.redis.set(roomKey(room.id), room);
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

/** Process-wide room backend singleton (mirrors the queue store singleton). */
export const roomBackend: RoomBackend = createBackend();

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
 * attacker hits after the per-IP throttle. Env-tunable; default 500. Rooms are
 * never deleted yet, so the counter is monotonic — a room TTL/idle-expiry
 * (e.g. 7 idle days) is a recorded #14 follow-up: it is NOT cheap today because
 * expiring `room:<id>:meta` must be coordinated with the frozen queue store's
 * `room:<id>:{queue,paused}` keys, which this ticket must not touch.
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
 */
export async function createRoom(name: string): Promise<CreatedRoom | null> {
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
    settings: { mode: DEFAULT_ROOM_MODE },
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

/** The legacy single-queue room id (pre-multi-room prototype). */
export { DEFAULT_ROOM };
