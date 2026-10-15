/**
 * One-shot karaoke index harvest — CLI wrapper over
 * lib/karaoke-index/harvest.ts.
 *
 * Spends ZERO search.list calls (every URL passes assertNoSearchList) and at
 * most --max-units units of the 10,000/day videos/playlistItems pool.
 *
 *   YOUTUBE_API_KEY=… npm run index:harvest -- \
 *     --seeds work/measurements/ticket-124/seeds.json \
 *     --out work/measurements/ticket-124/index-fixture.json.gz \
 *     --channels-out lib/karaoke-index/channels.json \
 *     --max-units 1600 --max-pages 14
 *
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
  const seedsPath = arg("seeds");
  const outPath = arg("out");
  const channelsOut = arg("channels-out");
  const maxUnits = Number(arg("max-units", "1600"));
  const maxPages = Number(arg("max-pages", "14"));

  const seedFile = JSON.parse(readFileSync(seedsPath, "utf8")) as {
    seeds: { channelTitle: string; seedVideoId: string }[];
  };
  const ledger = new UnitLedger(maxUnits);
  const deps = { key, ledger };
  const started = Date.now();

  // 1. Seeds -> channel ids, preserving seed rank order.
  const resolved = await resolveSeedChannels(
    seedFile.seeds.map((s) => s.seedVideoId),
    deps,
  );
  // resolveSeedChannels preserves seed (rank) order.
  const channelIds = [...resolved.keys()];
  console.error(`resolved ${channelIds.length} channels from ${seedFile.seeds.length} seeds (${ledger.used} units)`);

  // 2. Harvest in rank order until the unit budget is spent.
  const shards: ChannelShard[] = [];
  const now = Date.now();
  for (const channelId of channelIds) {
    if (ledger.remaining < 2) break;
    const r = await harvestChannel(channelId, deps, { maxPages, now });
    const label = r.shard?.channelTitle ?? resolved.get(channelId) ?? channelId;
    console.error(
      `  ${label}: ${r.shard?.rows.length ?? 0} rows in ${r.calls} units` +
        `${r.note ? ` (${r.note})` : ""}  [total ${ledger.used}]`,
    );
    if (r.shard) shards.push(r.shard);
  }

  const rows = shards.reduce((a, s) => a + s.rows.length, 0);
  const payload = { v: 1, harvestedAt: now, shards };
  const gz = gzipSync(Buffer.from(JSON.stringify(payload)));
  writeFileSync(outPath, gz);
  writeFileSync(
    channelsOut,
    JSON.stringify(
      shards.map((s) => s.channelId),
      null,
      1,
    ) + "\n",
  );
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
