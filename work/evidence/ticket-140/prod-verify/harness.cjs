const { chromium } = require("/Users/paulosalvatore/Documents/GitHub/boraoke/node_modules/@playwright/test");
const fs = require("fs");
const BASE = "https://boraoke.com";
const ROOM = "t125-prod-verify-throwaway";
const EV = "/Users/paulosalvatore/Documents/GitHub/boraoke/work/evidence/TICKET-140/prod-verify";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const out = (s) => { console.log(s); log.push(s); };
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "pt-BR" });
  const page = await ctx.newPage();
  const answers = [];
  let liveSeen = 0;
  await page.route("**/api/search**", async (route) => {
    const u = new URL(route.request().url());
    if (u.searchParams.get("live") === "1") {
      liveSeen++;
      if (liveSeen > 1) { out("BLOCKED extra live call"); return route.abort(); }
    }
    return route.continue();
  });
  page.on("response", async (r) => {
    if (r.url().includes("/api/search") || r.url().includes("/api/video") || r.url().includes("/api/oembed") || r.url().includes("/api/title")) {
      const u = new URL(r.url());
      let b = ""; try { b = await r.text(); } catch {}
      answers.push({ path: u.pathname, q: u.searchParams.get("q"), live: u.searchParams.get("live") === "1", status: r.status(), body: b.slice(0, 200) });
    }
  });
  await page.goto(`${BASE}/${ROOM}`, { timeout: 90000 });
  const search = page.getByLabel(/Buscar música/i);
  if (!(await search.isVisible().catch(() => false))) {
    await page.getByPlaceholder(/ex\.: Maria/i).waitFor({ timeout: 60000 });
    await page.getByPlaceholder(/ex\.: Maria/i).fill("ProdVerify140");
    await page.getByRole("button", { name: /entrar na fila/i }).click();
  }
  await search.waitFor({ timeout: 60000 });

  // (b) first: type "Imagination" with no Enter
  await search.click();
  await page.keyboard.type("Imagination", { delay: 60 });
  await sleep(5000);
  await page.screenshot({ path: `${EV}/b-imagination-typed.png` });
  const fakeRowB = await page.getByText("Link do YouTube", { exact: true }).count();
  const selectedB = await page.getByText(/Selecionada:/).count();
  const searchesB = answers.filter((a) => a.path === "/api/search" && (a.q || "").toLowerCase().includes("imagination"));
  out(`B searches: ${JSON.stringify(searchesB.map((a) => ({ q: a.q, live: a.live, status: a.status, body: a.body.slice(0, 120) })))}`);
  out(`B fakeLinkRow=${fakeRowB} selected=${selectedB}`);

  // (c) link inside free text
  await search.fill("");
  await sleep(500);
  await search.fill("olha essa https://youtu.be/dQw4w9WgXcQ kkk");
  await sleep(5000);
  await page.screenshot({ path: `${EV}/c-embedded-link.png` });
  const selC = await page.getByText(/Selecionada: dQw4w9WgXcQ/).count();
  const bodyC = await page.locator("body").innerText();
  out(`C selected=${selC} pickerHasRick=${/Rick Astley|Never Gonna Give You Up/i.test(bodyC)}`);

  // (a) plain youtu.be paste, real title in picker then queue
  await search.fill("");
  await sleep(500);
  await search.fill("https://youtu.be/dQw4w9WgXcQ");
  await sleep(6000);
  await page.screenshot({ path: `${EV}/a1-picker-title.png` });
  const bodyA = await page.locator("main, body").first().innerText();
  const pickerTitle = /Never Gonna Give You Up/i.test(bodyA);
  const placeholderA = await page.getByText("Link do YouTube", { exact: true }).count();
  out(`A picker realTitle=${pickerTitle} placeholderRow=${placeholderA} selected=${await page.getByText(/Selecionada: dQw4w9WgXcQ/).count()}`);
  await page.getByRole("button", { name: /adicionar à fila/i }).click();
  await sleep(6000);
  await page.screenshot({ path: `${EV}/a2-queue-title.png`, fullPage: true });
  const q = await (await page.request.get(`${BASE}/api/queue?room=${ROOM}`)).json();
  const entries = (q.items || []).filter((e) => e.videoId === "dQw4w9WgXcQ");
  out(`A queue entries for dQw4w9WgXcQ: ${JSON.stringify(entries.map((e) => ({ title: e.title, channelTitle: e.channelTitle, duration: e.duration, nickname: e.nickname })))}`);
  const bodyQ = await page.locator("body").innerText();
  out(`A patron view realTitle=${/Never Gonna Give You Up/i.test(bodyQ)} fallbackLabel=${/youtu\.be\/dQw4w9WgXcQ/.test(bodyQ)}`);
  out(`OTHER responses: ${JSON.stringify(answers.filter((a) => a.path !== "/api/search"))}`);
  out(`TOTAL live search calls: ${answers.filter((a) => a.live).length} (route-seen ${liveSeen})`);
  fs.writeFileSync(`${EV}/run-log.txt`, log.join("\n") + "\n");
  await browser.close();
})().catch((e) => { console.error(e); fs.writeFileSync(`${EV}/run-error.txt`, String(e.stack || e)); process.exit(1); });
