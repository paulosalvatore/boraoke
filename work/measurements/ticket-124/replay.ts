/**
 * TICKET-124 measurement harness — the TICKET-108 replay, extended with the
 * karaoke-index tier in front of live search.
 *
 * Same inputs as TICKET-108, unchanged:
 *   - the production oracle (work/measurements/ticket-108/production-search-results.json:
 *     80 real production cache keys -> the real YouTube pages production served),
 *   - the same keystroke traces, reconstructed the same way from those keys,
 *   - the same 32 graded production queries and the same hit predicate.
 * Plus the harvested index fixture (index-fixture.json.gz in this directory).
 *
 * Client side is the SHIPPED policy, not a model of it: `planSearch` with the
 * shipped MIN_LOCAL_MATCHES, and the shipped SongSearch MIN_CHARS (4).
 *
 * Server side, per fetch the client makes:
 *   BEFORE  cache miss -> 1 billed search.list call, the oracle page is shown.
 *   AFTER   decideTier(): index answers -> 0 billed, index rows are shown;
 *           otherwise -> exactly BEFORE.
 *
 * Zero search.list calls are spent by this harness.
 *
 * Run:  npm run measure:t124             (add --controls for the falsifiability pass)
 */

import { readFileSync } from "fs";
import { join } from "path";
import { gunzipSync } from "zlib";

import type { SearchResult } from "../../../lib/youtube-search";
import { PRODUCTION_QUERIES, type GradedQuery } from "../ticket-108/queries";
import {
  isExtensionOf,
  MIN_LOCAL_MATCHES,
  normalizeQuery,
  planSearch,
} from "../../../lib/search-prefix";
import { KaraokeIndex } from "../../../lib/karaoke-index/matcher";
import { decideTier, GOOD_MATCH_THRESHOLD, MIN_INDEX_QUERY_CHARS } from "../../../lib/karaoke-index/tier";
import type { ChannelShard } from "../../../lib/karaoke-index/types";

type Row = SearchResult;

/** components/SongSearch.tsx MIN_CHARS on main (TICKET-108 shipped 4). */
const CLIENT_MIN_CHARS = 4;

const ORACLE: Record<string, Row[]> = Object.fromEntries(
  Object.entries(
    JSON.parse(
      readFileSync(join(__dirname, "../ticket-108/production-search-results.json"), "utf8"),
    ) as Record<string, { videoId: string; title: string; channelTitle: string }[]>,
  ).map(([k, rows]) => [k, rows.map((r) => ({ ...r, duration: "", thumbnailUrl: "" }))]),
);

const FIXTURE = JSON.parse(
  gunzipSync(readFileSync(join(__dirname, "index-fixture.json.gz"))).toString("utf8"),
) as { harvestedAt: number; shards: ChannelShard[] };

const MEASURED = { billedCallsThatDay: 90, songsQueuedThatDay: 24, baselinePerSong: 3.75 };

// ── raw-input space (identical to TICKET-108) ─────────────────────────────────

