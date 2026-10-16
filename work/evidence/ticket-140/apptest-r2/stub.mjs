// Local YouTube stub for the TICKET-140 app test (loopback only). Mirrors the e2e stub mechanism.
import http from "node:http";
const PORT = 4140;
const ok = (id) => id.startsWith("apOk") || id === "dQw4w9WgXcQ";
const title = (id) => `Música Teste ${id}`;
const send = (res, s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seen = [];
http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (u.pathname === "/__seen") return send(res, 200, seen);
  if (u.pathname === "/youtube/v3/videos") {
    const id = u.searchParams.get("id"); seen.push({ api: id, key: u.searchParams.get("key") });
    if (id === "apSlow00001") await sleep(4000);
    if (ok(id) || id === "apSlow00001") return send(res, 200, { items: [{ id, status: { embeddable: true }, snippet: { title: title(id), channelTitle: "Canal Teste" }, contentDetails: { duration: "PT3M27S" } }] });
    if (id.startsWith("apBlock")) return send(res, 200, { items: [{ id, status: { embeddable: false }, snippet: { title: "Blocked", channelTitle: "X" } }] });
    return send(res, 500, {});
  }
  if (u.pathname === "/oembed") {
    const id = new URL(u.searchParams.get("url") || "https://x/").searchParams.get("v"); seen.push({ oembed: id });
    if (id === "apSlow00001") await sleep(4000);
    if (ok(id) || id === "apSlow00001") return send(res, 200, { title: title(id), author_name: "Canal Teste" });
    if (id.startsWith("apBlock")) return send(res, 401, {});
    return send(res, 503, {});
  }
  send(res, 404, {});
}).listen(PORT, "127.0.0.1", () => console.log("stub up", PORT));
