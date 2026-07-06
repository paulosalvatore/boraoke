/**
 * Upstash Redis queue store (TICKET-6) — the durable, shared production driver.
 *
 * Data model (room-scoped, Redis-native):
 *   room:<roomId>:queue   → a LIST of QueueEntry objects (head = now playing).
 *                           @upstash/redis JSON-serializes objects on write and
 *                           parses them on read (automaticDeserialization).
 *   room:<roomId>:paused  → "1" / "0" flag.
 *
 * Hot patron path (addEntry) uses atomic RPUSH; advance uses atomic LPOP. The
 * lower-frequency host ops (removeEntry, reorder) do a read-modify-write, which
 * is acceptable for a small single-host queue at PMF volume.
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
    await this.rewrite(key, next);
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
    const clamped = Math.max(0, Math.min(newIndex, queue.length - 1));
    const [entry] = queue.splice(idx, 1);
    queue.splice(clamped, 0, entry);
    await this.rewrite(key, queue);
    return true;
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

  /** Replace a list's contents wholesale (RPUSH requires ≥1 value). */
  private async rewrite(key: string, entries: QueueEntry[]): Promise<void> {
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
