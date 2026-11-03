/**
 * Pure computation behind `scripts/telemetry-repeat-report.ts`.
 *
 * Input is raw telemetry events; output is the daily cache / index / live
 * split plus how often a hash comes back within 12 h, 7 d and 30 d.
 *
 * Window rule: an event is a REPEAT for window W when the same hash occurred
 * earlier (strictly before it in time) and the gap to the most recent such
 * occurrence is at most W. Rate = repeats / events that carry a hash. Events
 * without a hash (emitted before the salt was set) are counted separately and
 * stay out of the denominator, so they never dilute the rate.
 */

import type { TelemetryEvent } from "./telemetry-types";

export const REPEAT_WINDOWS = [
  { label: "12h", ms: 12 * 3600_000 },
  { label: "7d", ms: 7 * 24 * 3600_000 },
  { label: "30d", ms: 30 * 24 * 3600_000 },
] as const;

export interface RepeatRate {
  label: string;
  repeats: number;
  total: number;
  /** repeats / total, or null when there are no hashed events. */
  rate: number | null;
}

export interface DailySplit {
  day: string;
  cache: number;
  index: number;
  live: number;
}

export interface RepeatReport {
  daily: DailySplit[];
  billedKeys: { hashed: number; unhashed: number; rates: RepeatRate[] };
  queuedSongs: { hashed: number; unhashed: number; rates: RepeatRate[] };
}

/** Repeat counts per window over a time-ordered series of `[ms, hash]`. */
export function repeatRates(series: Array<[number, string]>): RepeatRate[] {
  const sorted = [...series].sort((a, b) => a[0] - b[0]);
  const counts = REPEAT_WINDOWS.map(() => 0);
  const last = new Map<string, number>();
  for (const [t, h] of sorted) {
    const prev = last.get(h);
    if (prev !== undefined && prev < t) {
      const gap = t - prev;
      REPEAT_WINDOWS.forEach((w, i) => {
        if (gap <= w.ms) counts[i] += 1;
      });
    }
    // Equal timestamps keep the earlier one as "most recent", which is fine:
    // a same-millisecond pair is not a cross-time repeat.
    if (prev === undefined || t > prev) last.set(h, t);
  }
  return REPEAT_WINDOWS.map((w, i) => ({
    label: w.label,
    repeats: counts[i],
    total: sorted.length,
    rate: sorted.length ? counts[i] / sorted.length : null,
  }));
}

export function computeRepeatReport(events: TelemetryEvent[]): RepeatReport {
  const days = new Map<string, DailySplit>();
  const keys: Array<[number, string]> = [];
  const songs: Array<[number, string]> = [];
  let keysUnhashed = 0;
  let songsUnhashed = 0;

  for (const e of events) {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    const props = e.props ?? {};
    if (e.event === "search_performed") {
      const source = props.source;
      if (source !== "cache" && source !== "index" && source !== "live") continue;
      const day = e.ts.slice(0, 10);
      const row = days.get(day) ?? { day, cache: 0, index: 0, live: 0 };
      row[source] += 1;
      days.set(day, row);
      if (source === "live") {
        if (typeof props.keyHash === "string" && props.keyHash) keys.push([t, props.keyHash]);
        else keysUnhashed += 1;
      }
    } else if (e.event === "song_queued") {
      if (typeof props.videoHash === "string" && props.videoHash) songs.push([t, props.videoHash]);
      else songsUnhashed += 1;
    }
  }

  return {
    daily: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    billedKeys: { hashed: keys.length, unhashed: keysUnhashed, rates: repeatRates(keys) },
    queuedSongs: { hashed: songs.length, unhashed: songsUnhashed, rates: repeatRates(songs) },
  };
}

const pct = (r: RepeatRate) =>
  r.rate === null ? "n/a" : `${(r.rate * 100).toFixed(1)}% (${r.repeats}/${r.total})`;

export function renderRepeatReport(r: RepeatReport): string {
  const out: string[] = [];
  out.push("Daily search split (UTC)", "day         cache  index  live");
  for (const d of r.daily) {
    out.push(`${d.day}  ${String(d.cache).padStart(5)}  ${String(d.index).padStart(5)}  ${String(d.live).padStart(4)}`);
  }
  if (!r.daily.length) out.push("(no search_performed events in range)");
  const block = (title: string, b: RepeatReport["billedKeys"], noun: string) => {
    out.push("", `${title}: ${b.hashed} ${noun} with a hash, ${b.unhashed} without (excluded)`);
    for (const x of b.rates) out.push(`  repeat within ${x.label.padEnd(3)} ${pct(x)}`);
  };
  block("Billed (live) key hashes", r.billedKeys, "events");
  block("Queued song hashes", r.queuedSongs, "events");
  return out.join("\n") + "\n";
}
