/**
 * TICKET-125 measurement harness — the TICKET-124 replay with a TIMING model:
 * a billed live search now runs only on Enter or after IDLE_SEARCH_MS of no
 * typing (once per text), while free lookups (karaoke index) still run on
 * every debounced pause.
 *
 * Same inputs as TICKET-108/124, unchanged: the production oracle (80 real
 * production cache keys -> the real YouTube pages production served), the same
 * keystroke-family traces reconstructed from them, the 28 gradable production
 * queries and the same hit predicate, plus TICKET-124's index fixture and the
 * shipped tier (decideTier at GOOD_MATCH_THRESHOLD).
 *
 * TIMING — what the traces do and do not say.
 *   The traces carry NO timestamps. Each element is a string production
 *   actually billed, i.e. the patron paused >= 400 ms (the client debounce)
 *   at that prefix. The last element of a family is where the patron settled.
 *   So the model is:
 *     - final element:          the patron settles -> Enter or the idle timer
 *                               fires -> a live-allowed request (bills only if
 *                               the free tiers miss). Probability 1.
 *     - intermediate element:   a mid-title pause. Free lookup always runs; a
 *                               billed live search runs only if the pause
 *                               also lasts >= N s, with probability
 *                               S(N) = P(pause >= N | pause >= 0.4 s).
 *                               Enter is assumed NOT pressed mid-title.
 *   S(N) comes from a STATED pause model (log-normal, median 1.0 s, sigma 1.0;
 *   an assumption, not a measurement), and the result is also printed as a
 *   sweep over S so any other assumption can be read off directly.
 *   S = 1 is "every pause bills" — exactly TICKET-124's client — and is the
 *   harness's identity control: it must reproduce PR #88's 26 billed calls.
 *
 * QUALITY is graded on what the patron sees when they SETTLE on the graded
 * query (Enter / idle): local narrowing of the held page if it answers, else
 * the index if confident, else the live page. That is the same answer
 * TICKET-124 displayed at that prefix, given the same history; only the
 * history (which mid-title pauses billed and became the held page) differs.
 *
 * Zero search.list calls are spent by this harness.
 *
 * Run:  npm run measure:t125            (add --controls for the falsifiability pass)
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { gunzipSync } from "zlib";

import type { SearchResult } from "../../../lib/youtube-search";
import { PRODUCTION_QUERIES, type GradedQuery } from "../ticket-108/queries";
import { isExtensionOf, MIN_LOCAL_MATCHES, normalizeQuery, planSearch } from "../../../lib/search-prefix";
import { KaraokeIndex } from "../../../lib/karaoke-index/matcher";
import { decideTier } from "../../../lib/karaoke-index/tier";
import type { ChannelShard } from "../../../lib/karaoke-index/types";
import { IDLE_SEARCH_MS } from "../../../lib/search-trigger";

type Row = SearchResult;
const CLIENT_MIN_CHARS = 4; // components/SongSearch.tsx MIN_CHARS (unchanged)
const RUNS = 4000;
const MEASURED = { baselinePerSong: 3.75 }; // production day: 90 billed / 24 queued
// PR #88 after its fix batch (work/measurements/ticket-124/RESULTS.txt, title-only predicate).
const PR88 = { billed: 26, perSong: 1.22, h10: 25 };

/**
 * The TICKET-108 production oracle. It is YouTube API data, so it is gitignored
 * and local only (removed from the repo 2026-10-15). Refuse to report numbers
 * without it, exactly like work/measurements/ticket-124/replay.ts.
 */
const ORACLE_PATH = join(__dirname, "../ticket-108/production-search-results.json");
if (!existsSync(ORACLE_PATH)) {
  console.error(
    `FATAL: ${ORACLE_PATH} (the TICKET-108 production oracle) is missing.\n` +
      "It is YouTube API data, so it is gitignored and local only (removed from the repo 2026-10-15).\n" +
      "Regenerate it by dumping the production search cache (sc:* keys) read-only with the KV read-only\n" +
      "token, as described in work/reports/dev/TICKET-108-dev-report.md. A fresh dump holds today's pages,\n" +
      "not the 2026-09-27 ones, so the measured numbers will move. Refusing to report numbers without it.",
  );
  process.exit(2);
}

