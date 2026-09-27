/**
 * TICKET-108 measurement harness — replays REAL production typing traces through
 * the product's own `planSearch()` and reports BOTH numbers the ticket demands:
 *
 *   1. billed `search.list` calls (before vs after), and
 *   2. result QUALITY (hit@1/5/10) against the spike's 32 real production queries,
 *      prefix-filtered vs full-string.
 *
 * Reporting only (1) would be a false win of exactly the kind this product has
 * been bitten by: a short prefix's top-50 may simply not contain the song a longer
 * query returns, so client-side narrowing can make results worse while the quota
 * graph looks excellent. (2) is the guardrail, and the CONTROLS below exist to
 * prove (2) can actually detect that degradation.
 *
 * ── THE ORACLE, AND WHY IT COSTS ZERO QUOTA ────────────────────────────────────
 *
 * `production-search-results.json` is the production search cache itself, read
 * read-only over the Upstash REST API on 2026-09-27 (via the KV read-only token,
 * pulled outside the repo and shredded; no secret is in this tree, and no write
 * of any kind was issued to production). It holds **80 real production queries →
 * 3,919 real YouTube result rows**, including the complete keystroke ladders the
 * TICKET-106 spike found:
 *
 *     esc karaoke → escu karaoke → escur karaoke → … → escurinho do cinema karaoke
 *
 * That is precisely the dataset this measurement needs, and using it means the
 * whole before/after comparison spends **zero** `search.list` calls — important,
 * because the alternative (live-searching all 32 graded queries plus every prefix
 * the policy fetches) would have burned over half of the platform's 90-call daily
 * patron budget to measure a fix for the platform's 90-call daily budget.
 *
 * Positive controls for the probe that produced it (`proof-by-absence`): `PING →
 * PONG`, `DBSIZE → 157`, and a full `SCAN` returning the expected namespaces
 * (`sc:` 80, `room:` 28, `identity:` 24, `telemetry:` 19, `feedback:` 4, `rooms:`
 * 1, `sb:` 1), with `sb:2026-09-26 = 90` re-confirming the exhausted day. The
 * dump aborted non-zero if zero `sc:` keys came back, so an empty oracle could
 * never have been mistaken for a clean run.
 *
 * ── RAW-INPUT SPACE vs CACHE-KEY SPACE (this bit is easy to get wrong) ─────────
 *
 * Cache keys are the AUGMENTED query: in sing mode the client appends the keyword
 * ("escu" → `sc:BR::escu karaoke`, see `augmentQuery`). The patron's keystroke
 * ladder therefore is NOT visible in cache-key space — "escu karaoke" does not
 * textually extend "esc karaoke", because the suffix sits on the end of both.
 *
 * So this harness works in RAW-INPUT space: it strips the trailing keyword to
 * recover what the patron actually typed, chains the traces there, and maps back
 * to the cache key only to look up the result page. That is exactly what the
 * product does too — `planSearch` is fed the raw input and augmentation happens
 * only on the way out to the network. Getting this wrong understates the win
 * roughly threefold (measured: −13% instead of −68%), which is a good reminder
 * that a plausible-looking number is not a correct one.
 *
 * ── THE TRACES ARE MEASURED, NOT SYNTHESISED ──────────────────────────────────
 *
 * A synthetic "type one title character by character" trace would be a guess
 * about where patrons pause. Instead the traces ARE the cache keys: a cache key
 * exists if and only if that exact string was debounced and billed in production.
 * Grouping them into prefix chains recovers the real debounce sequences, so the
 * baseline arm is not modelled at all — it is 1 billed call per key, which is
 * what actually happened.
 *
 * Run:  npm run measure:t108            (add --controls for the falsifiability run)
 */

import { readFileSync } from "fs";
import { join } from "path";

import type { SearchResult } from "../../../lib/youtube-search";
import { PRODUCTION_QUERIES, UNGRADABLE, type GradedQuery } from "./queries";
import {
  filterResults,
  isExtensionOf,
  normalizeQuery,
  planSearch,
  queryTokens,
} from "../../../lib/search-prefix";

/**
 * A production result row. The fixture keeps only the three fields grading needs
 * (id, title, channel) — `duration`/`thumbnailUrl` are presentation-only and are
 * filled with empty strings so the rows are structurally real `SearchResult`s and
 * can be handed to the product's own helpers without a cast.
 */
type Row = SearchResult;

