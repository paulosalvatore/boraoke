// TICKET-126 App Tester harness: headless Playwright vs next dev :3126.
// Server: STORE_DRIVER=memory, device cap 2, IP cap 3, fake sandbox key, server-side fetch mock of googleapis.
const WT = "/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t126-search-limits";
const { chromium } = require(WT + "/node_modules/@playwright/test");
const fs = require("fs");
const BASE = "http://127.0.0.1:3126";
const EV = WT + "/work/evidence/TICKET-126/apptest";
const YTLOG = process.env.YTLOG;
const LOCALES = (process.env.LOCALES || "pt-BR,en,es").split(",");
const VPS = (process.env.VPS || "phone,desktop").split(",");
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const VP = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  narrow: { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { viewport: { width: 1280, height: 800 } },
};
const PERSONAL = { "pt-BR": /neste aparelho ou nesta rede/i, en: /on this device or network/i, es: /en este dispositivo o en esta red/i };
const DAILY = { "pt-BR": /limite de buscas de hoje/i, en: /Today's search limit is reached/i, es: /límite de búsquedas de hoy/i };
const OUTAGE = { "pt-BR": /Busca indisponível/i, en: /Search is down/i, es: /La búsqueda no está disponible/i };
const FORBID = /cobran|fatura|billing|bill\b|billed|quota|cota\b|cuota|cost|custo|coste|\$|R\$|pag(o|ar|amento)|paid|pay\b/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipSeq = 10 + Math.floor(Math.random() * 20000);
const nextIp = () => `10.126.${Math.floor(ipSeq / 200)}.${(ipSeq++ % 200) + 1}`;
const RUN = Math.random().toString(36).slice(2, 6);
const results = [];
const verdict = (name, ok, d) => { results.push({ name, ok, d }); console.log(`  => ${ok ? "PASS" : "FAIL"} ${name}${d ? " — " + d : ""}`); };
const ytCalls = () => (YTLOG && fs.existsSync(YTLOG) ? fs.readFileSync(YTLOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const shot = (page, name) => page.screenshot({ path: `${EV}/${name}.png` });

async function newPage(browser, locale, vp, { ip = nextIp(), mockFn } = {}) {
  const ctx = await browser.newContext({ ...VP[vp], locale, extraHTTPHeaders: { "x-forwarded-for": ip } });
  await ctx.addCookies([{ name: "NEXT_LOCALE", value: locale, url: BASE }]);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  const answers = [];
  page.on("response", async (r) => {
    if (r.url().includes("/api/search")) {
      const u = new URL(r.url());
      let b = ""; try { b = (await r.text()).slice(0, 80); } catch {}
      answers.push({ q: u.searchParams.get("q"), live: u.searchParams.get("live") === "1", status: r.status(), body: b });
    }
  });
  if (mockFn) await page.route("**/api/search**", mockFn);
  await page.goto(BASE + "/default", { timeout: 120000 });
  const search = page.locator("#song-search-input");
  if (!(await search.isVisible().catch(() => false))) {
    const nick = page.locator("#nickname-input");
    await nick.waitFor({ timeout: 90000 });
    await nick.fill("AppTester");
    await nick.press("Enter");
  }
  await search.waitFor({ timeout: 90000 });
  return { ctx, page, search, errs, answers };
}
async function liveSearch(page, search, text) {
  await search.click();
  await search.fill("");
  await page.keyboard.type(text, { delay: 40 });
  await sleep(1300);
  await page.keyboard.press("Enter");
}
const scrollFit = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const SC = {
  // 1+2: device cap 2 -> third distinct live search is personal-limit; index + paste-link still work.
  async capped(b, L, V) {
    const tag = `${L}-${V}`;
    const { ctx, page, search, errs, answers } = await newPage(b, L, V);
    const before = ytCalls().filter((c) => c.kind === "search.list").length;
    await liveSearch(page, search, `lima ${L} ${V} alfa ${RUN}`);
    await page.locator("[data-testid=search-results-mode]").waitFor({ timeout: 30000 }).catch(() => {});
    await sleep(2300); // clear the 2 s live cooldown between searches
    await liveSearch(page, search, `lima ${L} ${V} beta ${RUN}`);
    await sleep(4500);
    await shot(page, `${tag}-1-second-live-results`);
    await sleep(2300);
    await liveSearch(page, search, `lima ${L} ${V} gama ${RUN}`);
    const notice = page.getByTestId("search-degraded");
    await notice.waitFor({ timeout: 30000 }).catch(() => {});
    const txt = (await notice.textContent().catch(() => "")) || "";
    await shot(page, `${tag}-2-third-live-personal-limit`);
    const billed = ytCalls().filter((c) => c.kind === "search.list").length - before;
    verdict(`${tag} personal-limit copy after 2 live (cap 2)`, PERSONAL[L].test(txt) && !OUTAGE[L].test(txt) && !FORBID.test(txt), `text="${txt}" billedCalls=${billed} (expect 2) answers=${answers.filter((a) => a.live).map((a) => a.body.slice(0, 40)).join(" | ")}`);
    verdict(`${tag} no billing/quota/cost words, no outage copy`, !FORBID.test(txt) && !OUTAGE[L].test(txt), "");
    verdict(`${tag} exactly 2 billed search.list`, billed === 2, `billed=${billed}`);
    verdict(`${tag} no horizontal overflow while capped`, await scrollFit(page), "");
    // 2a index while capped
    await search.fill("");
    await page.keyboard.type("evidencias", { delay: 40 });
    const idx = page.locator("[data-testid=search-results-mode]");
    await page.getByText(/Evidencias karaoke versao 1/).first().waitFor({ timeout: 20000 }).catch(() => {});
    const idxVisible = await page.getByText(/Evidencias karaoke versao 1/).first().isVisible().catch(() => false);
    await shot(page, `${tag}-3-capped-index-results`);
    verdict(`${tag} capped: karaoke-index rows still appear while typing`, idxVisible, "");
    // 2b paste link + Enter queues
    await search.fill("");
    await search.fill("https://youtu.be/dQw4w9WgXcQ");
    await page.getByText(/dQw4w9WgXcQ/).first().waitFor({ timeout: 8000 }).catch(() => {});
    await shot(page, `${tag}-4-capped-paste-link-selected`);
    await search.press("Enter");
    await sleep(3500);
    const rows = await page.locator("[data-testid=queue-row]").count();
    const pend = await page.locator("[data-testid=patron-pending-waiting]").count();
    const body = await page.locator("body").innerText();
    await shot(page, `${tag}-5-capped-paste-link-queued`);
    verdict(`${tag} capped: pasted youtu.be + Enter queues`, rows > 0 || pend > 0 || /dQw4w9WgXcQ|na fila|in the queue|en la cola/i.test(body), `queueRows=${rows} pending=${pend}`);
    const real = errs.filter((e) => !/favicon|404/.test(e));
    if (real.length) console.log("  console errors: " + real.join(" | "));
    await ctx.close();
  },
  // 3: platform daily-limit copy (route-mocked reason).
  async daily(b, L, V) {
    const tag = `${L}-${V}`;
    const { ctx, page, search } = await newPage(b, L, V, {
      mockFn: (r) => (new URL(r.request().url()).searchParams.get("live") === "1" ? r.fulfill({ json: { degraded: true, reason: "daily-limit", results: [] } }) : r.fulfill({ json: { results: [], liveRequired: true } })),
    });
    await liveSearch(page, search, `lima platform ${RUN}`);
    const notice = page.getByTestId("search-degraded");
    await notice.waitFor({ timeout: 20000 }).catch(() => {});
    const txt = (await notice.textContent().catch(() => "")) || "";
    await shot(page, `${tag}-6-platform-daily-limit`);
    verdict(`${tag} platform daily-limit shows its own copy`, DAILY[L].test(txt) && !PERSONAL[L].test(txt), `text="${txt}"`);
    await ctx.close();
  },
  // 4: copy fit at 320 (route-mocked personal-limit; real-flow copy proven in `capped`).
  async narrow(b, L) {
    const tag = `${L}-narrow320`;
    const { ctx, page, search } = await newPage(b, L, "narrow", {
      mockFn: (r) => (new URL(r.request().url()).searchParams.get("live") === "1" ? r.fulfill({ json: { degraded: true, reason: "personal-limit", results: [] } }) : r.fulfill({ json: { results: [], liveRequired: true } })),
    });
    await liveSearch(page, search, `lima narrow ${RUN}`);
    const notice = page.getByTestId("search-degraded");
    await notice.waitFor({ timeout: 20000 }).catch(() => {});
    const box = await notice.boundingBox();
    const fit = await scrollFit(page);
    await shot(page, `${tag}-7-personal-limit-320px`);
    verdict(`${tag} personal-limit copy fits 320px, no overflow`, !!box && box.x >= 0 && box.x + box.width <= 321 && fit, `box=${JSON.stringify(box)} noHScroll=${fit}`);
    await ctx.close();
  },
  // 5: single-flight UX: two tabs (different devices+IPs), same live query at once.
  async flight(b, L, V) {
    const tag = `${L}-${V}`;
    const q = `lima flight ${L} ${V} unico ${RUN}`;
    const A = await newPage(b, L, V), B = await newPage(b, L, V);
    const before = ytCalls().filter((c) => c.kind === "search.list" && c.q && c.q.includes(`flight ${L} ${V}`)).length;
    await Promise.all([A, B].map(async (t) => { await t.search.click(); await t.search.fill(""); await t.page.keyboard.type(q, { delay: 30 }); }));
    await sleep(1300);
    await Promise.all([A, B].map((t) => t.page.keyboard.press("Enter")));
    await sleep(9000);
    const res = await Promise.all([A, B].map(async (t) => ({ ok: await t.page.getByText(/MOCK LIVE 1 for/).first().isVisible().catch(() => false), degraded: await t.page.getByTestId("search-degraded").isVisible().catch(() => false), err: await t.page.getByText(/erro|error|falhou|failed/i).count() })));
    await shot(A.page, `${tag}-8-singleflight-tabA`);
    await shot(B.page, `${tag}-9-singleflight-tabB`);
    const billed = ytCalls().filter((c) => c.kind === "search.list" && c.q && c.q.includes(`flight ${L} ${V}`)).length - before;
    verdict(`${tag} single-flight: both tabs get results, no error`, res.every((r) => r.ok && !r.degraded), JSON.stringify(res) + ` answersA=${A.answers.filter((a) => a.live).map((a) => a.body.slice(0, 30))} answersB=${B.answers.filter((a) => a.live).map((a) => a.body.slice(0, 30))}`);
    verdict(`${tag} single-flight: one billed search.list for the pair`, billed === 1, `billed=${billed}`);
    await A.ctx.close(); await B.ctx.close();
  },
};

(async () => {
  const b = await chromium.launch({ headless: true });
  for (const L of LOCALES) {
    for (const V of VPS) {
      for (const name of ["capped", "daily", "flight"]) {
        if (ONLY && !ONLY.includes(name)) continue;
        if (name === "flight" && V !== "desktop") continue;
        console.log(`\n[${L} ${V}] ${name}`);
        try { await SC[name](b, L, V); } catch (e) { verdict(`${L}-${V} ${name} (harness)`, false, e.message.split("\n")[0]); }
      }
    }
    if (!ONLY || ONLY.includes("narrow")) { console.log(`\n[${L} 320] narrow`); try { await SC.narrow(b, L); } catch (e) { verdict(`${L} narrow (harness)`, false, e.message.split("\n")[0]); } }
  }
  await b.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY ${results.length - fails.length}/${results.length} pass`);
  fails.forEach((f) => console.log("FAILED:", f.name, "-", f.d));
})();
