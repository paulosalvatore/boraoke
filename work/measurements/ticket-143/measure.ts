/**
 * TICKET-143 measurement: kind precision and song+artist exact match of
 * lib/karaoke-index/title-parser.ts on the hand-labelled sample.
 *
 *   npm run measure:t143 [-- <other-labelled.json>]
 *
 * The default sample is local only (YouTube API data, gitignored). When it is
 * absent the script exits 2 with a regenerate note.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { score, type LabelledRow } from "./score";

const file = process.argv[2] ?? join(__dirname, "labelled-sample.json");
if (!existsSync(file)) {
  console.error(
    `${file} not found. The labelled sample is YouTube API data and is never committed (.gitignore);\n` +
      "regenerate it locally from a fresh production search capture and label it before measuring.",
  );
  process.exit(2);
}
const doc = JSON.parse(readFileSync(file, "utf8")) as { rows: LabelledRow[] };
const s = score(doc.rows);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
console.log(`sample: ${file}`);
console.log(`rows: ${s.rows}`);
console.log(`kind precision (strict, all rows): ${s.kindCorrect}/${s.rows} = ${pct(s.kindAccuracy)}`);
for (const [k, v] of Object.entries(s.kindPrecision)) {
  console.log(`  predicted ${k}: ${v!.correct}/${v!.predicted} correct`);
}
console.log(
  `song+artist exact: ${s.saExact}/${s.saRows} = ${pct(s.saAccuracy)}  (song ${s.songExact}/${s.saRows}, artist ${s.artistExact}/${s.saRows}; ${s.rows - s.saRows} rows marked skipSongArtist)`,
);
if (process.argv.includes("--misses")) {
  for (const m of s.misses) console.log(`  MISS ${m.title}  [${m.channelTitle}]\n       want ${m.want}\n       got  ${m.got}`);
}
