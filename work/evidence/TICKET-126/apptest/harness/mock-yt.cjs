// Server-side network-layer mock of the YouTube Data API (sandbox key, no real call).
const fs = require("fs");
const LOG = process.env.MOCK_YT_LOG;
const orig = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = typeof input === "string" ? input : input.url || String(input);
  if (url.startsWith("https://www.googleapis.com/youtube/v3/")) {
    const u = new URL(url);
    const kind = u.pathname.endsWith("/search") ? "search.list" : "videos.list";
    if (LOG) fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), kind, q: u.searchParams.get("q") }) + "\n");
    let body;
    if (kind === "search.list") {
      await new Promise((r) => setTimeout(r, Number(process.env.MOCK_YT_DELAY || 1500)));
      const q = u.searchParams.get("q") || "";
      let h = 0; for (const c of q) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      body = { items: Array.from({ length: 10 }, (_, i) => ({ id: { videoId: ("L" + String(i).padStart(2, "0") + h.toString(36).padStart(8, "0")).slice(0, 11) }, snippet: { title: `MOCK LIVE ${i + 1} for ${q}`, channelTitle: "Mock Channel", thumbnails: {} } })) };
    } else {
      const ids = (u.searchParams.get("id") || "").split(",");
      body = { items: ids.map((id) => ({ id, contentDetails: { duration: "PT3M30S" } })) };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  return orig(input, init);
};
