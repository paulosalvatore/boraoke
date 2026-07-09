/**
 * Pending-moderation store (TICKET-44) — the parallel keyspace for venue-optional
 * song moderation.
 *
 * This is a SEPARATE store from the queue store (`lib/store*`, TICKET-6): the
 * frozen `QueueStore` interface is queue-shaped and MUST NOT be touched. Per the
 * ticket, pending moderation gets its own keyspace (`room:<id>:pending:*`), but it
 * mirrors #6's / feedback's driver-selection pattern EXACTLY, so it inherits the
 * same durability story: Upstash Redis in production, in-process memory for local
 * dev / CI.
 *
 *   STORE_DRIVER=upstash            → durable Upstash Redis
 *   STORE_DRIVER=memory             → in-process memory (local dev / CI)
 *   (unset) + UPSTASH_REDIS_REST_URL present → upstash
 *   (unset) + no Upstash creds      → memory  (default; boots with zero secrets)
 *
 * The whole point of this module: an unapproved entry NEVER enters the frozen
 * queue store, so the rotation engine, the public `GET /api/queue`, and the TV
 * (all of which read only `store.getQueue`) can never see it. Approval TAKES the
 * entry from here and hands it to the normal `store.addEntry` flow — that is the
 * single point where caps/fairness apply, AT approval time.
 *
 * HONEST VOLATILITY NOTE: the memory driver is per-process (each serverless
 * lambda holds its own copy) — pending entries captured under it are NOT
 * durable/shared, exactly like the queue/feedback memory drivers. Moderation
 * MUST run on Upstash in production; the live app runs memory until Upstash is
 * provisioned, a known, documented gap (same as #6 / #11).
 */

import "server-only";

import { Redis } from "@upstash/redis";
import { type PendingEntry } from "./pending-types";

/** The subset of the Redis client this store depends on (keeps it injectable). */
export interface PendingRedisLike {
  rpush(key: string, ...values: unknown[]): Promise<number>;
  lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]>;
  lrem(key: string, count: number, value: unknown): Promise<number>;
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

/**
 * Durable, room-scoped pending store. Every op is async so one interface covers
 * both the in-process memory driver and the HTTP-based Upstash driver.
 */
export interface PendingStore {
  /** Persist a pending entry (append-only; status defaults to "pending"). */
  add(item: PendingEntry): Promise<void>;

  /** All of a room's pending+rejected entries, oldest-first (host approval view). */
  listRoom(roomId: string): Promise<PendingEntry[]>;

  /** A single patron's own pending+rejected entries in a room (uuid-scoped view). */
  listForUuid(roomId: string, patronUuid: string): Promise<PendingEntry[]>;

  /** Fetch one pending entry by id, or null. */
  get(roomId: string, pendingId: string): Promise<PendingEntry | null>;

  /**
   * Pop an entry for approval: return it AND remove it from the pending list, or
   * null if it is gone / already rejected. The caller then runs the normal
   * `addEntry` flow with `entry.entry` — caps apply AT approval time.
   */
  take(roomId: string, pendingId: string): Promise<PendingEntry | null>;

  /**
   * Flip an entry to "rejected" (kept so the patron's poll surfaces it briefly).
   * Returns the rejected entry, or null if not found / already rejected.
   */
  reject(roomId: string, pendingId: string): Promise<PendingEntry | null>;

  /** Count of PENDING (not rejected) entries in a room — the room-cap input. */
  countRoom(roomId: string): Promise<number>;

  /** Count of a uuid's PENDING (not rejected) entries in a room — the uuid-cap input. */
  countUuid(roomId: string, patronUuid: string): Promise<number>;

  /** Wipe a room's pending state (test/reset helper). */
  clear(roomId: string): Promise<void>;
}

/** Redis key schema — pending's own room-scoped namespace (beside `room:<id>:queue`). */
export const pendingKeys = {
  index: (roomId: string) => `room:${roomId}:pending:index`,
  item: (roomId: string, id: string) => `room:${roomId}:pending:item:${id}`,
};

// ─────────────────────────────────────────────────────────────────────────────
// Memory driver
// ─────────────────────────────────────────────────────────────────────────────

export class MemoryPendingStore implements PendingStore {
  // roomId → (pendingId → entry). Map preserves insertion (chronological) order.
  private rooms = new Map<string, Map<string, PendingEntry>>();

  private room(roomId: string): Map<string, PendingEntry> {
    let m = this.rooms.get(roomId);
    if (!m) {
      m = new Map();
      this.rooms.set(roomId, m);
    }
    return m;
  }

  async add(item: PendingEntry): Promise<void> {
    this.room(item.roomId).set(item.pendingId, item);
  }

  async listRoom(roomId: string): Promise<PendingEntry[]> {
    return [...this.room(roomId).values()].sort((a, b) =>
      a.pendingId < b.pendingId ? -1 : a.pendingId > b.pendingId ? 1 : 0,
    );
  }

  async listForUuid(roomId: string, patronUuid: string): Promise<PendingEntry[]> {
    return (await this.listRoom(roomId)).filter(
      (p) => p.entry.patronUuid === patronUuid,
    );
  }

