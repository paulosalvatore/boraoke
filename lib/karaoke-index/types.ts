/**
 * Karaoke index — shared shapes.
 *
 * The index is stored PER CHANNEL ("shard"): one shard per harvested karaoke
 * channel, each carrying its own `harvestedAt`. Per-channel shards are what make
 * the refresh job incremental (refresh the oldest few channels per run) and what
 * make expiry precise (a shard past the YouTube API Services retention limit is
 * dropped on its own, without throwing away channels refreshed yesterday).
 *
 * DATA MINIMISATION (YouTube API Services policy): a row stores exactly
 * videoId, title and duration; the channel title is stored once per shard. No
 * thumbnails (derived from the videoId at read time), no descriptions, no stats.
 */

/** One stored video: [videoId, title, duration ("m:ss" / "h:mm:ss" / "")]. */
export type IndexRow = [videoId: string, title: string, duration: string];

export interface ChannelShard {
  /** Shard format version — bump on any breaking change to this shape. */
  v: 1;
  channelId: string;
  channelTitle: string;
  /** Epoch ms of the harvest that produced these rows. Drives expiry. */
  harvestedAt: number;
  rows: IndexRow[];
}

/**
 * How long harvested API data may be served before it is treated as expired.
 *
 * The YouTube API Services Developer Policies require stored API data to be
 * refreshed or deleted within 30 days. The index is refreshed far more often
 * than that (see REFRESH_TARGET_AGE_MS); this is the hard stop: a shard older
 * than this is NEVER served, and the search route falls back to live search
 * for anything it would have answered. A stale index therefore degrades to
 * today's behaviour instead of being served silently.
 */
export const INDEX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The refresh job aims to re-harvest every channel at least this often, leaving
 * a 23-day margin under INDEX_MAX_AGE_MS for a run of failed crons.
 */
export const REFRESH_TARGET_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** True when a shard is still inside the retention window at `now`. */
export function isShardFresh(shard: Pick<ChannelShard, "harvestedAt">, now = Date.now()): boolean {
  return (
    Number.isFinite(shard.harvestedAt) &&
    shard.harvestedAt <= now + 60_000 && // a shard "from the future" is corrupt, not fresh
    now - shard.harvestedAt < INDEX_MAX_AGE_MS
  );
}

/** Shape guard for a shard that round-tripped through Redis or a file. */
export function isChannelShard(v: unknown): v is ChannelShard {
  if (!v || typeof v !== "object") return false;
  const s = v as ChannelShard;
  return (
    s.v === 1 &&
    typeof s.channelId === "string" &&
    typeof s.channelTitle === "string" &&
    typeof s.harvestedAt === "number" &&
    Array.isArray(s.rows) &&
    s.rows.every(
      (r) =>
        Array.isArray(r) &&
        r.length === 3 &&
        typeof r[0] === "string" &&
        typeof r[1] === "string" &&
        typeof r[2] === "string",
    )
  );
}
