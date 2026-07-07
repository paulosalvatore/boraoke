/**
 * Upstash Redis queue store (TICKET-6) — the durable, shared production driver.
 *
 * Data model (room-scoped, Redis-native):
 *   room:<roomId>:queue   → a LIST of QueueEntry objects (head = now playing).
 *                           @upstash/redis JSON-serializes objects on write and
 *                           parses them on read (automaticDeserialization).
 *   room:<roomId>:paused  → "1" / "0" flag.
 *
 * Hot patron path (addEntry) uses atomic RPUSH; advance uses atomic LPOP.
 *
 * Atomic read-modify-write (TICKET-21). The ordering ops (`rewrite` for the
 * rotation re-lay, plus `removeEntry`/`reorder`) computed their new list
 * client-side then did `del`+`rpush` — a non-atomic read→write with a
 * lost-update window: a concurrent `addEntry` (atomic RPUSH) landing between the
 * caller's read and the rewrite was PERMANENTLY dropped (the patron saw "added",
 * their song vanished). @upstash/redis@1.38 over the stateless REST transport has
 * NO WATCH (optimistic locking needs a held connection REST doesn't have), and
 * its MULTI/EXEC only pipelines a fixed command list — neither can do
 * read-then-conditional-write CAS. The one server-side atomic primitive it
 * exposes is a Lua script via EVAL. So all three ordering ops route through ONE
 * Lua merge script (`MERGE_SCRIPT`) that runs the whole read→merge→write
 * atomically server-side: Redis's single-threaded execution serializes it
 * against every concurrent RPUSH, so no submit can ever be lost.
 *
 * The client is injected (see `createUpstashStore`) so unit tests can drive a
 * fake Redis with zero network/credentials.
 */

import "server-only";

import { Redis } from "@upstash/redis";
import {
  keys,
  QUEUE_MAX,
  type QueueEntry,
  type QueueStore,
} from "./types";

/**
 * Atomic merge-on-write (TICKET-21). Runs entirely inside one EVAL, so it is
 * atomic against every concurrent RPUSH/LPOP.
 *
 * KEYS[1] = queue list key.
 * ARGV[1] = JSON array of the DESIRED entries, each element itself the exact
 *           `JSON.stringify` of a QueueEntry (the same string RPUSH would store).
 * ARGV[2] = JSON array of the SNAPSHOT ids — the ids the caller read before
 *           computing the desired ordering.
 *
 * Merge rule — final list =
 *   (1) the desired entries whose id is STILL present in the current list, in
 *       desired order  (a concurrent advance/remove that dropped an id is
 *       respected — the vanished id is NOT resurrected);   then
 *   (2) every current entry whose id was NOT in the snapshot — i.e. entries
 *       appended by a concurrent addEntry AFTER the caller's read — preserved in
 *       their current order  (this is the lost-update fix: a racing submit can
 *       never be silently dropped).
 *
 * Desired strings are RPUSH'd VERBATIM (decoded only to read `.id`, never
 * re-encoded) so payloads round-trip byte-for-byte. Returns the final length.
 */
export const MERGE_SCRIPT = `
local key = KEYS[1]
local desired = cjson.decode(ARGV[1])
local snapIds = cjson.decode(ARGV[2])

local inSnapshot = {}
for _, id in ipairs(snapIds) do inSnapshot[id] = true end

local current = redis.call('LRANGE', key, 0, -1)
local present = {}
for _, s in ipairs(current) do
  local ok, obj = pcall(cjson.decode, s)
  if ok and obj.id ~= nil then present[obj.id] = true end
end

local out = {}
for _, s in ipairs(desired) do
  local ok, obj = pcall(cjson.decode, s)
  if ok and obj.id ~= nil and present[obj.id] then
    out[#out + 1] = s
  end
end
for _, s in ipairs(current) do
  local ok, obj = pcall(cjson.decode, s)
  if ok and obj.id ~= nil and not inSnapshot[obj.id] then
    out[#out + 1] = s
  end
end

redis.call('DEL', key)
if #out > 0 then
  redis.call('RPUSH', key, unpack(out))
end
return #out
`;

/** The subset of the Redis client this store depends on (keeps it injectable). */
export interface RedisLike {
  lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]>;
  llen(key: string): Promise<number>;
  rpush(key: string, ...values: unknown[]): Promise<number>;
  lpop<T = unknown>(key: string): Promise<T | null>;
  lindex<T = unknown>(key: string, index: number): Promise<T | null>;
  del(...keys: string[]): Promise<number>;
  set(key: string, value: unknown): Promise<unknown>;
  get<T = unknown>(key: string): Promise<T | null>;
  /** EVAL a Lua script (TICKET-21 atomic RMW). Matches @upstash/redis's signature. */
  eval<T = unknown>(script: string, keys: string[], args: unknown[]): Promise<T>;
}

