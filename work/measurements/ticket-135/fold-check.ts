/**
 * TICKET-135 measurement — which real production queries does the folded cache
 * key merge, and can a merge change what the patron is graded on?
 *
 * The cache serves the FIRST variant's YouTube page to every variant that
 * shares its key. The real check would replay the TICKET-124/125 harness with
 * the fold, but its inputs (the TICKET-108 production oracle and the TICKET-124
 * index fixture) are YouTube API data, gitignored and absent from this
 * checkout. So this script answers the part that needs no API data:
 *
 *   1. Over every published production string (the 32 graded + 20 ungradable
 *      queries in work/measurements/ticket-108/queries.ts, all real `sc:BR::`
 *      keys), list the keys the fold merges that the old key kept apart.
 *   2. For each merge, compare the graded `want` of its members. Identical
 *      `want` means every member is graded against the same truth, so serving
 *      one member's page to another can only change hit@10 if that page misses.
 *   3. List any merge whose members are ALSO in one TICKET-125 keystroke trace
 *      (the replay groups by normalizeQuery). There the shipped client already
 *      served the first member's held page to the second (planSearch filter),
 *      so the fold changes nothing the harness measured.
 *
 * Zero search.list calls. Run:  npm run measure:t135
 */
import { PRODUCTION_QUERIES, UNGRADABLE } from "../ticket-108/queries";
import { foldSearchKey, normalizeQuery } from "../../../lib/search-prefix";

function oldKey(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

const all = [...PRODUCTION_QUERIES.map((g) => g.q), ...UNGRADABLE];
const want = new Map(PRODUCTION_QUERIES.map((g) => [g.q, g.want.join("+")]));

const byNew = new Map<string, string[]>();
for (const q of all) {
  const k = foldSearchKey(q) || oldKey(q);
  byNew.set(k, [...(byNew.get(k) ?? []), q]);
}

const oldDistinct = new Set(all.map(oldKey)).size;
console.log("TICKET-135 fold check over the published production strings");
console.log(`strings: ${all.length} (graded ${PRODUCTION_QUERIES.length}, ungradable ${UNGRADABLE.length})`);
console.log(`distinct cache keys: old ${oldDistinct} -> folded ${byNew.size}`);
console.log("");
let merges = 0;
for (const [k, qs] of byNew) {
  const oldKeys = new Set(qs.map(oldKey));
  if (oldKeys.size < 2) continue;
  merges++;
  const wants = qs.map((q) => want.get(q) ?? "(ungradable)");
  const sameWant = new Set(wants).size === 1;
  const sameTrace = new Set(qs.map(normalizeQuery)).size === 1;
  console.log(`MERGE "${k}"`);
  for (let i = 0; i < qs.length; i++) console.log(`   ${JSON.stringify(qs[i]).padEnd(28)} want=${wants[i]}`);
  console.log(`   same graded want: ${sameWant ? "yes" : "NO"}   same TICKET-125 trace (normalizeQuery equal): ${sameTrace ? "yes" : "NO"}`);
}
console.log("");
console.log(`merges: ${merges}`);
