const { chromium } = require("/Users/paulosalvatore/Documents/GitHub/boraoke/node_modules/@playwright/test");
const fs = require("fs");
const BASE = "https://boraoke.com";
const ROOM = "t125-prod-verify-throwaway";
const EV = "/Users/paulosalvatore/Documents/GitHub/boraoke/work/evidence/TICKET-126/prod-verify";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const out = (s) => { console.log(s); log.push(s); };
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "pt-BR" });
  const page = await ctx.newPage();
  const answers = [];
  page.on("response", async (r) => {
    if (r.url().includes("/api/search")) {
      const u = new URL(r.url());
      let b = ""; try { b = await r.text(); } catch {}
      let j = {}; try { j = JSON.parse(b); } catch {}
      answers.push({ q: u.searchParams.get("q"), v: u.searchParams.get("v"), live: u.searchParams.get("live") === "1", status: r.status(), source: j.source, n: (j.results || []).length, liveRequired: j.liveRequired, degraded: j.degraded, reason: j.reason, deferred: j.deferred });
    }
  });
  await page.goto(`${BASE}/${ROOM}`, { timeout: 90000 });
  const search = page.locator("#song-search-input");
  if (!(await search.isVisible().catch(() => false))) {
    const nick = page.locator("#nickname-input");
    await nick.waitFor({ timeout: 60000 });
    await nick.fill("ProdVerify126");
    await nick.press("Enter");
  }
  await search.waitFor({ timeout: 60000 });
  // 1) index song, typed, no Enter
  await search.click();
  await page.keyboard.type("evidencias", { delay: 60 });
  await sleep(4000);
  await page.screenshot({ path: `${EV}/01-index-typed-evidencias.png` });
  const a1 = answers.slice();
  out("STEP1 index typing responses: " + JSON.stringify(a1));
  out(`STEP1 live calls: ${a1.filter((a) => a.live).length}; rows with results: ${a1.filter((a) => a.n > 0).length}`);
  // 2) likely index miss + Enter
  await search.fill("");
  await sleep(500);
  const mark = answers.length;
  await page.keyboard.type("hermeto pascoal bebe ao vivo montreux", { delay: 40 });
  await sleep(1500);
  await page.keyboard.press("Enter");
  await sleep(8000);
  await page.screenshot({ path: `${EV}/02-index-miss-enter.png` });
  const a2 = answers.slice(mark);
  out("STEP2 responses: " + JSON.stringify(a2));
  const live2 = a2.filter((a) => a.live);
  out(`STEP2 live calls: ${live2.length}; live with results: ${live2.filter((a) => a.n > 0).length}`);
  const body = await page.locator("body").innerText();
  out(`STEP2 personal-limit copy present: ${/neste aparelho ou nesta rede/i.test(body)}; daily-limit copy: ${/limite de buscas de hoje/i.test(body)}`);
  // 3) v=2 index-only probe via API
  const uuid = "123e4567-e89b-42d3-a456-000000126126";
  const r = await page.request.get(`${BASE}/api/search?q=${encodeURIComponent("evidencias")}&uuid=${uuid}&v=2&room=${ROOM}`);
  const rb = await r.text();
  out(`STEP3 /api/search v=2 index-only: status ${r.status()} body ${rb.slice(0, 300)}`);
  const r2 = await page.request.get(`${BASE}/api/search?q=${encodeURIComponent("zzqx unlikely miss 126")}&uuid=${uuid}&v=2&room=${ROOM}`);
  out(`STEP3b /api/search v=2 index-only miss: status ${r2.status()} body ${(await r2.text()).slice(0, 300)}`);
  out(`TOTAL live calls this run: ${answers.filter((a) => a.live).length}`);
  fs.writeFileSync(`${EV}/run-log.txt`, log.join("\n") + "\n");
  await browser.close();
})().catch((e) => { console.error(e); fs.writeFileSync(`${EV}/run-error.txt`, String(e.stack || e)); process.exit(1); });
