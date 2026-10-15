/**
 * Karaoke index refresh — what the daily cron does.
 *
 * Each run re-harvests the channels whose shards are OLDEST (never-harvested
 * first), within a unit budget and a wall-clock budget that fit a Vercel Hobby
 * function. With ~60 channels and ~10 refreshed per run, every channel is
 * re-harvested about weekly — well inside the 30-day retention limit, so a
 * week of failed crons still never serves expired data (and if the cron stops
 * for good, Redis TTLs delete the shards and search falls back to live).
 *
 * Spends ZERO search.list calls: all traffic goes through harvest.ts, which
 * refuses any search URL before it is fetched.
 */

import { harvestChannel, UnitBudgetExhausted, UnitLedger } from "./harvest";
import type { ChannelShard } from "./types";

/** Units one run may spend (10k/day pool; a full channel is <= 28 units). */
export const REFRESH_MAX_UNITS = 400;
/** Stop starting new channels after this many ms (Hobby functions cap at 60 s). */
export const REFRESH_TIME_BUDGET_MS = 40_000;
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
  timeBudgetMs?: number;
}

export interface RefreshReport {
  refreshed: { channelId: string; rows: number; units: number }[];
  skipped: { channelId: string; note: string }[];
  unitsUsed: number;
  searchListCalls: 0;
}

export async function runRefresh(deps: RefreshDeps): Promise<RefreshReport> {
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = started + (deps.timeBudgetMs ?? REFRESH_TIME_BUDGET_MS);
  const ledger = new UnitLedger(deps.maxUnits ?? REFRESH_MAX_UNITS);
  const report: RefreshReport = { refreshed: [], skipped: [], unitsUsed: 0, searchListCalls: 0 };

  for (const channelId of pickChannelsToRefresh(deps.channels, deps.stamps)) {
    if (now() >= deadline || ledger.remaining < 2) break;
    try {
      const r = await harvestChannel(
        channelId,
        { key: deps.key, ledger, fetchImpl: deps.fetchImpl },
        { maxPages: REFRESH_MAX_PAGES, now: now(), deadline },
      );
      // A channel cut short by the unit/time budget is NOT written: a partial
      // shard would replace a complete one. The existing shard stays until a
      // later run finishes this channel.
      if (r.shard && !/budget reached/.test(r.note ?? "")) {
        await deps.write(r.shard);
        report.refreshed.push({ channelId, rows: r.shard.rows.length, units: r.calls });
      } else {
        report.skipped.push({ channelId, note: r.note ?? "no shard" });
      }
    } catch (e) {
      if (e instanceof UnitBudgetExhausted) break;
      report.skipped.push({ channelId, note: e instanceof Error ? e.name : "error" });
    }
  }
  report.unitsUsed = ledger.used;
  return report;
}
