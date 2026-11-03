/**
 * Read-only cross-day repeat report.
 *
 *   npm run telemetry:repeats                       # last 35 days, Upstash (env creds)
 *   npm run telemetry:repeats -- --days 60
 *
 * Prints the daily cache / index / live split, and how often a billed key hash
 * or a queued song hash repeats within 12 h, 7 d and 30 d. Reads the same
 * day-bucketed lists as scripts/telemetry-rollup.ts and writes nothing.
 * Events carry hashes only once TELEMETRY_HASH_SALT is set on the app, so the
 * windows fill up from that day onwards.
 */

import { computeRepeatReport, renderRepeatReport } from "../lib/repeat-report";
import { dayRange, dayOf, telemetryKeys, type TelemetryEvent } from "../lib/telemetry-types";

function parseDays(argv: string[]): number {
  const i = argv.indexOf("--days");
  const n = i >= 0 ? Number(argv[i + 1]) : 35;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 90) : 35;
}

async function main() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set.");
  }
  const { Redis } = await import("@upstash/redis");
  const redis = new Redis({ url, token });
  const days = parseDays(process.argv.slice(2));
  const to = dayOf(new Date());
  const from = dayOf(Date.now() - (days - 1) * 24 * 3600_000);
  const events: TelemetryEvent[] = [];
  for (const day of dayRange(from, to)) {
    events.push(...(await redis.lrange<TelemetryEvent>(telemetryKeys.day(day), 0, -1)));
  }
  console.log(`Range ${from} .. ${to} (${events.length} events)\n`);
  console.log(renderRepeatReport(computeRepeatReport(events)));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
