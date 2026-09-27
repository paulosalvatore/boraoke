/**
 * TICKET-106 spike prototype — STEP 3 of 3: measure the local index's hit rate
 * against REAL patron queries, and prove the measurement can fail.
 *
 * THE TEST SET IS NOT INVENTED. Every `q` in PRODUCTION_QUERIES below was typed
 * by a real patron into production Boraoke and is present verbatim as an
 * `sc:BR::<q>` key in the production search cache, read live on 2026-09-27. The
 * `want` column is derived from the LONGEST member of the same keystroke family
 * — i.e. what that same patron eventually finished typing — so ground truth is
 * the patron's own demonstrated intent, not my guess at it.
 *
 * `prove-your-test-can-fail` compliance is built in, not claimed: run with
 * `--controls` and the harness re-runs the whole eval under four deliberate
 * mutations that MUST drive the score down. A harness that scores the same with
 * the matcher broken is measuring nothing.
 */
import { readFile } from "node:fs/promises";
import { buildIndex, search, normalize } from "./fuzzy.mjs";
import { PRODUCTION_QUERIES, UNGRADABLE } from "./queries.mjs";

/** want = significant words that MUST all appear in a matching title (normalized). */


const hit = (rows, want, n) =>
  rows.slice(0, n).some((r) => { const t = normalize(r.title + " " + (r.channelTitle ?? "")); return want.every((w) => t.includes(w)); });

function evaluate(index, searchFn, label, { verbose = false } = {}) {
  const byKind = {};
  let h1 = 0, h5 = 0, h10 = 0;
  const misses = [];
  for (const c of PRODUCTION_QUERIES) {
    const rows = searchFn(index, c.q, 10);
    const a = hit(rows, c.want, 1), b = hit(rows, c.want, 5), d = hit(rows, c.want, 10);
    h1 += a; h5 += b; h10 += d;
    byKind[c.kind] ??= { n: 0, h5: 0 };
    byKind[c.kind].n++; byKind[c.kind].h5 += b;
    if (!d) misses.push(c.q);
    if (verbose) console.log(`${d ? (b ? (a ? "hit@1 " : "hit@5 ") : "hit@10") : "MISS  "} ${c.q.padEnd(32)} -> ${rows[0] ? rows[0].title.slice(0, 66) : "(no results)"}`);
  }
  const n = PRODUCTION_QUERIES.length;
  const pct = (x) => `${((x / n) * 100).toFixed(0)}%`;
  console.log(`\n[${label}] n=${n}  hit@1 ${h1} (${pct(h1)})  hit@5 ${h5} (${pct(h5)})  hit@10 ${h10} (${pct(h10)})`);
  for (const [k, v] of Object.entries(byKind)) console.log(`   ${k.padEnd(9)} hit@5 ${v.h5}/${v.n}`);
  if (misses.length) console.log(`   misses: ${misses.join(" | ")}`);
  return { h1, h5, h10, n };
}

const main = async () => {
  const rows = (await readFile(process.argv[2], "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  console.log(`index: ${rows.length} videos, ${new Set(rows.map((r) => r.channelTitle)).size} channels`);
  const index = buildIndex(rows);

  const t0 = performance.now();
  for (const c of PRODUCTION_QUERIES) search(index, c.q, 10);
  const perQuery = (performance.now() - t0) / PRODUCTION_QUERIES.length;

  const base = evaluate(index, search, "LOCAL FUZZY INDEX", { verbose: true });
  console.log(`\nlatency: ${perQuery.toFixed(1)} ms/query in-process over ${rows.length} rows (single thread, no index structure)`);
  console.log(`ungradable production strings (excluded, a human cannot tell either): ${UNGRADABLE.length}`);

  if (!process.argv.includes("--controls")) return;

  console.log(`\n\n======== PROVE-THE-TEST-CAN-FAIL CONTROLS ========`);
  console.log(`Each control breaks the matcher on purpose. The score MUST drop.`);
  console.log(`A control that scores like the baseline means the harness measures nothing.\n`);

  // C1 — negative control: empty index. Must be 0.
  evaluate(buildIndex([]), search, "C1 empty index (must be 0%)");

  // C2 — negative control: ranking replaced by a fixed slice of the index.
  const c2 = (idx, _q, n) => idx.slice(0, n);
  evaluate(index, c2, "C2 no matching at all, first N rows (must be ~0%)");

  // C3 — mutation: exact-substring matching only, i.e. what the product does
  // TODAY against a cache. Kills partial + typo tolerance.
  const c3 = (idx, q, n) => { const nq = normalize(q).replace(/\bkaraoke\b/g, "").trim();
    return idx.filter((r) => normalize(r.title).includes(nq)).slice(0, n); };
  evaluate(index, c3, "C3 substring-only (the naive baseline)");

  // C4 — mutation: diacritic stripping removed. Must hurt the accent bucket.
  const c4 = (idx, q, n) => { const nq = q.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").trim();
    return idx.filter((r) => r.title.toLowerCase().includes(nq)).slice(0, n); };
  evaluate(index, c4, "C4 no diacritic folding + substring (must hurt accents)");
};
main().catch((e) => { console.error(e); process.exit(1); });
