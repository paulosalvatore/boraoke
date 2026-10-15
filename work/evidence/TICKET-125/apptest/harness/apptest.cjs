// TICKET-125 App Tester harness: headless Playwright against next dev :3135.
// Records every /api/search request with a timestamp relative to the scenario's
// LAST keystroke, so the live=1 timeline is the billing evidence.
const WT = "/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t125-enter-idle-search";
const { chromium } = require(WT + "/node_modules/@playwright/test");
const fs = require("fs");
const BASE = "http://127.0.0.1:3135";
const EV = WT + "/work/evidence/TICKET-125/apptest";
fs.mkdirSync(EV, { recursive: true });

const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const LOCALES = (process.env.LOCALES || "pt-BR,en,es").split(",");
const VIEWPORTS = (process.env.VPS || "phone,desktop").split(",");
const VP = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { viewport: { width: 1280, height: 800 } },
};
const LOADMORE = { "pt-BR": /mais resultados/i, en: /more results/i, es: /más resultados/i };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mockRows = (prefix, n, start = 0) =>
  Array.from({ length: n }, (_, i) => ({
    videoId: (prefix + String(start + i).padStart(11, "0")).slice(-11),
    title: `MOCK live result ${start + i + 1} (${prefix})`,
    channelTitle: "Mock Channel",
    duration: "3:3" + (i % 10),
    thumbnailUrl: "",
  }));

const out = [];
const log = (s) => { out.push(s); console.log(s); };

async function newPage(browser, locale, vp, { mockLive = true, delayIndexMs = 0 } = {}) {
  const ctx = await browser.newContext({ ...VP[vp], locale: locale === "pt-BR" ? "pt-BR" : locale });
  await ctx.addCookies([{ name: "NEXT_LOCALE", value: locale, url: BASE }]);
  const page = await ctx.newPage();
  const reqs = [];
  const consoleErrs = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrs.push(m.text()); });
  page.on("pageerror", (e) => consoleErrs.push("pageerror: " + e.message));
  await page.route("**/api/search**", async (route) => {
    const u = new URL(route.request().url());
    const p = Object.fromEntries(u.searchParams);
    const rec = { at: Date.now(), q: p.q, live: p.live === "1", v: p.v, pageToken: p.pageToken || "" };
    reqs.push(rec);
    if (mockLive && rec.pageToken) {
      return route.fulfill({ json: { results: mockRows("P", 8, 12), nextPageToken: "" } });
    }
    if (mockLive && rec.live) {
      return route.fulfill({ json: { results: mockRows("L", 12), nextPageToken: "MOCKTOKEN" } });
    }
    if (delayIndexMs) await sleep(delayIndexMs);
    try {
      const resp = await route.fetch();
      rec.answer = (await resp.text()).slice(0, 60);
      return route.fulfill({ response: resp, body: undefined });
    } catch (e) { rec.answer = "ERR " + e.message; return route.abort(); }
  });
  // Join once as pt-BR-agnostic: fill nickname via the first text input in the join form.
  await page.goto(BASE + "/default");
  const search = page.locator("#song-search-input");
  if (!(await search.isVisible().catch(() => false))) {
    const nick = page.locator("#nickname-input");
    await nick.waitFor({ timeout: 60000 });
    await nick.fill("AppTester");
    await nick.press("Enter");
  }
  await search.waitFor({ timeout: 60000 });
  return { ctx, page, reqs, consoleErrs, search };
}

async function typeSlow(page, el, text) {
  await el.click();
  await page.keyboard.type(text, { delay: 120 });
  return Date.now();
}

function timeline(reqs, t0) {
  return reqs.map((r) => {
    const dt = ((r.at - t0) / 1000).toFixed(2);
    return `    ${dt.padStart(6)}s  ${r.live ? "LIVE=1" : r.pageToken ? "PAGE  " : "index "}  v=${r.v ?? "-"}  q="${r.q}"${r.pageToken ? " pageToken=" + r.pageToken : ""}${r.answer ? "  -> " + r.answer : ""}`;
  }).join("\n");
}

