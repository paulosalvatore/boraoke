/**
 * TICKET-106 spike prototype — STEP 1 of 3: harvest a karaoke index using ONLY
 * the endpoints that bill against the ~10,000-unit/day pool boraoke barely
 * touches. It spends ZERO `search.list` calls, by construction: this file never
 * builds a `search` URL, and `assertNoSearchList()` below refuses any URL whose
 * path contains "search".
 *
 * Unit ledger (1 unit per call, all against the 10k pool):
 *   videos.list        — resolve seed videoIds -> channelIds       (1 per 50 ids)
 *   channels.list      — channelId -> uploads playlist id          (1 per 50 ids)
 *   playlistItems.list — harvest up to 50 video rows per call      (1 per page)
 *
 * The seed videoIds come from Boraoke's own PRODUCTION search cache, i.e. the
 * channels YouTube search itself already surfaces for real Brazilian karaoke
 * queries — so the index is built from what patrons actually get shown, not from
 * a guess at which channels matter.
 *
 * Run: YOUTUBE_API_KEY=… node harvest.mjs <seeds.json> <out.jsonl> [maxUnits]
 */

const KEY = process.env.YOUTUBE_API_KEY;
if (!KEY) { console.error("YOUTUBE_API_KEY missing"); process.exit(2); }

let units = 0;
let MAX_UNITS = Number(process.argv[4] || 300);

function assertNoSearchList(url) {
  // Hard guard, not a comment: this prototype must never touch the 100/day bucket.
  const p = new URL(url).pathname;
  if (/search/i.test(p)) throw new Error(`REFUSED: ${p} would spend the search.list bucket`);
}

async function api(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", KEY);
  assertNoSearchList(url.toString());
  if (units >= MAX_UNITS) throw new Error(`unit budget ${MAX_UNITS} exhausted`);
  units++;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${endpoint} HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function main() {
  const seeds = JSON.parse(await (await import("node:fs/promises")).readFile(process.argv[2], "utf8"));
  const outPath = process.argv[3];
  const fs = await import("node:fs/promises");

  // 1. seed videoIds -> channelIds (1 unit per 50)
  const ids = Object.values(seeds);
  const channels = new Map(); // channelId -> channelTitle
  for (const c of chunk(ids, 50)) {
    const r = await api("videos", { part: "snippet", id: c.join(",") });
    for (const it of r.items ?? []) channels.set(it.snippet.channelId, it.snippet.channelTitle);
  }
  console.error(`resolved ${channels.size} channelIds (${units} units so far)`);

  // 2. channelIds -> uploads playlist ids (1 unit per 50)
  const uploads = []; // { channelTitle, playlistId }
  for (const c of chunk([...channels.keys()], 50)) {
    const r = await api("channels", { part: "contentDetails,snippet", id: c.join(",") });
    for (const it of r.items ?? []) {
      const pl = it.contentDetails?.relatedPlaylists?.uploads;
      if (pl) uploads.push({ channelTitle: it.snippet.title, channelId: it.id, playlistId: pl });
    }
  }
  console.error(`resolved ${uploads.length} uploads playlists (${units} units so far)`);

  // 3. harvest playlistItems (1 unit per page of <=50)
  const out = [];
  const perChannel = {};
  for (const u of uploads) {
    let pageToken = "", pages = 0, got = 0;
    // Bound per channel so one huge channel cannot eat the whole budget.
    const MAX_PAGES_PER_CHANNEL = 14; // <=700 videos/channel
    while (pages < MAX_PAGES_PER_CHANNEL && units < MAX_UNITS) {
      let r;
      try {
        r = await api("playlistItems", {
          part: "snippet,contentDetails", playlistId: u.playlistId,
          maxResults: "50", ...(pageToken ? { pageToken } : {}),
        });
      } catch (e) { console.error(`  ${u.channelTitle}: ${e.message}`); break; }
      for (const it of r.items ?? []) {
        const vid = it.contentDetails?.videoId;
        const title = it.snippet?.title;
        if (!vid || !title || title === "Private video" || title === "Deleted video") continue;
        out.push({ videoId: vid, title, channelTitle: u.channelTitle, channelId: u.channelId,
                   publishedAt: it.contentDetails?.videoPublishedAt ?? null });
        got++;
      }
      pages++;
      pageToken = r.nextPageToken ?? "";
      if (!pageToken) break;
    }
    perChannel[u.channelTitle] = got;
    console.error(`  ${u.channelTitle}: ${got} videos in ${pages} calls (${units} units)`);
  }

  await fs.writeFile(outPath, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.error(`\n=== HARVEST DONE ===`);
  console.error(`videos indexed: ${out.length}`);
  console.error(`distinct videoIds: ${new Set(out.map((r) => r.videoId)).size}`);
  console.error(`UNITS CONSUMED: ${units} (of the 10,000/day pool; search.list spent: 0)`);
  console.error(`per channel: ${JSON.stringify(perChannel, null, 1)}`);
}
main().catch((e) => { console.error("FATAL:", e.message, `(units consumed: ${units})`); process.exit(1); });
