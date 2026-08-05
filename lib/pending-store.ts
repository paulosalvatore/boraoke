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
  /** Batch fetch: one record per key, in key order, null for missing. */
  mget<T = unknown>(...keys: string[]): Promise<(T | null)[]>;
  set(key: string, value: unknown): Promise<unknown>;
  /** Set a TTL (in ms) on an existing key (Upstash PEXPIRE). */
  pexpire(key: string, ms: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  /**
   * EVAL a Lua script — the only server-side atomic primitive the stateless
   * Upstash REST transport exposes (no WATCH/CAS). Mirrors `RedisLike.eval` in
   * lib/store/upstash.ts and @upstash/redis's own signature.
   */
  eval<T = unknown>(script: string, keys: string[], args: unknown[]): Promise<T>;
}

/**
 * TTL applied to an item record the moment it is flipped to "rejected", so
 * rejected orphans self-expire instead of accumulating forever (the id lingers
 * in the index until lazily pruned on the next read). 10 minutes is comfortably
 * longer than the patron's ~3s poll interval, so the "rejected" state reliably
 * surfaces to the patron before the record vanishes.
 */
export const REJECTED_PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

  /**
   * Bulk-reject EVERY still-`pending` entry in a room, flipping each to
   * "rejected" (never deleting, never approving). Already-`rejected` entries are
   * left untouched, so the call is idempotent (a second call rejects 0). Returns
   * the number of entries flipped. Used when moderation transitions ON → OFF so
   * no patron is stranded on "aguardando aprovação" forever (TICKET-49).
   */
  rejectAllPending(roomId: string): Promise<number>;

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

  async rejectAllPending(roomId: string): Promise<number> {
    let n = 0;
    for (const item of this.room(roomId).values()) {
      if (item.status === "pending") {
        item.status = "rejected";
        n++;
      }
    }
    return n;
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

/**
 * Atomic bulk-reject. Runs the whole read→flip→write inside ONE `EVAL`, so it is
 * serialized against every concurrent `take`/`add`/`reject` by Redis's
 * single-threaded execution.
 *
 * WHY: the previous implementation was a client-side read-modify-write — one
 * listing pass, then a `SET` per still-pending item. Anything that raced the gap
 * between the read and the write was lost: a host approval (`take`) that popped
 * an entry mid-loop had its deletion resurrected as a "rejected" record (the
 * patron's approved song reappearing as refused), and the entry a patron
 * submitted after the listing pass survived a "reject everything" sweep as still
 * pending. The stateless Upstash REST transport has no WATCH and its MULTI/EXEC
 * only pipelines a fixed command list, so — exactly as `MERGE_SCRIPT` in
 * lib/store/upstash.ts — a Lua script is the only primitive that can do a
 * read-then-conditional-write atomically. It also collapses O(N) round-trips
 * into one.
 *
 * KEYS[1] = the room's pending index (list of pendingIds).
 * ARGV[1] = item-key prefix; the item key is `prefix .. pendingId`.
 * ARGV[2] = TTL in ms applied to each flipped record.
 *
 * NOTE — item keys are DERIVED from the ARGV prefix rather than declared in
 * KEYS, a deliberate divergence from `MERGE_SCRIPT` (which declares every key it
 * touches): the pendingIds live in the index and are not known client-side, so
 * they cannot be enumerated into KEYS before the read. Correct on single-node
 * Upstash; it would violate Redis Cluster's cross-slot key-declaration rules if
 * this keyspace ever moved to a clustered deployment.
 *
 * COST — the flip is O(N) BLOCKING work on Redis's single thread (N = index
 * length: pending plus not-yet-expired rejected entries), where the old loop was
 * O(N) non-blocking client round-trips. That is the trade for atomicity, and it
 * is comfortably safe at the default PENDING_ROOM_MAX of 100; anyone raising
 * that ceiling substantially should re-check this script's hold on the event
 * loop first.
 *
 * Semantics preserved from the loop it replaces, one-for-one: only entries whose
 * stored status is still `pending` are flipped (already-`rejected` ones are left
 * untouched, so the call stays idempotent), nothing is ever deleted or approved,
 * the index is left intact so patron polls still surface the rejected entries,
 * each flipped record gets the bounded TTL, and an id whose record is already
 * gone (expired) is lazily LREM'd from the index — the same read-path prune
 * `listRoom` performs. Returns the number of entries flipped.
 *
 * The record is decoded and re-encoded with cjson; every persisted field is a
 * string or boolean, so the round-trip is lossless (no integer/float coercion).
 */
export const REJECT_ALL_PENDING_SCRIPT = `
local indexKey = KEYS[1]
local prefix = ARGV[1]
local ttl = tonumber(ARGV[2])

local ids = redis.call('LRANGE', indexKey, 0, -1)
local flipped = 0

for _, id in ipairs(ids) do
  local itemKey = prefix .. id
  local raw = redis.call('GET', itemKey)
  if raw == false or raw == nil then
    redis.call('LREM', indexKey, 0, id)
  else
    local ok, obj = pcall(cjson.decode, raw)
    if ok and obj.status == 'pending' then
      obj.status = 'rejected'
      redis.call('SET', itemKey, cjson.encode(obj))
      redis.call('PEXPIRE', itemKey, ttl)
      flipped = flipped + 1
    end
  end
end

return flipped
`;

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
    // Empty-case guard: Upstash MGET with zero keys is invalid — never call it.
    if (ids.length === 0) return [];
    // One batched round-trip instead of N per-id GETs (the 3s-poll cost fix).
    const recs = await this.redis.mget<PendingEntry>(
      ...ids.map((id) => pendingKeys.item(roomId, id)),
    );
    const out: PendingEntry[] = [];
    for (let i = 0; i < ids.length; i++) {
      const rec = recs[i];
      if (rec) {
        out.push(rec);
      } else {
        // Lazy index prune: the record is genuinely gone (expired/missing), so
        // drop its dead id from the index. Best-effort read-path cleanup — only
        // ever removes ids whose slot came back null, never a live record's id.
        await this.redis.lrem(pendingKeys.index(roomId), 0, ids[i]);
      }
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
    // Bound the rejected orphan's lifetime so it self-expires (the id is lazily
    // pruned from the index on the next listRoom that sees the null slot).
    await this.redis.pexpire(
      pendingKeys.item(roomId, pendingId),
      REJECTED_PENDING_TTL_MS,
    );
    return item;
  }

  async rejectAllPending(roomId: string): Promise<number> {
    // One atomic server-side script — see REJECT_ALL_PENDING_SCRIPT for why a
    // client-side read-modify-write loop was unsafe here.
    try {
      const flipped = await this.redis.eval<number>(
        REJECT_ALL_PENDING_SCRIPT,
        [pendingKeys.index(roomId)],
        [pendingKeys.item(roomId, ""), REJECTED_PENDING_TTL_MS],
      );
      return Number(flipped) || 0;
    } catch (err) {
      // Degrade, never throw: this runs on the moderation ON→OFF transition, and
      // an EVAL-specific blip (scripting disabled/unsupported, a malformed-script
      // reply) must not fail the host's toggle. A full Redis outage still
      // surfaces as before — the fallback issues its own commands and its errors
      // propagate to the route, unchanged from the pre-script behaviour. Falling
      // back to the old non-atomic loop reinstates the (narrow) lost-update
      // window for that one call but is otherwise identical, so behaviour is
      // never worse than before the script existed. The fallback is itself
      // idempotent — it only flips entries still stored as "pending" — so a
      // partially-applied script followed by the fallback cannot double-count or
      // undo anything.
      //
      // Loud on purpose: a PERMANENT EVAL failure would otherwise silently run
      // the racy loop forever, which is exactly the bug the script exists to
      // close. Never swallow the reason.
      console.warn(
        "[pending-store] bulk-reject EVAL failed — falling back to the NON-ATOMIC loop (lost-update window reopened)",
        err,
      );
      return this.rejectAllPendingUnsafeFallback(roomId);
    }
  }

  /**
   * Pre-script bulk-reject: one listing pass, then a `set` + `pexpire` per
   * still-pending item. Non-atomic (a concurrent take/add between the read and
   * the write is lost) — used only when EVAL is unavailable. Index untouched, so
   * rejected entries stay indexed and the patron poll still surfaces them.
   */
  private async rejectAllPendingUnsafeFallback(roomId: string): Promise<number> {
    let n = 0;
    for (const item of await this.listRoom(roomId)) {
      if (item.status !== "pending") continue;
      item.status = "rejected";
      await this.redis.set(pendingKeys.item(roomId, item.pendingId), item);
      // Same bounded TTL as single reject — rejected orphans self-expire.
      await this.redis.pexpire(
        pendingKeys.item(roomId, item.pendingId),
        REJECTED_PENDING_TTL_MS,
      );
      n++;
    }
    return n;
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