const ORACLE: Record<string, Row[]> = Object.fromEntries(
  Object.entries(
    JSON.parse(
      readFileSync(ORACLE_PATH, "utf8"),
    ) as Record<string, { videoId: string; title: string; channelTitle: string }[]>,
  ).map(([k, rows]) => [k, rows.map((r) => ({ ...r, duration: "", thumbnailUrl: "" }))]),
);
/**
 * TICKET-124's harvested index fixture. It is YouTube API data, so it is
 * gitignored and local only (see work/measurements/ticket-124/replay.ts for
 * the regeneration command). Refuse to report numbers without it.
 */
const FIXTURE_PATH = join(__dirname, "../ticket-124/index-fixture.json.gz");
if (!existsSync(FIXTURE_PATH)) {
  console.error(`FATAL: ${FIXTURE_PATH} is missing (gitignored YouTube API data; regenerate it as described in work/measurements/ticket-124/replay.ts).`);
  process.exit(2);
}
const FIXTURE = JSON.parse(gunzipSync(readFileSync(FIXTURE_PATH)).toString("utf8")) as {
  harvestedAt: number;
  shards: ChannelShard[];
};

// ── raw-input space (identical to TICKET-108/124) ─────────────────────────────

function rawOf(cacheKey: string): string {
  return cacheKey.replace(/\s+karaoke$/i, "").trim() || cacheKey;
}
const RAW_TO_KEY = new Map<string, string>();
for (const key of Object.keys(ORACLE)) {
  const raw = rawOf(key);
  const existing = RAW_TO_KEY.get(raw);
  if (!existing || key.length > existing.length) RAW_TO_KEY.set(raw, key);
}
function pageFor(raw: string): Row[] {
  const key = RAW_TO_KEY.get(raw);
  return key === undefined ? [] : ORACLE[key];
}
function rawForGraded(q: string): string | null {
  for (const cand of [rawOf(q), q]) if (RAW_TO_KEY.has(cand)) return cand;
  const targets = [normalizeQuery(rawOf(q)), normalizeQuery(q)];
  for (const raw of RAW_TO_KEY.keys()) if (targets.includes(normalizeQuery(raw))) return raw;
  return null;
}
function reconstructTraces(raws: string[]): string[][] {
  const sorted = [...raws].sort((a, b) => normalizeQuery(a).length - normalizeQuery(b).length);
  const traces: string[][] = [];
  const placed = new Set<string>();
  for (const q of sorted) {
    if (placed.has(q)) continue;
    const trace = [q];
    placed.add(q);
    let tail = q;
    for (const cand of sorted) {
      if (placed.has(cand)) continue;
      if (isExtensionOf(cand, tail) || normalizeQuery(cand) === normalizeQuery(tail)) {
        trace.push(cand);
        placed.add(cand);
        tail = cand;
      }
    }
    traces.push(trace);
  }
  return traces;
}

// ── grading (identical predicate to TICKET-124 after its fix batch) ──────────
// TITLE ONLY, so a row cannot "hit" through its channel name. `--legacy-predicate`
// restores the spike/TICKET-108 title+channel predicate for comparison.
const LEGACY_PREDICATE = process.argv.includes("--legacy-predicate");

function hit(rows: readonly Row[], want: string[], n: number): boolean {
  return rows.slice(0, n).some((r) => {
    const t = normalizeQuery(LEGACY_PREDICATE ? `${r.title} ${r.channelTitle ?? ""}` : r.title);
    return want.every((w) => t.includes(w));
  });
}
interface Quality { n: number; h1: number; h10: number; misses: string[] }
function grade(graded: GradedQuery[], rowsFor: (raw: string) => Row[]): Quality {
  const out: Quality = { n: 0, h1: 0, h10: 0, misses: [] };
  for (const c of graded) {
    const raw = rawForGraded(c.q);
    if (raw === null) continue;
    const rows = rowsFor(raw);
    out.n++;
    out.h1 += hit(rows, c.want, 1) ? 1 : 0;
    const d = hit(rows, c.want, 10);
    out.h10 += d ? 1 : 0;
    if (!d) out.misses.push(c.q);
  }
  return out;
}

// ── the pause model (an ASSUMPTION, stated) ───────────────────────────────────

