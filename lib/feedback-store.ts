/**
 * Feedback store (TICKET-11) — durable capture for the automated feedback loop.
 *
 * This is a SEPARATE store from the queue store (`lib/store*`, TICKET-6): the
 * frozen `QueueStore` interface is queue-shaped and MUST NOT be touched. Per the
 * ticket ("own module, own keys") feedback gets its own keyspace, but it mirrors
 * #6's driver-selection pattern exactly, so it inherits the same durability
 * story: Upstash Redis in production, in-process memory for local dev / CI.
 *
 *   STORE_DRIVER=upstash            → durable Upstash Redis
 *   STORE_DRIVER=memory             → in-process memory (local dev / CI)
 *   (unset) + UPSTASH_REDIS_REST_URL present → upstash
 *   (unset) + no Upstash creds      → memory  (default; boots with zero secrets)
 *
 * HONEST VOLATILITY NOTE: the memory driver is per-process (each serverless
 * lambda holds its own copy) — feedback captured under it is NOT durable/shared,
 * exactly like the queue memory driver. Feedback MUST run on Upstash in
 * production (losing feedback is losing the product's fuel). The live app runs
 * memory until Upstash is provisioned; that is a known, documented gap.
 */

import "server-only";

import { Redis } from "@upstash/redis";
import { v4 as uuidv4 } from "uuid";
import {
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  type FeedbackRecord,
  type FeedbackStatus,
} from "./feedback-types";

export interface ListOptions {
  /** Return only records created AFTER this id (lexicographic watermark cursor). */
  since?: string;
  /** Cap the number of records returned (defense against unbounded reads). */
  limit?: number;
}

export interface RateResult {
  allowed: boolean;
  /** Submission count in the current window (including the attempt just made). */
  count: number;
}

/**
 * Durable feedback store. Every op is async so one interface covers both the
 * in-process memory driver and the HTTP-based Upstash driver.
 */
export interface FeedbackStore {
  /** Persist a record (append-only). */
  add(record: FeedbackRecord): Promise<void>;

  /** List records in chronological order, optionally after a watermark. */
  list(opts?: ListOptions): Promise<FeedbackRecord[]>;

  /** Fetch one record by id, or null. */
  get(id: string): Promise<FeedbackRecord | null>;

  /**
   * Update a record's status (+ optional triageRef). Returns false if not found.
   * Powers the intake `new → triaged` write path and the future close-the-loop.
   */
  updateStatus(
    id: string,
    status: FeedbackStatus,
    triageRef?: string,
  ): Promise<boolean>;

  /**
   * Register a submission attempt for a uuid and report whether it is within the
   * fixed-window rate limit (5/uuid/hour). Durable + server-side.
   */
  hitRateLimit(uuid: string): Promise<RateResult>;

  /** Wipe all feedback state (test/reset helper). */
  clear(): Promise<void>;
}

/** Time-sortable id: base36(ms) prefix (fixed width) + random tail. */
export function generateFeedbackId(now: number = Date.now()): string {
  const ts = now.toString(36).padStart(9, "0"); // sortable until well past year 5000
  const rand = uuidv4().replace(/-/g, "").slice(0, 12);
  return `${ts}-${rand}`;
}

/** Redis key schema — feedback's own namespace (never collides with `room:*`). */
export const feedbackKeys = {
  index: "feedback:index",
  item: (id: string) => `feedback:item:${id}`,
  rate: (uuid: string, windowStart: number) =>
    `feedback:rl:${uuid}:${windowStart}`,
};

// ─────────────────────────────────────────────────────────────────────────────
// Memory driver
// ─────────────────────────────────────────────────────────────────────────────

interface RateBucket {
  count: number;
  resetAt: number;
}

export class MemoryFeedbackStore implements FeedbackStore {
  // Map preserves insertion order → chronological iteration.
  private items = new Map<string, FeedbackRecord>();
  private rate = new Map<string, RateBucket>();

  async add(record: FeedbackRecord): Promise<void> {
    this.items.set(record.id, record);
  }

