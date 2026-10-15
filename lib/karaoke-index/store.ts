/**
 * Karaoke index storage + per-instance loading.
 *
 * STORAGE CHOICE: Upstash Redis (already provisioned), one key per channel
 * shard, value = gzip(JSON shard) as base64.
 *   - Size: ~36k rows is ~3 MB as JSON and ~1 MB gzipped (measured in the
 *     original harvest spike; re-measured by `npm run index:harvest`). Spread across
 *     ~60 shards that is ~20 KB per key — far inside Upstash free-tier request
 *     and record limits, and ~1.3 MB of bandwidth per cold-instance load.
 *   - Refreshable per channel by the cron without rewriting the whole index.
 *   - Every shard is written with a Redis TTL equal to INDEX_MAX_AGE_MS, so
 *     even if the refresh job stops entirely, Redis itself deletes the data
 *     when the YouTube API Services retention window closes.
 *   Rejected: bundling the index into the deployment (refresh would need a
 *   commit + redeploy, and stale data would keep shipping), Vercel Edge Config
 *   (item size limits far below 1 MB) and Vercel Blob (a new service the Tech
 *   Lead would have to provision, for no gain over the Redis already in place).
 *
 * QUERYING happens in process memory: each instance loads the shards once,
 * builds a `KaraokeIndex` (posting lists — no per-query Redis traffic), and
 * reloads after INDEX_RELOAD_MS. Expired shards are filtered on every load,
 * and an instance whose OLDEST loaded shard crosses the retention limit while
 * cached rebuilds immediately — so a stale shard is never served, not even
 * from a warm instance.
 *
 * FAIL-OPEN to live search: any Redis error, missing config or corrupt shard
 * yields `null` (or an index without that shard), and the route falls back to
 * today's live path.
 */

import "server-only";

import { readFileSync } from "fs";
import { gunzipSync, gzipSync } from "zlib";

import { Redis } from "@upstash/redis";

import channelIds from "./channels.json";
import { KaraokeIndex } from "./matcher";
import { INDEX_MAX_AGE_MS, isChannelShard, isShardFresh, type ChannelShard } from "./types";

/** How long an instance reuses its loaded index before re-reading Redis. */
export const INDEX_RELOAD_MS = 60 * 60 * 1000;

const SHARD_PREFIX = "ki:shard:";
/** Hash channelId -> harvestedAt; lets the cron pick the oldest without reading rows. */
export const STAMPS_KEY = "ki:stamps";

export const INDEX_CHANNELS: readonly string[] = channelIds as string[];

function useUpstash(): boolean {
  const explicit = process.env.STORE_DRIVER?.toLowerCase();
  if (explicit === "upstash") return true;
  if (explicit === "memory") return false;
  return !!process.env.UPSTASH_REDIS_REST_URL;
}

let redisClient: Redis | null = null;
export function getIndexRedis(): Redis | null {
  if (!useUpstash()) return null;
  if (redisClient) return redisClient;
  try {
    redisClient = Redis.fromEnv();
    return redisClient;
  } catch {
    return null;
  }
}

export function encodeShard(shard: ChannelShard): string {
  return gzipSync(Buffer.from(JSON.stringify(shard))).toString("base64");
}

export function decodeShard(v: unknown): ChannelShard | null {
  if (typeof v !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(gunzipSync(Buffer.from(v, "base64")).toString("utf8"));
    return isChannelShard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Keep only fresh shards, in channel-rank order. The single place where the
 * retention limit is enforced on the read path.
 */
export function freshShards(
  shards: readonly (ChannelShard | null)[],
  now = Date.now(),
): ChannelShard[] {
  return shards.filter((s): s is ChannelShard => !!s && isShardFresh(s, now));
}

/** Write one shard + its stamp. Redis TTL = retention limit (auto-delete). */
export async function writeShard(redis: Redis, shard: ChannelShard): Promise<void> {
  const ttl = Math.max(1, INDEX_MAX_AGE_MS - (Date.now() - shard.harvestedAt));
  await redis.set(`${SHARD_PREFIX}${shard.channelId}`, encodeShard(shard), { px: ttl });
  await redis.hset(STAMPS_KEY, { [shard.channelId]: shard.harvestedAt });
}

/** Read harvestedAt stamps for the configured channels (missing -> 0). */
export async function readStamps(redis: Redis): Promise<Map<string, number>> {
  const raw = (await redis.hgetall<Record<string, number | string>>(STAMPS_KEY)) ?? {};
  const out = new Map<string, number>();
  for (const id of INDEX_CHANNELS) out.set(id, Number(raw[id] ?? 0) || 0);
  return out;
}

async function loadFromRedis(redis: Redis, now: number): Promise<ChannelShard[]> {
  if (INDEX_CHANNELS.length === 0) return [];
  const values = await redis.mget<unknown[]>(...INDEX_CHANNELS.map((id) => `${SHARD_PREFIX}${id}`));
  return freshShards(values.map(decodeShard), now);
}

/**
 * Local-dev / test-gate source: a fixture file (gzip JSON `{ shards }`), named
 * by KARAOKE_INDEX_FILE. Never honoured in production — production reads only
 * from Redis, which the refresh job keeps inside the retention window.
 */
function loadFromFile(now: number): ChannelShard[] {
  const file = process.env.KARAOKE_INDEX_FILE;
  if (!file || process.env.NODE_ENV === "production") return [];
  try {
    const parsed = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as { shards?: unknown[] };
    return freshShards((parsed.shards ?? []).map((s) => (isChannelShard(s) ? s : null)), now);
  } catch {
    return [];
  }
}

interface Loaded {
  index: KaraokeIndex | null;
  loadedAt: number;
  oldestHarvestedAt: number;
}
let loaded: Loaded | null = null;
let inflight: Promise<Loaded> | null = null;

async function load(now: number): Promise<Loaded> {
  let shards: ChannelShard[] = [];
  const redis = getIndexRedis();
  try {
    shards = redis ? await loadFromRedis(redis, now) : loadFromFile(now);
  } catch {
    shards = []; // fail-open: no index -> live search
  }
  return {
    index: shards.length ? new KaraokeIndex(shards) : null,
    loadedAt: now,
    oldestHarvestedAt: shards.reduce((m, s) => Math.min(m, s.harvestedAt), Infinity),
  };
}

/**
 * The instance's current index, or null when none is available. Never throws.
 */
export async function getKaraokeIndex(now = Date.now()): Promise<KaraokeIndex | null> {
  const expired =
    !loaded ||
    now - loaded.loadedAt >= INDEX_RELOAD_MS ||
    // A cached shard just crossed the retention limit: rebuild without it NOW.
    now - loaded.oldestHarvestedAt >= INDEX_MAX_AGE_MS;
  if (expired) {
    inflight ??= load(now).finally(() => {
      inflight = null;
    });
    loaded = await inflight;
  }
  return loaded?.index ?? null;
}

/** Test helper. */
export function _resetKaraokeIndex(): void {
  loaded = null;
  inflight = null;
  redisClient = null;
}