/** Abramowitz-Stegun 7.1.26 erf; plenty for a survival function. */
function erf(x: number): number {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
const PAUSE_MODEL = { medianS: 1.0, sigma: 1.0, debounceS: 0.4 };
function lognormSurvival(x: number): number {
  const z = (Math.log(x) - Math.log(PAUSE_MODEL.medianS)) / PAUSE_MODEL.sigma;
  return 0.5 * (1 - erf(z / Math.SQRT2));
}
/** S(N) = P(pause >= N s | pause >= the 400 ms debounce). */
function S(nSeconds: number): number {
  return lognormSurvival(nSeconds) / lognormSurvival(PAUSE_MODEL.debounceS);
}

// ── the replay ────────────────────────────────────────────────────────────────

/** mulberry32: a small seeded PRNG, so every number here is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** decideTier is pure per (index, query): memoised so 4000 runs stay fast. */
const tierMemo = new WeakMap<KaraokeIndex, Map<string, ReturnType<typeof decideTier>>>();
function tierFor(index: KaraokeIndex, raw: string): ReturnType<typeof decideTier> {
  let m = tierMemo.get(index);
  if (!m) tierMemo.set(index, (m = new Map()));
  let d = m.get(raw);
  if (!d) {
    d = decideTier({ q: RAW_TO_KEY.get(raw) as string, pageToken: "", index });
    m.set(raw, d);
  }
  return d;
}

interface Run { billed: number; indexServed: number; settled: Map<string, Row[]>; shown: Map<string, Row[]> }

/**
 * One realization. `pIdle` = S(N): chance a mid-title free-tier miss is
 * followed by a pause long enough for the idle search. `finalSettles` = the
 * patron's last prefix always ends in Enter/idle (the model; false only in a
 * control).
 */
function replayOnce(traces: string[][], index: KaraokeIndex, pIdle: number, rand: () => number, finalSettles = true): Run {
  let billed = 0;
  let indexServed = 0;
  const settled = new Map<string, Row[]>();
  const shown = new Map<string, Row[]>();
  for (const trace of traces) {
    let heldQuery = "";
    let heldRows: Row[] = [];
    trace.forEach((raw, i) => {
      if (normalizeQuery(raw).length < CLIENT_MIN_CHARS) return;
      const isFinal = i === trace.length - 1;
      const plan = planSearch({ next: raw, heldQuery, heldRows, minLocalMatches: MIN_LOCAL_MATCHES });
      if (plan.action === "filter") {
        settled.set(raw, plan.rows);
        shown.set(raw, plan.rows);
        return;
      }
      // Free, as-you-type: the index-only lookup.
      const d = tierFor(index, raw);
      if (d.tier === "index") {
        indexServed++;
        heldQuery = raw;
        heldRows = d.results;
        settled.set(raw, d.results);
        shown.set(raw, d.results);
        return;
      }
      // The free tiers missed. If the patron settled here (Enter / idle) they
      // would get the live page — that is what quality is graded on.
      const live = pageFor(raw);
      settled.set(raw, live);
      const fires = isFinal ? finalSettles || rand() < pIdle : rand() < pIdle;
      if (fires) {
        billed++;
        heldQuery = raw;
        heldRows = live;
        shown.set(raw, live);
      } else {
        shown.set(raw, []); // only the "press Enter" hint is on screen
      }
    });
  }
  return { billed, indexServed, settled, shown };
}

interface Summary { pIdle: number; meanBilled: number; p5: number; p95: number; meanH10: number; minH10: number; n: number }
function simulate(traces: string[][], index: KaraokeIndex, pIdle: number, seed = 125): Summary {
  const rand = rng(seed);
  const billed: number[] = [];
  const h10s: number[] = [];
  let n = 0;
  for (let r = 0; r < RUNS; r++) {
    const run = replayOnce(traces, index, pIdle, rand);
    billed.push(run.billed);
    const q = grade(PRODUCTION_QUERIES, (raw) => run.settled.get(raw) ?? []);
    h10s.push(q.h10);
    n = q.n;
  }
  billed.sort((a, b) => a - b);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    pIdle,
    meanBilled: mean(billed),
    p5: billed[Math.floor(RUNS * 0.05)],
    p95: billed[Math.floor(RUNS * 0.95)],
    meanH10: mean(h10s),
    minH10: Math.min(...h10s),
    n,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const withControls = process.argv.includes("--controls");
  const index = new KaraokeIndex(FIXTURE.shards);
  const traces = reconstructTraces([...RAW_TO_KEY.keys()]);
  const perKey = Object.keys(ORACLE).length;
  const perSong = (billed: number) => (MEASURED.baselinePerSong * billed) / perKey;
  const pct = (x: number, n: number) => `${((x / n) * 100).toFixed(0)}%`;

  // Where can the policy save at all? Count the intermediate free-tier misses.
  let mids = 0;
  let midMisses = 0;
  let finals = 0;
  {
    const r = replayOnce(traces, index, 1, () => 0);
    for (const trace of traces) {
      trace.forEach((raw, i) => {
        if (normalizeQuery(raw).length < CLIENT_MIN_CHARS) return;
        if (i === trace.length - 1) finals++;
        else mids++;
      });
    }
    midMisses = r.billed; // with pIdle=1 every free-tier miss bills
  }

  const line = "─".repeat(110);
  console.log("=".repeat(110));
  console.log("TICKET-125 — Enter / idle live search: billed calls AND quality, replayed over real production traces");
  console.log("=".repeat(110));
  console.log(`predicate: ${LEGACY_PREDICATE ? "LEGACY title+channel" : "title only (TICKET-124 fix batch)"}`);
  console.log(`index fixture: ${FIXTURE.shards.length} channels, ${index.size} videos, harvested ${new Date(FIXTURE.harvestedAt).toISOString()}; oracle: ${perKey} production cache keys; traces: ${traces.length} families`);
  console.log(`client: MIN_CHARS=${CLIENT_MIN_CHARS}, MIN_LOCAL_MATCHES=${MIN_LOCAL_MATCHES}, shipped decideTier; Monte Carlo ${RUNS} runs per point, seed 125`);
  console.log(`trace elements >= MIN_CHARS: ${mids} mid-title pauses + ${finals} settle points; billed when EVERY pause may bill (TICKET-124 client): ${midMisses}`);
  console.log(
    `pause model (ASSUMPTION): pause length log-normal, median ${PAUSE_MODEL.medianS} s, sigma ${PAUSE_MODEL.sigma}, ` +
      `conditioned on >= ${PAUSE_MODEL.debounceS} s (every trace element already passed the debounce)`,
  );
  console.log(`  S(3 s) = ${S(3).toFixed(3)}   S(4 s) = ${S(4).toFixed(3)}   S(5 s) = ${S(5).toFixed(3)}   (share of mid-title pauses that reach N)\n`);

  const row = (label: string, s: Summary) =>
    `${label.padEnd(34)} billed ${s.meanBilled.toFixed(2).padStart(5)} (p5 ${String(s.p5).padStart(2)}, p95 ${String(s.p95).padStart(2)})` +
    `  = ${perSong(s.meanBilled).toFixed(2)}/song   hit@10 mean ${s.meanH10.toFixed(2)}/${s.n}  min ${s.minH10}/${s.n}`;

  console.log(line);
  console.log("SWEEP over S = share of mid-title pauses that last >= N (read any other pause assumption off this table)");
  console.log(line);
  for (const p of [1, 0.5, 0.3, 0.2, 0.15, 0.1, 0.05, 0]) {
    const tag = p === 1 ? "  <- every pause bills = PR #88 client" : p === 0 ? "  <- Enter-only lower bound" : "";
    console.log(row(`S = ${p.toFixed(2)}`, simulate(traces, index, p)) + tag);
  }

  console.log(`\n${line}`);
  console.log("IDLE CANDIDATES under the stated pause model");
  console.log(line);
  const cand: Record<number, Summary> = {};
  for (const n of [3, 4, 5]) {
    cand[n] = simulate(traces, index, S(n));
    console.log(row(`N = ${n} s  (S = ${S(n).toFixed(3)})`, cand[n]) + (n * 1000 === IDLE_SEARCH_MS ? "  <- SHIPPED" : ""));
  }

  const shippedN = IDLE_SEARCH_MS / 1000;
  const chosen = cand[shippedN] ?? simulate(traces, index, S(shippedN));
  const before = simulate(traces, index, 1);
  console.log(`\n${line}`);
  console.log(`SHIPPED: IDLE_SEARCH_MS=${IDLE_SEARCH_MS}`);
  console.log(line);
  console.log(
    `billed search.list per queued song:  BEFORE (PR #88) ${perSong(before.meanBilled).toFixed(2)}  ->  AFTER ${perSong(chosen.meanBilled).toFixed(2)}` +
      `   (${before.meanBilled.toFixed(0)} -> ${chosen.meanBilled.toFixed(2)} mean calls over the same traces; p5-p95 ${chosen.p5}-${chosen.p95})`,
  );
  console.log(
    `                                     Enter-only floor ${perSong(simulate(traces, index, 0).meanBilled).toFixed(2)}   (no mid-title pause ever reaches N)`,
  );
  console.log(
    `hit@10 (settled):  BEFORE ${before.meanH10.toFixed(0)}/${before.n} (${pct(before.meanH10, before.n)})  ->  AFTER mean ${chosen.meanH10.toFixed(2)}/${chosen.n}, worst run ${chosen.minH10}/${chosen.n} (${pct(chosen.minH10, chosen.n)})`,
  );
  const s0 = replayOnce(traces, index, 0, () => 1);
  const s0q = grade(PRODUCTION_QUERIES, (raw) => s0.settled.get(raw) ?? []);
  const b1 = replayOnce(traces, index, 1, () => 0);
  const b1q = grade(PRODUCTION_QUERIES, (raw) => b1.settled.get(raw) ?? []);
  console.log(`Enter-only run misses: ${s0q.misses.join(" | ") || "(none)"}`);
  console.log(`PR #88 run misses:     ${b1q.misses.join(" | ") || "(none)"}`);
  const newly = s0q.misses.filter((m) => !b1q.misses.includes(m));
  console.log(`newly missed (Enter-only vs PR #88): ${newly.join(" | ") || "(none)"}`);

  if (!withControls) {
    console.log("\n(run with --controls for the falsifiability pass)");
    return;
  }

  console.log(`\n${"=".repeat(110)}`);
  console.log("PROVE-THE-MEASUREMENT-CAN-FAIL CONTROLS — each breaks something on purpose; the number MUST move");
  console.log("=".repeat(110));
  // C1: S = 1 is TICKET-124's client. It must reproduce PR #88 exactly.
  const c1 = replayOnce(traces, index, 1, () => 0);
  const c1q = grade(PRODUCTION_QUERIES, (raw) => c1.settled.get(raw) ?? []);
  console.log(
    `C1 S=1 (every pause bills)   billed ${c1.billed} (PR #88: ${PR88.billed})  hit@10 ${c1q.h10} (PR #88: ${PR88.h10})  -> ` +
      (c1.billed === PR88.billed && c1q.h10 === PR88.h10 ? "identical to PR #88, as required" : "!! DIFFERS — the harness is not PR #88's client"),
  );
  // C2: empty index + S=1 must reproduce the pre-index BEFORE (48 billed, 22 hits).
  const c2 = replayOnce(traces, new KaraokeIndex([]), 1, () => 0);
  const c2q = grade(PRODUCTION_QUERIES, (raw) => c2.settled.get(raw) ?? []);
  console.log(
    `C2 empty index, S=1          billed ${c2.billed} (pre-index main: 48)  hit@10 ${c2q.h10} (22)  -> ` +
      (c2.billed === 48 && c2q.h10 === 22 ? "identical to TICKET-108 main, as required" : "!! DIFFERS"),
  );
  // C3: the settle rule is load-bearing. If the final prefix does NOT settle
  // (no Enter, no idle), quality must collapse when graded on what is SHOWN.
  const c3 = replayOnce(traces, index, 0, () => 1, false);
  const c3q = grade(PRODUCTION_QUERIES, (raw) => c3.shown.get(raw) ?? []);
  console.log(
    `C3 nothing ever goes live    billed ${c3.billed}  hit@10 on screen ${c3q.h10}/${c3q.n}  -> ` +
      (c3q.h10 < s0q.h10 ? "quality DROPS — the Enter/idle settle is what keeps quality" : "!! no drop — grading ignores the settle"),
  );
  // C4: the timing knob moves the number (monotone in S).
  const lo = simulate(traces, index, 0.05).meanBilled;
  const hi = simulate(traces, index, 0.5).meanBilled;
  console.log(`C4 S 0.05 -> 0.5              billed ${lo.toFixed(2)} -> ${hi.toFixed(2)}  -> ${hi > lo ? "rises with S, as required" : "!! flat — S is not reaching the model"}`);
}

main();