const results = [];
function verdict(name, ok, detail) {
  results.push({ name, ok, detail });
  log(`  => ${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
const lives = (reqs, after = 0) => reqs.filter((r) => r.live && r.at >= after);
const shot = (page, name) => page.screenshot({ path: `${EV}/${name}.png`, fullPage: false });

const SCENARIOS = {
  // 1. Known song: index rows while typing, never a live=1.
  async indexHit(b, L, V) {
    const { ctx, page, reqs, search, consoleErrs } = await newPage(b, L, V);
    const t0 = await typeSlow(page, search, "evidencias");
    await page.locator("[data-testid=search-results-mode]").waitFor({ timeout: 15000 }).catch(() => {});
    const firstRowAt = Date.now();
    await shot(page, `${L}-${V}-1-indexhit-results`);
    await sleep(10500);
    const hint = await page.locator("[data-testid=search-enter-hint]").isVisible();
    log(`[${L} ${V}] indexHit (t=0 = last keystroke; results visible ${((firstRowAt - t0) / 1000).toFixed(2)}s)\n${timeline(reqs, t0)}`);
    verdict(`${L} ${V} indexHit: 0 live=1 after 10.5s, no hint`, lives(reqs).length === 0 && !hint, `live=${lives(reqs).length} hint=${hint}`);
    if (consoleErrs.length) log("  console errors: " + consoleErrs.join(" | "));
    await ctx.close();
  },
  // 2/3. No-match: hint, no live while typing, ONE live ~4s after idle, none later.
  async idle(b, L, V) {
    const { ctx, page, reqs, search } = await newPage(b, L, V);
    const tStart = Date.now();
    const t0 = await typeSlow(page, search, "soda stete");
    const typingLive = reqs.filter((r) => r.live && r.at <= t0).length;
    await page.locator("[data-testid=search-enter-hint]").waitFor({ timeout: 10000 }).catch(() => {});
    await shot(page, `${L}-${V}-2-nomatch-hint`);
    await sleep(12000);
    await shot(page, `${L}-${V}-3-idle-live-results`);
    const l = lives(reqs);
    const dt = l[0] ? (l[0].at - t0) / 1000 : NaN;
    log(`[${L} ${V}] idle (typing took ${((t0 - tStart) / 1000).toFixed(1)}s; t=0 = last keystroke)\n${timeline(reqs, t0)}`);
    verdict(`${L} ${V} idle: 0 live while typing, exactly 1 live at ~4s, none again within 12s`, typingLive === 0 && l.length === 1 && dt >= 3.8 && dt <= 5.0, `typingLive=${typingLive} lives=${l.length} firstAt=${dt.toFixed(2)}s`);
    // edit → new idle may fire once
    const t1 = await typeSlow(page, search, " xyz");
    await sleep(9000);
    const l2 = lives(reqs, t1 - 1000);
    log(`[${L} ${V}] edit-after-idle (t=0 = last keystroke of " xyz")\n${timeline(reqs.filter((r) => r.at >= t1 - 1000), t1)}`);
    verdict(`${L} ${V} edit after idle: exactly 1 new live for new text`, l2.length === 1 && l2[0].q.includes("xyz"), `newLives=${l2.length}`);
    await ctx.close();
  },
  // Enter fires immediately; no follow-up from the idle timer; Enter twice = one.
  async enter(b, L, V) {
    const { ctx, page, reqs, search } = await newPage(b, L, V);
    const t0 = await typeSlow(page, search, "soda stete");
    await sleep(900); // let the index miss land
    const tE = Date.now();
    await page.keyboard.press("Enter");
    await sleep(400);
    await page.keyboard.press("Enter"); // second Enter, same text
    await sleep(8000);
    await shot(page, `${L}-${V}-4-enter-live-results`);
    const l = lives(reqs);
    log(`[${L} ${V}] enter (t=0 = first Enter, pressed ${((tE - t0) / 1000).toFixed(2)}s after last keystroke; 2nd Enter at +0.4s)\n${timeline(reqs, tE)}`);
    verdict(`${L} ${V} Enter: 1 live immediately, none from idle, double-Enter = 1`, l.length === 1 && (l[0].at - tE) < 600, `lives=${l.length} at=${l[0] ? ((l[0].at - tE) / 1000).toFixed(2) : "-"}s`);
    await ctx.close();
  },
  // Enter pressed before the index answer even lands (fast typist).
  async enterFast(b, L, V) {
    const { ctx, page, reqs, search } = await newPage(b, L, V);
    await typeSlow(page, search, "soda stete");
    const tE = Date.now();
    await page.keyboard.press("Enter");
    await sleep(8000);
    const l = lives(reqs);
    log(`[${L} ${V}] enterFast (t=0 = Enter immediately after last keystroke)\n${timeline(reqs, tE)}`);
    verdict(`${L} ${V} Enter-fast: exactly 1 live, no later idle live`, l.length === 1, `lives=${l.length}`);
    await ctx.close();
  },
  // Load more: reveal locally first, then one pageToken fetch.
  async loadMore(b, L, V) {
    const { ctx, page, reqs, search } = await newPage(b, L, V);
    await typeSlow(page, search, "soda stete");
    await sleep(300);
    const tE = Date.now();
    await page.keyboard.press("Enter");
    const btn = page.getByRole("button", { name: LOADMORE[L] });
    await btn.waitFor({ timeout: 10000 });
    await btn.scrollIntoViewIfNeeded();
    await shot(page, `${L}-${V}-5-loadmore-before`);
    await btn.click(); // reveal rows 9-12 (no network)
    await sleep(800);
    const afterReveal = reqs.length;
    const btn2visible = await btn.isVisible().catch(() => false);
    if (btn2visible) { await btn.click(); await sleep(1500); }
    await page.mouse.wheel(0, 3000);
    await sleep(300);
    await shot(page, `${L}-${V}-6-loadmore-after`);
    const pages = reqs.filter((r) => r.pageToken);
    log(`[${L} ${V}] loadMore (t=0 = Enter)\n${timeline(reqs, tE)}`);
    verdict(`${L} ${V} loadMore: reveal costs 0 requests, 2nd tap fetches 1 page (v=2, no live=1)`, pages.length === 1 && afterReveal === reqs.length - 1 && pages[0].v === "2", `pageReqs=${pages.length}`);
    await ctx.close();
  },
  // Listen mode: index never answers; hint, then idle live with raw (no "karaoke") query.
  async listen(b, L, V) {
    const { ctx, page, reqs, search } = await newPage(b, L, V);
    await page.locator("label:has(input[name=song-search-mode][value='listen-dance'])").click();
    await sleep(500);
    const before = reqs.length;
    const t0 = await typeSlow(page, search, "evidencias");
    await page.locator("[data-testid=search-enter-hint]").waitFor({ timeout: 10000 }).catch(() => {});
    await shot(page, `${L}-${V}-7-listen-hint`);
    await sleep(8000);
    const l = lives(reqs);
    log(`[${L} ${V}] listen (mode flip fired ${reqs.length && before} reqs; t=0 = last keystroke)\n${timeline(reqs, t0)}`);
    verdict(`${L} ${V} listen: mode flip 0 req, 1 idle live with un-augmented q`, before === 0 && l.length === 1 && !/karaok/i.test(l[0].q), `lives=${l.length} q=${l[0] && l[0].q}`);
    await ctx.close();
  },
  // Switch modes mid-typing.
  async switchMid(b, L, V) {
    const { ctx, page, reqs, search } = await newPage(b, L, V);
    const tS = await typeSlow(page, search, "soda st");
    await sleep(700);
    const nBefore = reqs.length;
    await page.locator("label:has(input[name=song-search-mode][value='listen-dance'])").click();
    await sleep(600);
    const flipReqs = reqs.length - nBefore;
    const t0 = await typeSlow(page, search, "ete");
    await sleep(9000);
    await shot(page, `${L}-${V}-8-switchmid-after`);
    const l = lives(reqs);
    log(`[${L} ${V}] switchMid (flip after "soda st"; t=0 = last keystroke of "ete")\n${timeline(reqs, t0)}`);
    verdict(`${L} ${V} switchMid: flip fires 0 req, no live while typing, exactly 1 idle live (listen q)`, flipReqs === 0 && l.length === 1 && l[0].at > t0 + 3500 && !/karaok/i.test(l[0].q), `flipReqs=${flipReqs} lives=${l.length} q=${l[0] && l[0].q}`);
    await ctx.close();
  },
  // Loading skeleton (index response delayed 2.5s) + real no-key degraded state on Enter.
  async loadingDegraded(b, L, V) {
    const { ctx, page, reqs, search } = await newPage(b, L, V, { mockLive: false, delayIndexMs: 2500 });
    await typeSlow(page, search, "soda stete");
    await sleep(900);
    await shot(page, `${L}-${V}-9-loading-skeleton`);
    await sleep(2500);
    const tE = Date.now();
    await page.keyboard.press("Enter");
    await sleep(3500);
    await shot(page, `${L}-${V}-10-nokey-degraded`);
    log(`[${L} ${V}] loadingDegraded (REAL server for live=1, no key; t=0 = Enter)\n${timeline(reqs, tE)}`);
    await sleep(3000);
    const l = lives(reqs);
    verdict(`${L} ${V} no-key Enter: 1 live, degraded copy, no idle retry`, l.length === 1 && /no-api-key/.test(l[0].answer || ""), `lives=${l.length} ans=${l[0] && l[0].answer}`);
    await ctx.close();
  },
  // Short text, pasted link: Enter does nothing.
  async edges(b, L, V) {
    const { ctx, page, reqs, search } = await newPage(b, L, V);
    await typeSlow(page, search, "abc");
    await page.keyboard.press("Enter");
    await sleep(5500);
    const shortLives = lives(reqs).length;
    await search.fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await sleep(500);
    await page.keyboard.press("Enter");
    await sleep(5500);
    const hint = await page.locator("[data-testid=search-enter-hint]").isVisible();
    await shot(page, `${L}-${V}-11-paste-link`);
    log(`[${L} ${V}] edges (short "abc"+Enter, then pasted link+Enter)\n${timeline(reqs, reqs[0] ? reqs[0].at : Date.now())}`);
    verdict(`${L} ${V} edges: <4 chars Enter and pasted link Enter fire 0 live, no hint on link`, lives(reqs).length === 0 && !hint, `short=${shortLives} lives=${lives(reqs).length} hint=${hint}`);
    await ctx.close();
  },
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  for (const V of VIEWPORTS) for (const L of LOCALES) {
    for (const [name, fn] of Object.entries(SCENARIOS)) {
      if (ONLY && !ONLY.includes(name)) continue;
      try { await fn(browser, L, V); } catch (e) { verdict(`${L} ${V} ${name}`, false, "EXCEPTION " + e.message.split("\n")[0]); }
    }
  }
  await browser.close();
  log("\nSUMMARY: " + results.filter((r) => r.ok).length + "/" + results.length + " passed");
  for (const r of results.filter((r) => !r.ok)) log("  FAIL " + r.name + " — " + r.detail);
  fs.writeFileSync(process.env.OUT || `${EV}/network-timeline.txt`, out.join("\n") + "\n");
})();
