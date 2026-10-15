/**
 * Refresh-throughput simulation — one real cron run (real clock, the shipped
 * REFRESH_* constants) against a fake Data API that answers every call after
 * the MEASURED per-call latency of the one-off harvest (1,599 calls / 868 s =
 * 0.543 s). Every channel is a full 14-page channel (28 calls), the worst case.
 * Zero network, zero quota.
 *
 * Run: npx ts-node --transpile-only --compilerOptions '{"module":"commonjs","moduleResolution":"node","target":"es2020","esModuleInterop":true}' \
 *        work/measurements/ticket-124/refresh-sim.ts [latencyMs]
 *
 * The real latency from a Vercel function (likely lower: datacenter egress)
 * is not measured here; see the PR for that caveat.
 */

import channelIds from "../../../lib/karaoke-index/channels.json";
import {
  REFRESH_CONCURRENCY,
  REFRESH_HARD_DEADLINE_MS,
  REFRESH_MAX_UNITS,
  REFRESH_START_CUTOFF_MS,
  runRefresh,
} from "../../../lib/karaoke-index/refresh";

const LATENCY_MS = Number(process.argv[2] ?? 543);
const PAGES = 14;

const fakeApi = (async (input: RequestInfo | URL) => {
  await new Promise((r) => setTimeout(r, LATENCY_MS));
  const url = new URL(String(input));
  if (url.pathname.endsWith("/playlistItems")) {
    const page = Number(url.searchParams.get("pageToken") ?? "1");
    const pl = url.searchParams.get("playlistId");
    return new Response(
      JSON.stringify({
        nextPageToken: page < PAGES ? String(page + 1) : undefined,
        items: Array.from({ length: 50 }, (_, i) => ({
          snippet: { title: `t${i}`, channelTitle: "c" },
          contentDetails: { videoId: `${pl}-${page}-${i}` },
        })),
      }),
    );
  }
  const ids = (url.searchParams.get("id") ?? "").split(",");
  return new Response(
    JSON.stringify({ items: ids.map((id) => ({ id, contentDetails: { duration: "PT3M" }, status: { embeddable: true } })) }),
  );
}) as typeof fetch;

async function main(): Promise<void> {
  const channels = channelIds as string[];
  const r = await runRefresh({ key: "sim", channels, stamps: new Map(), write: async () => undefined, fetchImpl: fakeApi });
  const perRun = r.refreshed.length;
  console.log(
    `latency ${LATENCY_MS} ms/call, concurrency ${REFRESH_CONCURRENCY}, start cutoff ${REFRESH_START_CUTOFF_MS / 1000}s, ` +
      `hard deadline ${REFRESH_HARD_DEADLINE_MS / 1000}s, unit cap ${REFRESH_MAX_UNITS}`,
  );
  console.log(
    `one run: ${perRun} complete channels written, ${r.skipped.length} cut short (not written), ` +
      `${r.unitsUsed} units, ${(r.elapsedMs / 1000).toFixed(1)} s elapsed`,
  );
  console.log(
    `=> full cycle of ${channels.length} channels: ${Math.ceil(channels.length / perRun)} daily runs ` +
      `(first fill the same); retention limit 30 days`,
  );
}

void main();