  async get(roomId: string, pendingId: string): Promise<PendingEntry | null> {
    return this.room(roomId).get(pendingId) ?? null;
  }

  async take(roomId: string, pendingId: string): Promise<PendingEntry | null> {
    const m = this.room(roomId);
    const item = m.get(pendingId);
    if (!item || item.status !== "pending") return null;
    m.delete(pendingId);
    return item;
  }

  async reject(roomId: string, pendingId: string): Promise<PendingEntry | null> {
    const m = this.room(roomId);
    const item = m.get(pendingId);
    if (!item || item.status !== "pending") return null;
    item.status = "rejected";
    m.set(pendingId, item);
    return item;
  }

  async countRoom(roomId: string): Promise<number> {
    let n = 0;
    for (const p of this.room(roomId).values()) if (p.status === "pending") n++;
    return n;
  }

  async countUuid(roomId: string, patronUuid: string): Promise<number> {
    let n = 0;
    for (const p of this.room(roomId).values()) {
      if (p.status === "pending" && p.entry.patronUuid === patronUuid) n++;
    }
    return n;
  }

  async clear(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstash driver
// ─────────────────────────────────────────────────────────────────────────────

export class UpstashPendingStore implements PendingStore {
  constructor(private readonly redis: PendingRedisLike) {}

  async add(item: PendingEntry): Promise<void> {
    // Item first, then index — a crash between the two leaves an orphan item
    // (harmless: only indexed ids are ever listed), never a dangling index.
    await this.redis.set(pendingKeys.item(item.roomId, item.pendingId), item);
    await this.redis.rpush(pendingKeys.index(item.roomId), item.pendingId);
  }

  private async idsFor(roomId: string): Promise<string[]> {
    const ids = await this.redis.lrange<string>(
      pendingKeys.index(roomId),
      0,
      -1,
    );
    // Sort by id so output is chronological regardless of index order (ids are
    // time-sortable). Cheap defensive sort — the index is already append-order.
    return [...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  }

  async listRoom(roomId: string): Promise<PendingEntry[]> {
    const ids = await this.idsFor(roomId);
    const out: PendingEntry[] = [];
    for (const id of ids) {
      const rec = await this.redis.get<PendingEntry>(
        pendingKeys.item(roomId, id),
      );
      if (rec) out.push(rec);
    }
    return out;
  }

  async listForUuid(roomId: string, patronUuid: string): Promise<PendingEntry[]> {
    return (await this.listRoom(roomId)).filter(
      (p) => p.entry.patronUuid === patronUuid,
    );
  }

  async get(roomId: string, pendingId: string): Promise<PendingEntry | null> {
    return (
      (await this.redis.get<PendingEntry>(
        pendingKeys.item(roomId, pendingId),
      )) ?? null
    );
  }

  async take(roomId: string, pendingId: string): Promise<PendingEntry | null> {
    const item = await this.get(roomId, pendingId);
    if (!item || item.status !== "pending") return null;
    // Remove from the index (leave no dangling id) then drop the item record.
    await this.redis.lrem(pendingKeys.index(roomId), 0, pendingId);
    await this.redis.del(pendingKeys.item(roomId, pendingId));
    return item;
  }

  async reject(roomId: string, pendingId: string): Promise<PendingEntry | null> {
    const item = await this.get(roomId, pendingId);
    if (!item || item.status !== "pending") return null;
    item.status = "rejected";
    await this.redis.set(pendingKeys.item(roomId, pendingId), item);
    return item;
  }

  async countRoom(roomId: string): Promise<number> {
    return (await this.listRoom(roomId)).filter((p) => p.status === "pending")
      .length;
  }

  async countUuid(roomId: string, patronUuid: string): Promise<number> {
    return (await this.listForUuid(roomId, patronUuid)).filter(
      (p) => p.status === "pending",
    ).length;
  }

  async clear(roomId: string): Promise<void> {
    const ids = await this.idsFor(roomId);
    const keys = ids.map((id) => pendingKeys.item(roomId, id));
    await this.redis.del(pendingKeys.index(roomId), ...keys);
  }
}

/**
 * Build an UpstashPendingStore from environment credentials. Throws if either
 * Upstash var is missing — callers only reach here when the upstash driver was
 * explicitly selected (see the singleton below). Mirrors the feedback store.
 */
export function createUpstashPendingStore(): UpstashPendingStore {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Upstash pending driver selected but UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set.",
    );
  }
  return new UpstashPendingStore(new Redis({ url, token }));
}

function resolveDriver(): "memory" | "upstash" {
  const explicit = process.env.STORE_DRIVER?.toLowerCase();
  if (explicit === "upstash" || explicit === "memory") return explicit;
  return process.env.UPSTASH_REDIS_REST_URL ? "upstash" : "memory";
}

function createPendingStore(): PendingStore {
  return resolveDriver() === "upstash"
    ? createUpstashPendingStore()
    : new MemoryPendingStore();
}

/** The process-wide pending store singleton. */
export const pendingStore: PendingStore = createPendingStore();