const HERE = __dirname;
const FIXTURE: Record<string, { videoId: string; title: string; channelTitle: string }[]> = JSON.parse(
  readFileSync(join(HERE, "production-search-results.json"), "utf8"),
);
/** cache-key (augmented query) → the real YouTube page production served for it. */
const ORACLE: Record<string, Row[]> = Object.fromEntries(
  Object.entries(FIXTURE).map(([k, rows]) => [
    k,
    rows.map((r) => ({ ...r, duration: "", thumbnailUrl: "" })),
  ]),
);

/** Measured facts from the production probe, used only for the final arithmetic. */
const MEASURED = {
  /** `sb:2026-09-26` — the exhausted day's billed `search.list` calls. */
  billedCallsThatDay: 90,
  /** `song_queued` telemetry for the same session. */
  songsQueuedThatDay: 24,
  /** 90 / 24 — the ticket's stated baseline. */
  baselinePerSong: 3.75,
};

// ── raw-input space ───────────────────────────────────────────────────────────

/** Recover the raw patron input from an augmented cache key. */
function rawOf(cacheKey: string): string {
  return cacheKey.replace(/\s+karaoke$/i, "").trim() || cacheKey;
}

/**
 * raw input → cache key. Where both the augmented and the bare form were cached
 * (mixed modes across the evening) the augmented one wins, because sing is the
 * default mode and therefore the dominant real path.
 */
const RAW_TO_KEY = new Map<string, string>();
for (const key of Object.keys(ORACLE)) {
  const raw = rawOf(key);
  const existing = RAW_TO_KEY.get(raw);
  if (!existing || key.length > existing.length) RAW_TO_KEY.set(raw, key);
}

/** The real page production served for a raw input, or null when it was never searched. */
function pageFor(raw: string): Row[] | null {
  const key = RAW_TO_KEY.get(raw);
  return key === undefined ? null : ORACLE[key];
}

/**
 * Resolve a GRADED query string to the raw input it belongs to.
 *
 * The graded set mixes augmented and bare forms, so try both, then accent/
 * punctuation folding — but NEVER a fuzzy match: silently grading query A
 * against query B's results is precisely the wrong number this harness exists to
 * avoid. A graded query with no production page is EXCLUDED and listed by name,
 * never quietly counted as a miss.
 */
function rawForGraded(q: string): string | null {
  for (const cand of [rawOf(q), q]) {
    if (RAW_TO_KEY.has(cand)) return cand;
  }
  const targets = [normalizeQuery(rawOf(q)), normalizeQuery(q)];
  for (const raw of RAW_TO_KEY.keys()) {
    if (targets.includes(normalizeQuery(raw))) return raw;
  }
  return null;
}

// ── trace reconstruction ──────────────────────────────────────────────────────

/**
 * Group the raw inputs into keystroke families: maximal chains in which each
 * member textually extends — or is a pure re-spelling of — the previous one.
 * These are the real debounce sequences that were billed in production.
 *
 * Re-spellings belong in the SAME family: production billed separate calls for
 * `mana`/`maná` and `cerol na mao`/`cerol na mão`, which fold to one query. The
 * component holds its rows across that edit, so the replay must too or it would
 * under-count the saving.
 */
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

// ── grading ───────────────────────────────────────────────────────────────────

/**
 * The spike's hit predicate, unchanged: a row hits when every `want` token
 * appears in the normalized "title + channel" text. Kept comparable so these
 * numbers can be read against the spike's own figures.
 */
function hit(rows: readonly Row[], want: string[], n: number): boolean {
  return rows.slice(0, n).some((r) => {
    const t = normalizeQuery(`${r.title} ${r.channelTitle ?? ""}`);
    return want.every((w) => t.includes(w));
  });
}

interface Policy {
  label: string;
  /** Minimum locally-matching rows required to narrow instead of fetching. */
  minLocalMatches: number;
  /** Raw inputs shorter than this were never searched at all. */
  minChars: number;
  /** Deliberate breakage, for the falsifiability controls only. */
  mutate?: {
    /** Show the held page untouched instead of narrowing it. */
    noFilter?: boolean;
    /** Pretend every fetch came back empty. */
    emptyOracle?: boolean;
  };
}

interface Replay {
  billed: number;
  /** What the patron would see, keyed by raw input. */
  displayed: Map<string, Row[]>;
  /** Why each billed call was spent (sanity + reporting). */
  reasons: Record<string, number>;
}