export class UpstashStore implements QueueStore {
  constructor(private readonly redis: RedisLike) {}

  async getQueue(roomId: string): Promise<QueueEntry[]> {
    return this.redis.lrange<QueueEntry>(keys.queue(roomId), 0, -1);
  }

  async addEntry(roomId: string, entry: QueueEntry): Promise<boolean> {
    const key = keys.queue(roomId);
    // Soft cap check — a small race window here is an acceptable DoS guard.
    const len = await this.redis.llen(key);
    if (len >= QUEUE_MAX) return false;
    await this.redis.rpush(key, entry);
    return true;
  }

  async removeEntry(roomId: string, entryId: string): Promise<boolean> {
    const key = keys.queue(roomId);
    const queue = await this.redis.lrange<QueueEntry>(key, 0, -1);
    const next = queue.filter((e) => e.id !== entryId);
    if (next.length === queue.length) return false; // not found
    // Merge-apply with the full read id-set as snapshot: the removed entry is in
    // the snapshot (so NOT re-appended as a stray "concurrent add"), while a
    // submit that raced this remove (id not in snapshot) is preserved.
    await this.mergeApply(key, next, queue.map((e) => e.id));
    return true;
  }

  async advance(roomId: string): Promise<QueueEntry | null> {
    const key = keys.queue(roomId);
    await this.redis.lpop<QueueEntry>(key);
    return (await this.redis.lindex<QueueEntry>(key, 0)) ?? null;
  }

  async nowPlaying(roomId: string): Promise<QueueEntry | null> {
    return (await this.redis.lindex<QueueEntry>(keys.queue(roomId), 0)) ?? null;
  }

  async reorder(
    roomId: string,
    entryId: string,
    newIndex: number,
  ): Promise<boolean> {
    const key = keys.queue(roomId);
    const queue = await this.redis.lrange<QueueEntry>(key, 0, -1);
    const idx = queue.findIndex((e) => e.id === entryId);
    if (idx === -1) return false;
    const snapshot = queue.map((e) => e.id);
    const clamped = Math.max(0, Math.min(newIndex, queue.length - 1));
    const [entry] = queue.splice(idx, 1);
    queue.splice(clamped, 0, entry);
    // Same merge-apply: the reorder is a permutation of the snapshot, and a
    // concurrent submit lands at the tail rather than being lost.
    await this.mergeApply(key, queue, snapshot);
    return true;
  }

  async rewrite(
    roomId: string,
    entries: QueueEntry[],
    opts?: { snapshot?: string[] },
  ): Promise<void> {
    const key = keys.queue(roomId);
    if (!opts?.snapshot) {
      // Wholesale replace (original TICKET-10 contract; empty array empties).
      await this.rewriteKey(key, entries);
      return;
    }
    await this.mergeApply(key, entries, opts.snapshot);
  }

  async setPaused(roomId: string, paused: boolean): Promise<void> {
    await this.redis.set(keys.paused(roomId), paused ? "1" : "0");
  }

  async isPaused(roomId: string): Promise<boolean> {
    const v = await this.redis.get<string | number | boolean>(
      keys.paused(roomId),
    );
    // Deserialization may coerce "1" → 1; accept any truthy encoding.
    return v === "1" || v === 1 || v === true;
  }

  async clear(roomId: string): Promise<void> {
    await this.redis.del(keys.queue(roomId), keys.paused(roomId));
  }

  /**
   * Atomic merge-on-write via the Lua script (TICKET-21). Desired entries are
   * passed as their exact JSON strings and RPUSH'd verbatim; the snapshot id-set
   * lets the script tell a caller-known entry (to drop/keep) from a concurrent
   * append (to preserve). O(1) round-trips (one EVAL).
   */
  private async mergeApply(
    key: string,
    desired: QueueEntry[],
    snapshot: string[],
  ): Promise<number> {
    const desiredArg = JSON.stringify(desired.map((e) => JSON.stringify(e)));
    const snapshotArg = JSON.stringify(snapshot);
    return this.redis.eval<number>(MERGE_SCRIPT, [key], [desiredArg, snapshotArg]);
  }

  /** Replace a list's contents wholesale (RPUSH requires ≥1 value). */
  private async rewriteKey(key: string, entries: QueueEntry[]): Promise<void> {
    await this.redis.del(key);
    if (entries.length > 0) {
      await this.redis.rpush(key, ...entries);
    }
  }
}

/**
 * Build an UpstashStore from environment credentials.
 * Requires UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (set by the
 * Vercel Marketplace Upstash integration). Throws if either is missing —
 * callers should only reach here when the upstash driver was explicitly
 * selected (see `lib/store.ts`).
 */
export function createUpstashStore(): UpstashStore {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Upstash driver selected but UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set.",
    );
  }
  return new UpstashStore(new Redis({ url, token }));
}
