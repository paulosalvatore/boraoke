/**
 * Telemetry store (TICKET-12) — append-only raw product events.
 *
 * SEPARATE store from the queue store (`lib/store*`, frozen) and the feedback
 * store (`lib/feedback-store.ts`): own module, own `telemetry:*` keyspace, but
 * it mirrors the house driver-selection pattern exactly:
 *
 *   STORE_DRIVER=upstash            → durable Upstash Redis
 *   STORE_DRIVER=memory             → in-process memory (local dev / CI)
 *   (unset) + UPSTASH_REDIS_REST_URL present → upstash
 *   (unset) + no Upstash creds      → memory  (default; boots with zero secrets)
 *
 * STORAGE DESIGN: events are rpush'd onto per-UTC-day lists
 * (`telemetry:events:<YYYY-MM-DD>`), with `telemetry:days` as the bucket
 * registry. Raw events only — derivable metrics live in the rollup, never here.
 *
 * NO CURSOR CONTRACT (lesson from PR #11's opus pass): under concurrent
 * serverless writes, in-list order ≠ commit order and `ts` values from
 * different lambdas can interleave. Reads are whole-day-range only, sorted by
 * `ts` as a BEST-EFFORT presentation order. Nothing here is a watermark; do
 * not build incremental export on top of list positions.
 *
 * HONEST VOLATILITY NOTE: the memory driver is per-process — events captured
 * under it vanish on restart and are not shared across lambdas, exactly like
 * the queue/feedback memory drivers. Production telemetry requires Upstash
 * (same instance/env vars as TICKET-6; no extra provisioning).
 */

import "server-only";

import { Redis } from "@upstash/redis";
import {
  dayOf,
  dayRange,
  telemetryKeys,
  TELEMETRY_RETENTION_SECONDS,
  type TelemetryEvent,
} from "./telemetry-types";

/**
 * Memory-driver event cap (security L1): the memory driver is dev/CI-only but
 * still reachable from the public beacon — cap the heap, drop-oldest past it.
 */
export const MEMORY_MAX_EVENTS = 10_000;

export interface ListRangeOptions {
  /** Hard cap on returned events (defense against unbounded reads). */
  limit?: number;
}

/**
 * Append-oriented telemetry store. Every op is async so one interface covers
 * both the in-process memory driver and the HTTP-based Upstash driver.
 */
export interface TelemetryStore {
  /** Persist one raw event (append-only; events are immutable). */
  append(event: TelemetryEvent): Promise<void>;

  /**
   * Read all events whose UTC day falls in [fromDay, toDay] (inclusive,
   * `YYYY-MM-DD`), sorted by `ts` (best-effort — see header).
   */
  listRange(
    fromDay: string,
    toDay: string,
    opts?: ListRangeOptions,
  ): Promise<TelemetryEvent[]>;

  /** Days (`YYYY-MM-DD`) that have at least one stored event. */
  listDays(): Promise<string[]>;

  /** Wipe all telemetry state (test/reset helper). */
  clear(): Promise<void>;
}