function replay(traces: string[][], p: Policy): Replay {
  let billed = 0;
  const displayed = new Map<string, Row[]>();
  const reasons: Record<string, number> = {};
  for (const trace of traces) {
    let heldQuery = "";
    let heldRows: Row[] = [];
    for (const raw of trace) {
      if (normalizeQuery(raw).length < p.minChars) continue;
      const plan = planSearch({
        next: raw,
        heldQuery,
        heldRows,
        minLocalMatches: p.minLocalMatches,
      });
      if (plan.action === "fetch") {
        billed++;
        reasons[plan.reason] = (reasons[plan.reason] ?? 0) + 1;
        heldQuery = raw;
        heldRows = p.mutate?.emptyOracle ? [] : (pageFor(raw) ?? []);
        displayed.set(raw, heldRows);
      } else {
        displayed.set(raw, p.mutate?.noFilter ? heldRows : plan.rows);
      }
    }
  }
  return { billed, displayed, reasons };
}

interface Quality {
  n: number;
  h1: number;
  h5: number;
  h10: number;
  misses: string[];
  byKind: Record<string, { n: number; h10: number }>;
}

function grade(graded: GradedQuery[], rowsFor: (q: string) => Row[] | null): Quality {
  const out: Quality = { n: 0, h1: 0, h5: 0, h10: 0, misses: [], byKind: {} };
  for (const c of graded) {
    const rows = rowsFor(c.q);
    if (rows === null) continue; // no production page — excluded, and listed by the caller
    out.n++;
    out.h1 += hit(rows, c.want, 1) ? 1 : 0;
    out.h5 += hit(rows, c.want, 5) ? 1 : 0;
    const d = hit(rows, c.want, 10);
    out.h10 += d ? 1 : 0;
    out.byKind[c.kind] ??= { n: 0, h10: 0 };
    out.byKind[c.kind].n++;
    out.byKind[c.kind].h10 += d ? 1 : 0;
    if (!d) out.misses.push(c.q);
  }
  return out;
}

/**
 * What the patron would SEE for a graded query under a replayed policy.
 * `null` (never searched in production) propagates so `grade()` EXCLUDES it;
 * a query that has a page but was somehow never displayed counts as a real miss,
 * which is the conservative direction.
 */
function displayedFor(r: Replay, gradedQuery: string): Row[] | null {
  const raw = rawForGraded(gradedQuery);
  if (raw === null) return null;
  return r.displayed.get(raw) ?? [];
}

function pct(x: number, n: number): string {
  return n === 0 ? "n/a" : `${((x / n) * 100).toFixed(0)}%`;
}

function qualityLine(label: string, q: Quality): string {
  return (
    `${label.padEnd(42)} n=${q.n}  hit@1 ${String(q.h1).padStart(2)} (${pct(q.h1, q.n).padStart(4)})` +
    `  hit@5 ${String(q.h5).padStart(2)} (${pct(q.h5, q.n).padStart(4)})` +
    `  hit@10 ${String(q.h10).padStart(2)} (${pct(q.h10, q.n).padStart(4)})`
  );
}

