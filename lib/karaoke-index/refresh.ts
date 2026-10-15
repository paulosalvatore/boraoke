/**
 * Karaoke index refresh — what the daily cron does.
 *
 * Each run re-harvests the channels whose shards are OLDEST (never-harvested
 * first), within a unit budget and a wall-clock budget that fit a Vercel Hobby
 * function. See the THROUGHPUT note below for the cadence (~5-day cycle for 71
 * channels). Missed runs fail safe: an expired shard is never served (search
 * goes live for it), and Redis TTLs delete shards if the cron stops for good.
 *
 * Spends ZERO search.list calls: all traffic goes through harvest.ts, which
 * refuses any search URL before it is fetched.
 */

import { harvestChannel, UnitLedger } from "./harvest";
import type { ChannelShard } from "./types";

/**
 * THROUGHPUT, from measurement. The one-off harvest made 1,599 calls in 868 s
 * from a residential connection: 0.54 s per call, ~15 s per full channel
 * (28 calls). Sequentially, a 40 s run refreshed only 2-3 channels — a 24-27
 * day cycle for 71 channels, flush against the 30-day expiry. So a run
 * harvests REFRESH_CONCURRENCY channels at once:
 *   - no new channel starts after REFRESH_START_CUTOFF_MS (34 s): a full
 *     channel started then (~15 s) still finishes before
 *   - REFRESH_HARD_DEADLINE_MS (50 s), after which no new PAGE starts — inside
 *     the 60 s Hobby function limit (a channel cut by it is not written);
 *   - each channel's full unit budget is reserved before it starts, so the unit
 *     cap never cuts a channel short.
 * Simulated with the real constants and clock against a fake API at the
 * measured latency (work/measurements/ticket-124/REFRESH-SIM.txt):
 *   0.54 s/call -> 18 channels/run, 504 units, 45.8 s -> 71 channels in 4 runs
 *   0.80 s/call -> 12 channels/run                    -> 6 runs
 *   0.30 s/call -> 21 channels/run (unit cap binds)   -> 4 runs
 * The cron is daily (Vercel Hobby allows at most one run per day per job), so a
 * full cycle and the first fill take ~4-6 days, far inside the 30-day limit.
 * Latency from a Vercel function itself is not measured yet (UNVERIFIED);
 * datacenter egress is unlikely to be slower than the residential figure.
 * Units: <= 28 per channel, capped at REFRESH_MAX_UNITS (6% of the 10k pool).
 */
export const REFRESH_CONCURRENCY = 6;
export const REFRESH_START_CUTOFF_MS = 34_000;
export const REFRESH_HARD_DEADLINE_MS = 50_000;
/** Units one run may spend (10k/day pool; a full channel is <= 28 units). */
export const REFRESH_MAX_UNITS = 600;
/** Pages (50 videos each) harvested per channel — newest uploads first. */
export const REFRESH_MAX_PAGES = 14;

/** Oldest-first (missing = 0 = oldest), ties by configured channel rank. */
export function pickChannelsToRefresh(
  channels: readonly string[],
  stamps: ReadonlyMap<string, number>,
): string[] {
  return channels
    .map((id, rank) => ({ id, rank, at: stamps.get(id) ?? 0 }))
    .sort((a, b) => a.at - b.at || a.rank - b.rank)
    .map((c) => c.id);
}

export interface RefreshDeps {
  key: string;
  channels: readonly string[];
  stamps: ReadonlyMap<string, number>;
  write: (shard: ChannelShard) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxUnits?: number;
  concurrency?: number;
  startCutoffMs?: number;
  hardDeadlineMs?: number;
  /** Pages per channel (tests); defaults to REFRESH_MAX_PAGES. */
  maxPages?: number;
}

export interface RefreshReport {
  refreshed: { channelId: string; rows: number; units: number }[];
  skipped: { channelId: string; note: string }[];
  unitsUsed: number;
  elapsedMs: number;
  searchListCalls: 0;
}

export async function runRefresh(deps: RefreshDeps): Promise<RefreshReport> {
  const now = deps.now ?? Date.now;
  const started = now();
  const startCutoff = started + (deps.startCutoffMs ?? REFRESH_START_CUTOFF_MS);
  const hardDeadline = started + (deps.hardDeadlineMs ?? REFRESH_HARD_DEADLINE_MS);
  const ledger = new UnitLedger(deps.maxUnits ?? REFRESH_MAX_UNITS);
  const report: RefreshReport = { refreshed: [], skipped: [], unitsUsed: 0, elapsedMs: 0, searchListCalls: 0 };
  const queue = pickChannelsToRefresh(deps.channels, deps.stamps);
  const maxPages = deps.maxPages ?? REFRESH_MAX_PAGES;
  // A channel's WHOLE budget (2 units per page) is reserved before it starts,
  // so the unit cap can never cut a channel short and waste its units: a
  // channel either has its full budget or does not start. Unused units are
  // refunded when it finishes.
  const perChannel = 2 * maxPages;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (now() >= startCutoff || queue.length === 0) return;
      if (!ledger.tryReserve(perChannel)) return;
      const channelId = queue.shift() as string;
      const own = new UnitLedger(perChannel);
      try {
        const r = await harvestChannel(
          channelId,
          { key: deps.key, ledger: own, fetchImpl: deps.fetchImpl },
          { maxPages, now: now(), deadline: hardDeadline },
        );
        // Only a COMPLETE harvest is written. A channel cut short (unit or time
        // budget, or an HTTP error mid-channel) would replace a complete stored
        // shard with a shorter one; the existing shard stays until a later run
        // finishes this channel.
        if (r.shard && r.complete) {
          await deps.write(r.shard);
          report.refreshed.push({ channelId, rows: r.shard.rows.length, units: r.calls });
        } else {
          report.skipped.push({ channelId, note: r.note ?? "no shard" });
        }
      } catch (e) {
        report.skipped.push({ channelId, note: e instanceof Error ? e.name : "error" });
      } finally {
        ledger.refund(perChannel - own.used);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, deps.concurrency ?? REFRESH_CONCURRENCY) }, worker));
  report.unitsUsed = ledger.used;
  report.elapsedMs = now() - started;
  return report;
}
