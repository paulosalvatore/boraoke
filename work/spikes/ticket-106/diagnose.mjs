/**
 * Splits every miss into the only two causes that matter for the decision:
 *   COVERAGE-MISS — the song is not in the index at all. No matcher can fix it;
 *                   only harvesting more channels can. Falls through to search.list.
 *   RANKING-MISS  — the song IS in the index but the matcher failed to surface it
 *                   in the top 10. A matcher problem, fixable in code for free.
 * Conflating these is how a spike recommends the wrong fix.
 */
import { readFile } from "node:fs/promises";
import { buildIndex, search, normalize } from "./fuzzy.mjs";
const { PRODUCTION_QUERIES } = await import("./queries.mjs");

const rows = (await readFile(process.argv[2], "utf8")).trim().split("\n").map((l) => JSON.parse(l));
const index = buildIndex(rows);
const norm = rows.map((r) => ({ r, n: normalize(r.title + " " + (r.channelTitle ?? "")) }));

let cov = 0, rank = 0, ok = 0;
const covList = [], rankList = [];
for (const c of PRODUCTION_QUERIES) {
  const top = search(index, c.q, 10);
  const found = top.some((r) => { const t = normalize(r.title + " " + (r.channelTitle ?? "")); return c.want.every((w) => t.includes(w)); });
  if (found) { ok++; continue; }
  const present = norm.filter((x) => c.want.every((w) => x.n.includes(w)));
  if (present.length === 0) { cov++; covList.push(c.q); }
  else { rank++; rankList.push(`${c.q}  (index HAS ${present.length}, e.g. "${present[0].r.title.slice(0, 60)}")`); }
}
console.log(`index: ${rows.length} videos / ${new Set(rows.map((r) => r.channelTitle)).size} channels`);
console.log(`\nhit@10        : ${ok}/${PRODUCTION_QUERIES.length} (${((ok / PRODUCTION_QUERIES.length) * 100).toFixed(0)}%)`);
console.log(`COVERAGE-MISS : ${cov}  <- song absent from index; only more harvesting helps`);
covList.forEach((q) => console.log(`    ${q}`));
console.log(`RANKING-MISS  : ${rank}  <- song present, matcher failed; fixable in code for free`);
rankList.forEach((q) => console.log(`    ${q}`));