// ── main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const withControls = process.argv.includes("--controls");
  const cacheKeys = Object.keys(ORACLE);
  const raws = [...RAW_TO_KEY.keys()];

  console.log("=".repeat(104));
  console.log("TICKET-108 — billed calls AND result quality, replayed over real production traces");
  console.log("=".repeat(104));
  console.log(
    `oracle: ${cacheKeys.length} production cache keys → ${raws.length} distinct raw inputs, ` +
      `${Object.values(ORACLE).reduce((a, b) => a + b.length, 0)} real YouTube rows, 0 search.list calls spent`,
  );

  const traces = reconstructTraces(raws);
  const inTraces = traces.reduce((a, t) => a + t.length, 0);
  if (inTraces !== raws.length) {
    throw new Error(`CONTROL FAIL: ${inTraces} raw inputs in traces vs ${raws.length} distinct`);
  }
  console.log(`traces: ${traces.length} keystroke families covering all ${inTraces} raw inputs`);
  console.log("\nlongest families (the ones that drained the budget):");
  for (const t of [...traces].sort((a, b) => b.length - a.length).slice(0, 6)) {
    console.log(`  ${String(t.length).padStart(2)} billed calls today:  ${t.join(" → ")}`);
  }

  // ── ARM A: baseline. Not modelled — every cache key IS one billed call. ──
  const baselineBilled = cacheKeys.length;
  const baselineQuality = grade(PRODUCTION_QUERIES, (q) => {
    const raw = rawForGraded(q);
    return raw === null ? null : pageFor(raw);
  });
  const excluded = PRODUCTION_QUERIES.filter((c) => rawForGraded(c.q) === null).map((c) => c.q);

  console.log(`\n${"─".repeat(104)}`);
  console.log("BILLED CALLS — replayed over the same real production traces");
  console.log("─".repeat(104));
  console.log(
    `${"BEFORE (today: one call per debounce)".padEnd(42)} ${String(baselineBilled).padStart(3)} calls   ` +
      `= ${MEASURED.baselinePerSong.toFixed(2)} per queued song ` +
      `(measured: ${MEASURED.billedCallsThatDay} calls / ${MEASURED.songsQueuedThatDay} songs)`,
  );

  const variants: Policy[] = [];
  for (const minChars of [3, 4, 5]) {
    for (const minLocalMatches of [1, 2, 3, 5, 8]) {
      variants.push({
        label: `minChars=${minChars} minLocalMatches=${minLocalMatches}`,
        minChars,
        minLocalMatches,
      });
    }
  }

  const results: { p: Policy; r: Replay; q: Quality }[] = [];
  for (const p of variants) {
    const r = replay(traces, p);
    const q = grade(PRODUCTION_QUERIES, (c) => displayedFor(r, c));
    results.push({ p, r, q });
    console.log(
      `${`AFTER  ${p.label}`.padEnd(42)} ${String(r.billed).padStart(3)} calls   ` +
        `= ${((MEASURED.baselinePerSong * r.billed) / baselineBilled).toFixed(2)} per queued song   ` +
        `(−${((1 - r.billed / baselineBilled) * 100).toFixed(0)}%)`,
    );
  }

  console.log(`\n${"─".repeat(104)}`);
  console.log("RESULT QUALITY — the guardrail. Same 32 graded production queries, same hit predicate as the spike.");
  console.log("─".repeat(104));
  if (excluded.length) {
    console.log(
      `EXCLUDED — never searched in production, so there is no page to grade against ` +
        `(NOT silently counted as misses): ${excluded.length}/${PRODUCTION_QUERIES.length}`,
    );
    for (const e of excluded) console.log(`   · ${e}`);
  }
  console.log("");
  console.log(qualityLine("BEFORE  full-string search (today)", baselineQuality));
  for (const { p, q } of results) {
    const delta = q.h10 - baselineQuality.h10;
    const flag = delta < 0 ? `  ◀ DEGRADED ${delta}` : delta > 0 ? `  ▲ +${delta}` : "  = holds";
    console.log(`${qualityLine(`AFTER   ${p.label}`, q)}${flag}`);
  }

  const rec = results.find((x) => x.p.minChars === 3 && x.p.minLocalMatches === 3)!;
  console.log("\nby query shape, BEFORE vs the recommended variant (minChars=3 minLocalMatches=3):");
  for (const kind of Object.keys(baselineQuality.byKind)) {
    const b = baselineQuality.byKind[kind];
    const a = rec.q.byKind[kind];
    console.log(`   ${kind.padEnd(9)} hit@10  before ${b.h10}/${b.n}   after ${a.h10}/${a.n}`);
  }
  console.log(`\n   before misses: ${baselineQuality.misses.join(" | ") || "(none)"}`);
  console.log(`   after  misses: ${rec.q.misses.join(" | ") || "(none)"}`);
  console.log(`   why the recommended variant still spent calls: ${JSON.stringify(rec.r.reasons)}`);
  console.log(
    `\nungradable production strings excluded by the spike (a human cannot tell either): ${UNGRADABLE.length}`,
  );

  if (!withControls) {
    console.log("\n(run with --controls for the falsifiability pass)");
    return;
  }

  console.log(`\n\n${"=".repeat(104)}`);
  console.log("PROVE-THE-MEASUREMENT-CAN-FAIL CONTROLS");
  console.log("=".repeat(104));
  console.log(
    "A quality harness that scores the same however badly the policy behaves is measuring nothing.\n" +
      "Each control below breaks something on purpose; the stated number MUST move.\n",
  );

  // C1 — THE decisive control, and also the ticket's naive proposal.
  // "Extension ⇒ never refetch" (starvation guard removed). Billing must collapse
  // further AND quality must visibly drop — which is what proves the quality arm
  // is capable of detecting the false win rather than being blind to it.
  const c1 = replay(traces, { label: "c1", minChars: 3, minLocalMatches: 0 });
  const c1q = grade(PRODUCTION_QUERIES, (c) => displayedFor(c1, c));
  console.log(
    `C1  naive "extension ⇒ never refetch" (minLocalMatches=0, starvation guard REMOVED)\n` +
      `      billed ${c1.billed} (baseline ${baselineBilled})   ${qualityLine("", c1q).trim()}\n` +
      `      → hit@10 ${c1q.h10} vs baseline ${baselineQuality.h10}: ${
        c1q.h10 < baselineQuality.h10
          ? "DROPS, as it must — the quality arm does detect degradation, so the \"holds\" verdicts above mean something"
          : "!! DID NOT DROP — the quality arm may be blind; investigate before trusting any number above"
      }`,
  );
  if (c1q.misses.length) console.log(`      C1 misses: ${c1q.misses.join(" | ")}`);

  // C2 — negative control: an empty oracle must score 0%. If it does not, `hit()`
  // is vacuously true and every percentage above is meaningless.
  const c2 = replay(traces, { label: "c2", minChars: 3, minLocalMatches: 3, mutate: { emptyOracle: true } });
  const c2q = grade(PRODUCTION_QUERIES, (c) => displayedFor(c2, c));
  console.log(
    `\nC2  empty oracle (must be 0%)\n      ${qualityLine("", c2q).trim()}\n` +
      `      → ${
        c2q.h10 === 0
          ? "0 hits, as required — hit() is not vacuously true"
          : "!! NON-ZERO — hit() is vacuous and every number above is invalid"
      }`,
  );

  // C3 — mutation: remove local narrowing (show the held page verbatim). Quality
  // must NOT come out ahead of the baseline.
  const c3 = replay(traces, { label: "c3", minChars: 3, minLocalMatches: 3, mutate: { noFilter: true } });
  const c3q = grade(PRODUCTION_QUERIES, (c) => displayedFor(c3, c));
  console.log(
    `\nC3  no local narrowing at all (held page shown verbatim)\n` +
      `      billed ${c3.billed}   ${qualityLine("", c3q).trim()}\n` +
      `      → ${c3q.h10 <= baselineQuality.h10 ? "does not beat the baseline, as expected" : "!! beats the baseline — suspicious, investigate"}`,
  );

  // C4 — is diacritic folding load-bearing? Patrons add the accent after the
  // fact ("evide" → "evidências", "mana" → "maná"). Unfolded, both read as a
  // brand-new query and bill a call; production really did pay twice for
  // mana/maná and twice for cerol na mao/mão. Asserted through planSearch, so it
  // is the SHIPPED decision being checked, not a helper in isolation.
  console.log("\nC4  diacritic folding is load-bearing (an accent added after the fact must not bill)");
  for (const [heldRaw, nextRaw] of [
    ["evide", "evidências"],
    ["mana", "maná"],
    ["cerol na mao", "cerol na mão"],
  ]) {
    const held = pageFor(heldRaw) ?? [];
    const folded = planSearch({ next: nextRaw, heldQuery: heldRaw, heldRows: held, minLocalMatches: 3 });
    console.log(
      `      "${heldRaw}" → "${nextRaw}":  planSearch = ${folded.action}` +
        `${folded.action === "fetch" ? ` (${folded.reason})` : ` (${folded.rows.length} rows, 0 calls)`}` +
        `   raw unfolded startsWith = ${nextRaw.startsWith(heldRaw)}`,
    );
  }

  // C5 — the token-PREFIX rule in filterResults is what keeps mid-word typing off
  // the network. Whole-word equality starves and would refetch every keystroke.
  console.log("\nC5  token-PREFIX matching is load-bearing (mid-word typing)");
  let c5Proven = false;
  for (const [heldRaw, nextRaw] of [
    ["escurinho", "escurinho do cin"],
    ["vida", "vida de gad"],
    ["quien", "quien se hay tomado"],
    ["borbulhas", "borbulhas de"],
  ]) {
    const held = pageFor(heldRaw) ?? [];
    if (held.length === 0) continue;
    const prefixRows = filterResults(held, nextRaw).length;
    const equalityRows = held.filter((r) => {
      const words = queryTokens(`${r.title} ${r.channelTitle}`);
      return queryTokens(nextRaw)
        .filter((t) => !["do", "da", "de", "se"].includes(t))
        .every((t) => words.includes(t));
    }).length;
    if (prefixRows > equalityRows) c5Proven = true;
    console.log(
      `      page("${heldRaw}") narrowed by "${nextRaw}":  prefix-match ${prefixRows} rows` +
        `   whole-word-equality ${equalityRows} rows`,
    );
  }
  console.log(
    `      → ${
      c5Proven
        ? "prefix matching keeps rows that word-equality would starve on — the rule earns its keep"
        : "!! no case where prefix matching helped — the rule may be dead code, investigate"
    }`,
  );
}

main();
