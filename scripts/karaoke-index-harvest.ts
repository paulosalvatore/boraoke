/**
 * One-shot karaoke index harvest — CLI wrapper over
 * lib/karaoke-index/harvest.ts.
 *
 * Spends ZERO search.list calls (every URL passes assertNoSearchList) and at
 * most --max-units units of the 10,000/day videos/playlistItems pool.
 *
 * Regenerate the local test fixture from the committed channel list (no seed
 * resolution; ~1,600 units for 71 channels):
 *
 *   YOUTUBE_API_KEY=… npm run index:harvest -- \
 *     --channels lib/karaoke-index/channels.json \
 *     --out work/measurements/ticket-124/index-fixture.json.gz \
 *     --max-units 1600 --max-pages 14
 *
 * Re-derive the channel list from scratch (how channels.json was first built):
 * seeds = every karaoke/playback-named channel in the TICKET-108 production
 * oracle, ranked by how many production result rows it supplied; seed
 * videoIds resolve to channels with videos.list (1 unit per 50).
 *
 *   YOUTUBE_API_KEY=… npm run index:harvest -- \
 *     --seeds-from-oracle work/measurements/ticket-108/production-search-results.json \
 *     --out <file.json.gz> --channels-out lib/karaoke-index/channels.json --max-units 1600
 *
 * The output fixture is YouTube API data: it is gitignored, never committed,
 * and should be deleted or regenerated within 30 days.
 * The key is read from the environment and never printed. This script never
 * writes to Redis: production shards are written only by the guarded refresh
 * route (app/api/cron/karaoke-index/route.ts).
 */

import { readFileSync, writeFileSync } from "fs";
import { gzipSync } from "zlib";

import {
  harvestChannel,
  resolveSeedChannels,
  UnitLedger,
} from "../lib/karaoke-index/harvest";
import type { ChannelShard } from "../lib/karaoke-index/types";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

async function main(): Promise<void> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    console.error("YOUTUBE_API_KEY missing");
    process.exit(2);
  }
  const outPath = arg("out");
  const maxUnits = Number(arg("max-units", "1600"));
  const maxPages = Number(arg("max-pages", "14"));
  const ledger = new UnitLedger(maxUnits);
  const deps = { key, ledger };
  const started = Date.now();

  let channelIds: string[];
  let channelsOut: string | null = null;
  if (process.argv.includes("--channels")) {
    channelIds = JSON.parse(readFileSync(arg("channels"), "utf8")) as string[];
  } else {
    // Seeds derived from the committed production oracle (no seed file kept).
    const oracle = JSON.parse(readFileSync(arg("seeds-from-oracle"), "utf8")) as Record<
      string,
      { videoId: string; channelTitle: string }[]
    >;
    const ranked = new Map<string, { videoId: string; n: number }>();
    for (const rows of Object.values(oracle)) {
      for (const r of rows) {
        if (!/karaok|playback/i.test(r.channelTitle)) continue;
        const c = ranked.get(r.channelTitle) ?? { videoId: r.videoId, n: 0 };
        c.n++;
        ranked.set(r.channelTitle, c);
      }
    }
    const seeds = [...ranked.entries()]
      .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
      .map(([, c]) => c.videoId);
    // resolveSeedChannels preserves seed (rank) order.
    channelIds = [...(await resolveSeedChannels(seeds, deps)).keys()];
    channelsOut = arg("channels-out");
    console.error(`resolved ${channelIds.length} channels from ${seeds.length} seeds (${ledger.used} units)`);
  }

  // 2. Harvest in rank order until the unit budget is spent.
  const shards: ChannelShard[] = [];
  const now = Date.now();
  for (const channelId of channelIds) {
    if (ledger.remaining < 2) break;
    const r = await harvestChannel(channelId, deps, { maxPages, now });
    // Channel ids only in the log (no API titles in anything that gets kept).
    console.error(
      `  ${channelId}: ${r.shard?.rows.length ?? 0} rows in ${r.calls} units` +
        `${r.note ? ` (${r.note})` : ""}  [total ${ledger.used}]`,
    );
    if (r.shard) shards.push(r.shard);
  }

  const rows = shards.reduce((a, s) => a + s.rows.length, 0);
  const payload = { v: 1, harvestedAt: now, shards };
  const gz = gzipSync(Buffer.from(JSON.stringify(payload)));
  writeFileSync(outPath, gz);
  if (channelsOut) {
    writeFileSync(channelsOut, JSON.stringify(shards.map((s) => s.channelId), null, 1) + "\n");
  }
  console.error("\n=== HARVEST DONE ===");
  console.error(`channels: ${shards.length}   rows: ${rows}`);
  console.error(`distinct videoIds: ${new Set(shards.flatMap((s) => s.rows.map((r) => r[0]))).size}`);
  console.error(`UNITS CONSUMED: ${ledger.used} (10k pool)   search.list calls: 0`);
  console.error(`gzipped size: ${gz.length} bytes   elapsed: ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
