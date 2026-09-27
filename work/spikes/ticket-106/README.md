# TICKET-106 spike prototype

Smallest slice that proves the harvested-index approach returns REAL results, and
measures its hit rate against REAL production patron queries. Findings live in
`work/reports/TICKET-106-spike.md`; this directory is the code those numbers came from.

**Nothing here is production code.** No dependency is added to the product, and
`harvest.mjs` carries a hard guard (`assertNoSearchList`) that refuses any URL
whose path contains "search" — the prototype cannot spend the 100/day
`search.list` bucket even by mistake.

## Files

| File | What it does |
|---|---|
| `harvest.mjs` | Builds the index using ONLY `videos.list` / `channels.list` / `playlistItems.list` (1 unit each, against the ~10,000/day pool boraoke barely touches). |
| `fuzzy.mjs` | Local matcher: diacritic folding, noise-token stripping, token prefix matching, bounded Levenshtein. Zero dependencies. |
| `queries.mjs` | The test set. Every query was typed by a real patron in production (present verbatim as an `sc:BR::<q>` cache key); ground truth comes from the longest member of the same keystroke family. Also lists the 20 real strings excluded as ungradable. |
| `eval.mjs` | Scores hit@1/5/10 by query shape. `--controls` runs four deliberate mutations that must drive the score down (`prove-your-test-can-fail`). |
| `diagnose.mjs` | Splits every miss into COVERAGE-miss (song absent — only more harvesting helps) vs RANKING-miss (present but not surfaced — fixable in code). This distinction is what decides the fix. |

## Reproducing

```bash
# seeds.json: { "<channelTitle>": "<a videoId from that channel>", ... }
YOUTUBE_API_KEY=… node harvest.mjs seeds.json index.jsonl 1200
node eval.mjs index.jsonl --controls
node diagnose.mjs index.jsonl
```

Measured: 60 channels / 36,372 videos for **741 units** and **zero** `search.list` calls;
hit@10 66% against 32 real production queries; 91 ms/query in-process (naive linear scan).