function sortByTs(events: TelemetryEvent[]): TelemetryEvent[] {
  return [...events].sort((a, b) =>
    a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory driver
// ─────────────────────────────────────────────────────────────────────────────

export class MemoryTelemetryStore implements TelemetryStore {
  private buckets = new Map<string, TelemetryEvent[]>();
  private total = 0;

  constructor(private readonly maxEvents: number = MEMORY_MAX_EVENTS) {}

  async append(event: TelemetryEvent): Promise<void> {
    const day = dayOf(event.ts);
    const bucket = this.buckets.get(day) ?? [];
    bucket.push(event);
    this.buckets.set(day, bucket);
    this.total += 1;
    // Cap (security L1): drop the oldest event (earliest day bucket, head).
    while (this.total > this.maxEvents) {
      const earliestDay = [...this.buckets.keys()].sort()[0];
      const earliest = this.buckets.get(earliestDay)!;
      earliest.shift();
      if (earliest.length === 0) this.buckets.delete(earliestDay);
      this.total -= 1;
    }
  }

  async listRange(
    fromDay: string,
    toDay: string,
    opts: ListRangeOptions = {},
  ): Promise<TelemetryEvent[]> {
    const out: TelemetryEvent[] = [];
    for (const day of dayRange(fromDay, toDay)) {
      const bucket = this.buckets.get(day);
      if (bucket) out.push(...bucket);
    }
    const sorted = sortByTs(out);
    return opts.limit != null && opts.limit >= 0
      ? sorted.slice(0, opts.limit)
      : sorted;
  }

  async listDays(): Promise<string[]> {
    return [...this.buckets.keys()].sort();
  }

  async clear(): Promise<void> {
    this.buckets.clear();
    this.total = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstash driver
// ─────────────────────────────────────────────────────────────────────────────

/** The subset of the Redis client this store depends on (keeps it injectable). */
export interface TelemetryRedisLike {
  rpush(key: string, ...values: unknown[]): Promise<number>;
  lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export class UpstashTelemetryStore implements TelemetryStore {
  constructor(private readonly redis: TelemetryRedisLike) {}

  async append(event: TelemetryEvent): Promise<void> {
    const day = dayOf(event.ts);
    // Event first, then registry — a crash between the two leaves an event in
    // an unregistered day (recoverable: keys are date-derivable), never a
    // registered-but-empty day surprise in `clear`.
    const len = await this.redis.rpush(telemetryKeys.day(day), event);
    // Retention (security M3): TTL set at the day-key's FIRST write so raw
    // events age out after rollups capture them (constant documented in
    // telemetry-types). rpush returning 1 = the key was just created.
    if (len === 1) {
      await this.redis.expire(
        telemetryKeys.day(day),
        TELEMETRY_RETENTION_SECONDS,
      );
    }
    await this.redis.sadd(telemetryKeys.days, day);
  }

  async listRange(
    fromDay: string,
    toDay: string,
    opts: ListRangeOptions = {},
  ): Promise<TelemetryEvent[]> {
    const out: TelemetryEvent[] = [];
    for (const day of dayRange(fromDay, toDay)) {
      const events = await this.redis.lrange<TelemetryEvent>(
        telemetryKeys.day(day),
        0,
        -1,
      );
      out.push(...events);
    }
    const sorted = sortByTs(out);
    return opts.limit != null && opts.limit >= 0
      ? sorted.slice(0, opts.limit)
      : sorted;
  }

  async listDays(): Promise<string[]> {
    const days = await this.redis.smembers(telemetryKeys.days);
    return [...days].sort();
  }

  async clear(): Promise<void> {
    const days = await this.redis.smembers(telemetryKeys.days);
    const keys = days.map((d) => telemetryKeys.day(d));
    await this.redis.del(telemetryKeys.days, ...keys);
  }
}

/**
 * Build an UpstashTelemetryStore from environment credentials. Throws if
 * either Upstash var is missing — callers only reach here when the upstash
 * driver was explicitly selected (see the singleton below).
 */
export function createUpstashTelemetryStore(): UpstashTelemetryStore {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Upstash telemetry driver selected but UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set.",
    );
  }
  return new UpstashTelemetryStore(new Redis({ url, token }));
}

function resolveDriver(): "memory" | "upstash" {
  const explicit = process.env.STORE_DRIVER?.toLowerCase();
  if (explicit === "upstash" || explicit === "memory") return explicit;
  return process.env.UPSTASH_REDIS_REST_URL ? "upstash" : "memory";
}

function createTelemetryStore(): TelemetryStore {
  return resolveDriver() === "upstash"
    ? createUpstashTelemetryStore()
    : new MemoryTelemetryStore();
}

/** The process-wide telemetry store singleton. */
export const telemetryStore: TelemetryStore = createTelemetryStore();
