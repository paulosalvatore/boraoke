/**
 * Weekly telemetry rollup CLI (TICKET-12).
 *
 *   npm run telemetry:rollup -- --week 2026-W27            # read Upstash (env creds)
 *   npm run telemetry:rollup -- --week 2026-W27 --demo-seed # offline synthetic week
 *   npm run telemetry:rollup                                # current ISO week
 *
 * Writes `work/telemetry/rollups/<YYYY-Www>.md` — the human-readable per-room
 * retention/engagement/host-usage/friction tables (no BI stack; the TL/PO read
 * trendlines from the repo). Run manually or by the house on cadence.
 *
 * This script deliberately imports ONLY the pure telemetry modules (no
 * `server-only`); the Upstash read path builds its own client here. Reads are
 * whole-day-range — no cursor/watermark (in-list order ≠ commit order under
 * concurrent writes; see lib/telemetry-store.ts).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  computeRollup,
  isoWeekOf,
  isoWeekRange,
  renderRollupMarkdown,
} from "../lib/telemetry-rollup";
import {
  dayRange,
  telemetryKeys,
  type TelemetryEvent,
  type TelemetryEventName,
} from "../lib/telemetry-types";

// ── args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  let week: string | undefined;
  let demoSeed = false;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--week") week = argv[++i];
    else if (argv[i] === "--demo-seed") demoSeed = true;
    else if (argv[i] === "--out") out = argv[++i];
  }
  return { week: week ?? isoWeekOf(new Date()), demoSeed, out };
}

// ── demo seed (deterministic synthetic week — evidence + offline dev) ────────

/** Deterministic LCG so the committed sample rollup is reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function demoUuid(rng: () => number): string {
  const hex = () => Math.floor(rng() * 16).toString(16);
  const s = (n: number) => Array.from({ length: n }, hex).join("");
  return `${s(8)}-${s(4)}-4${s(3)}-a${s(3)}-${s(12)}`;
}

function seedDemoWeek(week: string): TelemetryEvent[] {
  const { fromDay } = isoWeekRange(week);
  const rng = makeRng(0xca47a1);
  const events: TelemetryEvent[] = [];
  const appVersion = "demo-seed";
  const push = (
    event: TelemetryEventName,
    roomId: string,
    ts: number,
    uuid?: string,
    props?: Record<string, string | number | boolean>,
  ) =>
    events.push({
      event,
      roomId,
      ts: new Date(ts).toISOString(),
      appVersion,
      ...(uuid ? { uuid } : {}),
      ...(props ? { props } : {}),
    });

  const base = new Date(`${fromDay}T00:00:00.000Z`).getTime();
  const HOUR = 3600_000;

  // Three venue profiles: a retained regular, a two-night venue, a one-shot trial.
  const profiles: Array<{ roomId: string; nights: number[]; patrons: number }> =
    [
      { roomId: "bar-do-ze", nights: [0, 2, 4, 5, 6], patrons: 9 },
      { roomId: "vila-sessions", nights: [4, 5], patrons: 5 },
      { roomId: "trial-venue", nights: [2], patrons: 2 },
    ];

  for (const p of profiles) {
    push("room_created", p.roomId, base + p.nights[0] * 24 * HOUR + 18 * HOUR);
    const uuids = Array.from({ length: p.patrons }, () => demoUuid(rng));
    for (const night of p.nights) {
      const start = base + night * 24 * HOUR + 20 * HOUR; // 20:00 UTC
      let t = start;
      const active = uuids.filter(() => rng() > 0.25);
      for (const u of active) push("patron_joined", p.roomId, (t += 60_000), u);
      const rounds = 2 + Math.floor(rng() * 3);
      for (let round = 0; round < rounds; round += 1) {
        for (const u of active) {
          t += Math.floor(rng() * 8 * 60_000) + 60_000;
          const searches = 1 + Math.floor(rng() * 2);
          for (let sIdx = 0; sIdx < searches; sIdx += 1) {
            push("search_performed", p.roomId, t, u, {
              results: 5 + Math.floor(rng() * 5),
            });
            t += 20_000;
          }
          if (rng() < 0.85) {
            push("song_queued", p.roomId, t, u, {
              kind: rng() < 0.8 ? "search" : "paste",
              mode: rng() < 0.7 ? "sing" : "listen-dance",
            });
          }
          if (rng() < 0.04) {
            push("submit_rejected", p.roomId, (t += 5_000), u, {
              reason: "cap",
            });
          }
        }
        // playback + host behavior through the round
        for (let k = 0; k < active.length; k += 1) {
          t += Math.floor(rng() * 4 * 60_000) + 120_000;
          push("song_played", p.roomId, t);
          const r = rng();
          if (r < 0.12) {
            push("host_action", p.roomId, (t += 10_000), undefined, {
              action: "skip",
            });
            push("song_skipped", p.roomId, t, undefined, {
              reason: rng() < 0.5 ? "host" : "noshow",
            });
          } else if (r < 0.18) {
            push("host_action", p.roomId, (t += 10_000), undefined, {
              action: rng() < 0.5 ? "reorder" : "remove",
            });
          } else if (r < 0.2) {
            push("host_action", p.roomId, (t += 10_000), undefined, {
              action: "pause",
            });
            push("host_action", p.roomId, (t += 5 * 60_000), undefined, {
              action: "resume",
            });
          }
        }
      }
    }
  }
  return events;
}

// ── Upstash read path (direct; pure modules only) ────────────────────────────

async function readWeekFromUpstash(week: string): Promise<TelemetryEvent[]> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set. " +
        "For an offline sample use --demo-seed.",
    );
  }
  // Lazy import so --demo-seed works without the dependency resolving network creds.
  const { Redis } = await import("@upstash/redis");
  const redis = new Redis({ url, token });
  const { fromDay, toDay } = isoWeekRange(week);
  const events: TelemetryEvent[] = [];
  for (const day of dayRange(fromDay, toDay)) {
    const chunk = await redis.lrange<TelemetryEvent>(
      telemetryKeys.day(day),
      0,
      -1,
    );
    events.push(...chunk);
  }
  return events;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { week, demoSeed, out } = parseArgs(process.argv.slice(2));
  const events = demoSeed ? seedDemoWeek(week) : await readWeekFromUpstash(week);
  const rollup = computeRollup(events, week);
  let md = renderRollupMarkdown(rollup);
  if (demoSeed) {
    md += `\n> Generated from \`--demo-seed\` synthetic data (deterministic), not live traffic.\n`;
  }
  const outPath =
    out ?? join(__dirname, "..", "work", "telemetry", "rollups", `${week}.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md, "utf8");
  console.log(
    `Rollup for ${week}: ${rollup.totalEvents} events, ${rollup.rooms.length} room(s) → ${outPath}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