function rawOf(cacheKey: string): string {
  return cacheKey.replace(/\s+karaoke$/i, "").trim() || cacheKey;
}
const RAW_TO_KEY = new Map<string, string>();
for (const key of Object.keys(ORACLE)) {
  const raw = rawOf(key);
  const existing = RAW_TO_KEY.get(raw);
  if (!existing || key.length > existing.length) RAW_TO_KEY.set(raw, key);
}
function pageFor(raw: string): Row[] | null {
  const key = RAW_TO_KEY.get(raw);
  return key === undefined ? null : ORACLE[key];
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

// ── grading (identical predicate to the spike and TICKET-108) ─────────────────

function hit(rows: readonly Row[], want: string[], n: number): boolean {
  return rows.slice(0, n).some((r) => {
    const t = normalizeQuery(`${r.title} ${r.channelTitle ?? ""}`);
    return want.every((w) => t.includes(w));
  });
}
interface Quality { n: number; h1: number; h5: number; h10: number; misses: string[] }
function grade(graded: GradedQuery[], rowsFor: (q: string) => Row[] | null): Quality {
  const out: Quality = { n: 0, h1: 0, h5: 0, h10: 0, misses: [] };
  for (const c of graded) {
    const rows = rowsFor(c.q);
    if (rows === null) continue;
    out.n++;
    out.h1 += hit(rows, c.want, 1) ? 1 : 0;
    out.h5 += hit(rows, c.want, 5) ? 1 : 0;
    const d = hit(rows, c.want, 10);
    out.h10 += d ? 1 : 0;
    if (!d) out.misses.push(c.q);
  }
  return out;
}
const pct = (x: number, n: number) => (n === 0 ? "n/a" : `${((x / n) * 100).toFixed(0)}%`);
function qline(label: string, q: Quality): string {
  return (
    `${label.padEnd(40)} n=${q.n}  hit@1 ${String(q.h1).padStart(2)} (${pct(q.h1, q.n).padStart(4)})` +
    `  hit@5 ${String(q.h5).padStart(2)} (${pct(q.h5, q.n).padStart(4)})` +
    `  hit@10 ${String(q.h10).padStart(2)} (${pct(q.h10, q.n).padStart(4)})`
  );
}

// ── replay ───────────────────────────────────────────────────────────────────

interface ServerPolicy {
  index: KaraokeIndex | null;
  threshold: number;
  minChars: number;
}
interface Replay {
  billed: number;
  indexServed: number;
  displayed: Map<string, Row[]>;
  liveReasons: Record<string, number>;
}

function replay(traces: string[][], server: ServerPolicy | null): Replay {
  let billed = 0;
  let indexServed = 0;
  const displayed = new Map<string, Row[]>();
  const liveReasons: Record<string, number> = {};
  for (const trace of traces) {
    let heldQuery = "";
    let heldRows: Row[] = [];
    for (const raw of trace) {
      if (normalizeQuery(raw).length < CLIENT_MIN_CHARS) continue;
      const plan = planSearch({ next: raw, heldQuery, heldRows, minLocalMatches: MIN_LOCAL_MATCHES });
      if (plan.action === "filter") {
        displayed.set(raw, plan.rows);
        continue;
      }
      // The client fetches. What the server sends is the cache key (augmented q).
      const key = RAW_TO_KEY.get(raw) as string;
      let rows: Row[];
      if (server) {
        const d = decideTier({ q: key, pageToken: "", index: server.index, threshold: server.threshold, minChars: server.minChars });
        if (d.tier === "index") {
          indexServed++;
          rows = d.results;
        } else {
          billed++;
          liveReasons[d.reason] = (liveReasons[d.reason] ?? 0) + 1;
          rows = pageFor(raw) ?? [];
        }
      } else {
        billed++;
        rows = pageFor(raw) ?? [];
      }
      heldQuery = raw;
      heldRows = rows;
      displayed.set(raw, rows);
    }
  }
  return { billed, indexServed, displayed, liveReasons };
}

function displayedFor(r: Replay, q: string): Row[] | null {
  const raw = rawForGraded(q);
  if (raw === null) return null;
  return r.displayed.get(raw) ?? [];
}

// ── main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const withControls = process.argv.includes("--controls");
  const t0 = Date.now();
  const index = new KaraokeIndex(FIXTURE.shards);
  const buildMs = Date.now() - t0;
  const traces = reconstructTraces([...RAW_TO_KEY.keys()]);
  const perSong = (billed: number, base: number) => (MEASURED.baselinePerSong * billed) / base;

  console.log("=".repeat(110));
  console.log("TICKET-124 — karaoke index as primary tier: billed calls AND quality, replayed over real production traces");
  console.log("=".repeat(110));
  console.log(
    `index fixture: ${FIXTURE.shards.length} channels, ${index.size} videos, harvested ${new Date(FIXTURE.harvestedAt).toISOString()}  (build ${buildMs} ms)`,
  );
  console.log(`oracle: ${Object.keys(ORACLE).length} production cache keys; traces: ${traces.length} keystroke families`);
  console.log(`client policy (shipped): MIN_CHARS=${CLIENT_MIN_CHARS}, MIN_LOCAL_MATCHES=${MIN_LOCAL_MATCHES}\n`);

  // The pre-TICKET-108 per-keystroke baseline, for the arithmetic only.
  const perKeystroke = Object.keys(ORACLE).length;

  const before = replay(traces, null);
  const beforeQ = grade(PRODUCTION_QUERIES, (q) => displayedFor(before, q));
  const excluded = PRODUCTION_QUERIES.filter((c) => rawForGraded(c.q) === null).map((c) => c.q);

  console.log("─".repeat(110));
  console.log("BEFORE — main today (TICKET-108 shipped, no index). Re-measured, not copied.");
  console.log("─".repeat(110));
  console.log(
    `billed ${before.billed} of ${perKeystroke} pre-108 calls  =  ${perSong(before.billed, perKeystroke).toFixed(2)} billed search.list calls per queued song`,
  );
  console.log(qline("quality", beforeQ));
  console.log(`excluded (never searched in production, no page to grade): ${excluded.length} — ${excluded.join(" | ")}`);

  // Threshold curve.
  console.log(`\n${"─".repeat(110)}`);
  console.log("AFTER — cache → index → live.  Threshold curve (confidence = mean per-token match quality of the best row).");
  console.log("─".repeat(110));
  const curve: { th: number; mc: number; r: Replay; q: Quality }[] = [];
  for (const mc of [3, 4, 5, 6]) {
    for (const th of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
      const r = replay(traces, { index, threshold: th, minChars: mc });
      const q = grade(PRODUCTION_QUERIES, (c) => displayedFor(r, c));
      curve.push({ th, mc, r, q });
      const d = q.h10 - beforeQ.h10;
      console.log(
        `minChars=${mc} threshold=${th.toFixed(1)}  billed ${String(r.billed).padStart(2)} (index served ${String(r.indexServed).padStart(2)})` +
          `  = ${perSong(r.billed, perKeystroke).toFixed(2)}/song   ${qline("", q).trim()}` +
          `  ${d < 0 ? `◀ REGRESSES ${d}` : d > 0 ? `▲ +${d}` : "= holds"}`,
      );
    }
  }

  // ── LONG-TAIL SIMULATION ─────────────────────────────────────────────────
  // The replay above cannot see the threshold's real job: on these 28 queries
  // the index usually HAS the song, so a lax threshold looks free. The risk a
  // threshold guards against is the long tail — the song is NOT in the index,
  // and the index confidently serves a near-miss instead of letting live
  // search find it. Simulate exactly that: for each sing-mode graded query,
  // rebuild the index WITHOUT every row that would satisfy the hit predicate,
  // then ask the tier. A confident answer here is a FALSE answer (it blocks
  // the live fallback); the right behaviour is to go live.
  console.log(`\n${"─".repeat(110)}`);
  console.log("LONG-TAIL SIMULATION — the wanted song is removed from the index; a confident index answer is a false answer.");
  console.log("─".repeat(110));
  const singGraded = PRODUCTION_QUERIES.filter((c) => /\bkaraoke\b/i.test(c.q) && rawForGraded(c.q) !== null);
  const absentIdx = singGraded.map((c) => {
    const shards = FIXTURE.shards.map((sh) => ({
      ...sh,
      rows: sh.rows.filter((r) => {
        const t = normalizeQuery(`${r[1]} ${sh.channelTitle}`);
        return !c.want.every((w) => t.includes(w));
      }),
    }));
    return { c, idx: new KaraokeIndex(shards) };
  });
  const longTail: Record<string, { falseAnswers: number; h10: number; n: number; which: string[] }> = {};
  for (const mc of [4]) {
    for (const th of [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
      const k = `minChars=${mc} threshold=${th.toFixed(1)}`;
      const acc = { falseAnswers: 0, h10: 0, n: 0, which: [] as string[] };
      for (const { c, idx } of absentIdx) {
        const key = RAW_TO_KEY.get(rawForGraded(c.q) as string) as string;
        const d = decideTier({ q: key, pageToken: "", index: idx, threshold: th, minChars: mc });
        const rows = d.tier === "index" ? d.results : (pageFor(rawForGraded(c.q) as string) ?? []);
        acc.n++;
        if (d.tier === "index") {
          acc.falseAnswers++;
          acc.which.push(c.q);
        }
        if (hit(rows, c.want, 10)) acc.h10++;
      }
      longTail[k] = acc;
      console.log(
        `${k}  false confident answers ${String(acc.falseAnswers).padStart(2)}/${acc.n}` +
          `   hit@10 ${acc.h10}/${acc.n} (live alone: ${absentIdx.filter(({ c }) => hit(pageFor(rawForGraded(c.q) as string) ?? [], c.want, 10)).length}/${acc.n})` +
          `   ${acc.which.join(" | ")}`,
      );
    }
  }

  const chosen = curve.find((c) => c.th === GOOD_MATCH_THRESHOLD && c.mc === MIN_INDEX_QUERY_CHARS)!;
  console.log(`\n${"─".repeat(110)}`);
  console.log(`SHIPPED VALUES: GOOD_MATCH_THRESHOLD=${GOOD_MATCH_THRESHOLD}  MIN_INDEX_QUERY_CHARS=${MIN_INDEX_QUERY_CHARS}`);
  console.log("─".repeat(110));
  console.log(
    `billed search.list per queued song:  BEFORE ${perSong(before.billed, perKeystroke).toFixed(2)}  →  AFTER ${perSong(chosen.r.billed, perKeystroke).toFixed(2)}` +
      `   (${before.billed} → ${chosen.r.billed} calls over the same traces, ${chosen.r.indexServed} fetches answered by the index)`,
  );
  console.log(`hit@10:  BEFORE ${beforeQ.h10}/${beforeQ.n} (${pct(beforeQ.h10, beforeQ.n)})  →  AFTER ${chosen.q.h10}/${chosen.q.n} (${pct(chosen.q.h10, chosen.q.n)})`);
  console.log(qline("BEFORE", beforeQ));
  console.log(qline("AFTER", chosen.q));
  console.log(`why AFTER still billed: ${JSON.stringify(chosen.r.liveReasons)}`);
  console.log(`before misses: ${beforeQ.misses.join(" | ") || "(none)"}`);
  console.log(`after  misses: ${chosen.q.misses.join(" | ") || "(none)"}`);
  const gained = chosen.q.misses.filter((m) => !beforeQ.misses.includes(m));
  const fixed = beforeQ.misses.filter((m) => !chosen.q.misses.includes(m));
  console.log(`newly missed by AFTER: ${gained.join(" | ") || "(none)"}   newly hit by AFTER: ${fixed.join(" | ") || "(none)"}`);

  // Index alone (comparable to the spike's 66% index-only figure): every graded
  // query answered from the index's top 10, no fallback.
  const alone = grade(PRODUCTION_QUERIES, (q) => (rawForGraded(q) === null ? null : index.search(q, 10).hits.map((h) => ({
    videoId: h.video.videoId, title: h.video.title, channelTitle: h.video.channelTitle, duration: "", thumbnailUrl: "",
  }))));
  console.log(`\n${qline("index ALONE, no fallback (cf. spike 66%)", alone)}`);

  // Latency.
  const qs = [...RAW_TO_KEY.values(), ...PRODUCTION_QUERIES.map((c) => c.q)];
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) for (const q of qs) index.search(q);
  const ms = Number(process.hrtime.bigint() - t1) / 1e6 / (qs.length * 5);
  console.log(`latency: ${ms.toFixed(2)} ms/query mean over ${qs.length * 5} searches (in-process, warm)`);

  if (!withControls) {
    console.log("\n(run with --controls for the falsifiability pass)");
    return;
  }

  console.log(`\n${"=".repeat(110)}`);
  console.log("PROVE-THE-MEASUREMENT-CAN-FAIL CONTROLS — each breaks something on purpose; the number MUST move");
  console.log("=".repeat(110));

  // C1: an EMPTY index must reproduce BEFORE exactly (the tier is a pure add-on).
  const c1 = replay(traces, { index: new KaraokeIndex([]), threshold: GOOD_MATCH_THRESHOLD, minChars: MIN_INDEX_QUERY_CHARS });
  const c1q = grade(PRODUCTION_QUERIES, (c) => displayedFor(c1, c));
  console.log(
    `C1 empty index           billed ${c1.billed} (BEFORE ${before.billed})  hit@10 ${c1q.h10} (BEFORE ${beforeQ.h10})  → ` +
      (c1.billed === before.billed && c1q.h10 === beforeQ.h10 ? "identical to BEFORE, as required" : "!! DIFFERS — the fallback path is not today's path"),
  );

  // C2: no threshold at all (any full-coverage row answers, even 1-letter tokens).
  // On the in-index replay a lax threshold is nearly free (the songs are there),
  // so the threshold's effect is judged where it acts: the long-tail simulation.
  const c2 = replay(traces, { index, threshold: 0, minChars: 0 });
  const c2q = grade(PRODUCTION_QUERIES, (c) => displayedFor(c2, c));
  let c2False = 0;
  for (const { c, idx } of absentIdx) {
    const key = RAW_TO_KEY.get(rawForGraded(c.q) as string) as string;
    if (decideTier({ q: key, pageToken: "", index: idx, threshold: 0, minChars: 0 }).tier === "index") c2False++;
  }
  const chosenFalse = longTail[`minChars=${MIN_INDEX_QUERY_CHARS} threshold=${GOOD_MATCH_THRESHOLD.toFixed(1)}`]?.falseAnswers ?? -1;
  console.log(
    `C2 threshold removed     replay: billed ${c2.billed}  hit@10 ${c2q.h10}   long-tail: false confident answers ${c2False}/${absentIdx.length} (shipped: ${chosenFalse})  → ` +
      (c2False > chosenFalse
        ? "false answers RISE — the threshold is load-bearing where it is meant to act"
        : "!! no rise — the threshold may be doing nothing"),
  );

  // C3: scrambled index (titles rotated between rows): the index tier must
  // stop helping — quality falls or the tier stops being trusted.
  const scrambled: ChannelShard[] = FIXTURE.shards.map((s) => ({
    ...s,
    rows: s.rows.map((r, i) => [r[0], s.rows[(i + 7) % s.rows.length][1], r[2]] as [string, string, string]),
  }));
  // Title-only hit predicate would be fooled by rotation; grade on videoId instead:
  const truth = new Map<string, string>();
  for (const s of FIXTURE.shards) for (const r of s.rows) truth.set(r[0], r[1]);
  const c3 = replay(traces, { index: new KaraokeIndex(scrambled), threshold: GOOD_MATCH_THRESHOLD, minChars: MIN_INDEX_QUERY_CHARS });
  const c3q = grade(PRODUCTION_QUERIES, (c) => {
    const rows = displayedFor(c3, c);
    return rows === null ? null : rows.map((r) => (truth.has(r.videoId) ? { ...r, title: truth.get(r.videoId) as string } : r));
  });
  console.log(
    `C3 scrambled index       billed ${c3.billed}  hit@10 ${c3q.h10} (graded on the videos' REAL titles)  → ` +
      (c3q.h10 < chosen.q.h10 ? "quality DROPS — the grade sees the index's actual answers" : "!! did not drop — grading may not be looking at index rows"),
  );

  // C4: the hit predicate is not vacuous.
  const c4q = grade(PRODUCTION_QUERIES, (c) => (rawForGraded(c) === null ? null : []));
  console.log(`C4 empty rows            hit@10 ${c4q.h10}  → ${c4q.h10 === 0 ? "0, as required" : "!! NON-ZERO — hit() is vacuous"}`);
}

main();
