// TICKET-127 prod smoke on https://boraoke.com (headless). Read-only: no writes, no searches.
const { createRequire } = require("module");
const req = createRequire("/Users/paulosalvatore/Documents/GitHub/boraoke/package.json");
const { chromium } = req("playwright");
const fs = require("fs");
const BASE = "https://boraoke.com";
const ROOM = "t125-prod-verify-throwaway";
const OUT = __dirname;
const result = { at: new Date().toISOString(), base: BASE, room: ROOM, checks: {}, searchRequests: [], queueResponses: [], pageErrors: [] };
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/search") || u.pathname.startsWith("/api/videos")) result.searchRequests.push(r.url()); });
  page.on("response", async (r) => { const u = new URL(r.url()); if (u.pathname === "/api/queue") { let n = null; try { const b = await r.json(); n = Array.isArray(b.items) ? b.items.length : null; } catch {} result.queueResponses.push({ url: r.url(), status: r.status(), items: n }); } });
  page.on("pageerror", (e) => result.pageErrors.push(String(e)));

  let r = await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  result.checks.home = { status: r.status(), title: await page.title() };
  await page.screenshot({ path: `${OUT}/01-home.png` });

  r = await page.goto(`${BASE}/${ROOM}`, { waitUntil: "domcontentloaded" });
  await page.waitForResponse((x) => new URL(x.url()).pathname === "/api/queue", { timeout: 20000 }).catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  result.checks.patron = { status: r.status(), url: page.url() };
  await page.screenshot({ path: `${OUT}/02-patron.png`, fullPage: true });

  const api = await ctx.request.get(`${BASE}/api/queue?room=${ROOM}`);
  const body = await api.json().catch(() => null);
  result.checks.apiQueue = { status: api.status(), keys: body ? Object.keys(body) : null, items: body && Array.isArray(body.items) ? body.items.length : null, mode: body && body.mode, moderation: body && body.moderation, paused: body && body.paused };
  fs.writeFileSync(`${OUT}/api-queue.json`, JSON.stringify(body, null, 2));

  r = await page.goto(`${BASE}/${ROOM}/tv`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(2000);
  result.checks.tv = { status: r.status(), url: page.url() };
  await page.screenshot({ path: `${OUT}/03-tv.png` });

  await browser.close();
  fs.writeFileSync(`${OUT}/smoke-result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