  async list(opts: ListOptions = {}): Promise<FeedbackRecord[]> {
    let out = [...this.items.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    if (opts.since) out = out.filter((r) => r.id > opts.since!);
    if (opts.limit != null && opts.limit >= 0) out = out.slice(0, opts.limit);
    return out;
  }

  async get(id: string): Promise<FeedbackRecord | null> {
    return this.items.get(id) ?? null;
  }

  async updateStatus(
    id: string,
    status: FeedbackStatus,
    triageRef?: string,
  ): Promise<boolean> {
    const rec = this.items.get(id);
    if (!rec) return false;
    rec.status = status;
    if (triageRef !== undefined) rec.triageRef = triageRef;
    this.items.set(id, rec);
    return true;
  }

  async hitRateLimit(uuid: string): Promise<RateResult> {
    const now = Date.now();
    const bucket = this.rate.get(uuid);
    if (!bucket || now >= bucket.resetAt) {
      this.rate.set(uuid, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return { allowed: true, count: 1 };
    }
    bucket.count += 1;
    return { allowed: bucket.count <= RATE_LIMIT_MAX, count: bucket.count };
  }

  async clear(): Promise<void> {
    this.items.clear();
    this.rate.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstash driver
// ─────────────────────────────────────────────────────────────────────────────

/** The subset of the Redis client this store depends on (keeps it injectable). */
export interface FeedbackRedisLike {
  rpush(key: string, ...values: unknown[]): Promise<number>;
  lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]>;
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export class UpstashFeedbackStore implements FeedbackStore {
  constructor(private readonly redis: FeedbackRedisLike) {}

  async add(record: FeedbackRecord): Promise<void> {
    // Item first, then index — a crash between the two leaves an orphan item
    // (harmless: only indexed ids are ever listed), never a dangling index.
    await this.redis.set(feedbackKeys.item(record.id), record);
    await this.redis.rpush(feedbackKeys.index, record.id);
  }

  async list(opts: ListOptions = {}): Promise<FeedbackRecord[]> {
    let ids = await this.redis.lrange<string>(feedbackKeys.index, 0, -1);
    // Sort by id so output is chronological regardless of index insertion order
    // (ids are time-sortable); the `since` cursor is then a clean lexicographic cut.
    ids = [...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    if (opts.since) ids = ids.filter((id) => id > opts.since!);
    if (opts.limit != null && opts.limit >= 0) ids = ids.slice(0, opts.limit);
    const records: FeedbackRecord[] = [];
    for (const id of ids) {
      const rec = await this.redis.get<FeedbackRecord>(feedbackKeys.item(id));
      if (rec) records.push(rec);
    }
    return records;
  }

  async get(id: string): Promise<FeedbackRecord | null> {
    return (await this.redis.get<FeedbackRecord>(feedbackKeys.item(id))) ?? null;
  }

  async updateStatus(
    id: string,
    status: FeedbackStatus,
    triageRef?: string,
  ): Promise<boolean> {
    const rec = await this.redis.get<FeedbackRecord>(feedbackKeys.item(id));
    if (!rec) return false;
    rec.status = status;
    if (triageRef !== undefined) rec.triageRef = triageRef;
    await this.redis.set(feedbackKeys.item(id), rec);
    return true;
  }

  async hitRateLimit(uuid: string): Promise<RateResult> {
    const windowStart = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS);
    const key = feedbackKeys.rate(uuid, windowStart);
    const count = await this.redis.incr(key);
    if (count === 1) {
      // First hit in this window — set TTL so the counter self-expires.
      await this.redis.expire(key, Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) + 60);
    }
    return { allowed: count <= RATE_LIMIT_MAX, count };
  }

  async clear(): Promise<void> {
    const ids = await this.redis.lrange<string>(feedbackKeys.index, 0, -1);
    const keys = ids.map((id) => feedbackKeys.item(id));
    await this.redis.del(feedbackKeys.index, ...keys);
  }
}

/**
 * Build an UpstashFeedbackStore from environment credentials. Throws if either
 * Upstash var is missing — callers only reach here when the upstash driver was
 * explicitly selected (see the singleton below).
 */
export function createUpstashFeedbackStore(): UpstashFeedbackStore {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Upstash feedback driver selected but UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set.",
    );
  }
  return new UpstashFeedbackStore(new Redis({ url, token }));
}

function resolveDriver(): "memory" | "upstash" {
  const explicit = process.env.STORE_DRIVER?.toLowerCase();
  if (explicit === "upstash" || explicit === "memory") return explicit;
  return process.env.UPSTASH_REDIS_REST_URL ? "upstash" : "memory";
}

function createFeedbackStore(): FeedbackStore {
  return resolveDriver() === "upstash"
    ? createUpstashFeedbackStore()
    : new MemoryFeedbackStore();
}

/** The process-wide feedback store singleton. */
export const feedbackStore: FeedbackStore = createFeedbackStore();
