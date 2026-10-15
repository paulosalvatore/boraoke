// TICKET-125 re-check harness (head 638d427): headless Playwright vs next dev :3125.
const WT = "/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t125-enter-idle-search";
const { chromium } = require(WT + "/node_modules/@playwright/test");
const fs = require("fs");
const BASE = "http://127.0.0.1:3125";
const EV = WT + "/work/evidence/TICKET-125/recheck";
const VP = {
  phone390: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  phone320: { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { viewport: { width: 1280, height: 800 } },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = (p, n) => Array.from({ length: n }, (_, i) => ({ videoId: (p + String(i).padStart(11, "0")).slice(-11), title: `MOCK live ${i + 1} (${p})`, channelTitle: "Mock", duration: "3:30", thumbnailUrl: "" }));
const out = []; const log = (s) => { out.push(s); console.log(s); };
const results = [];
const verdict = (n, ok, d) => { results.push({ n, ok }); log(`  => ${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`); };

async function open(b, L, vp) {
  const ctx = await b.newContext({ ...VP[vp], locale: L });
  await ctx.addCookies([{ name: "NEXT_LOCALE", value: L, url: BASE }]);
  const page = await ctx.newPage();
  const reqs = [], posts = [], errs = [];
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  page.on("pageerror", (e) => errs.push("pageerror " + e.message));
  page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/api/queue")) posts.push({ at: Date.now(), body: (r.postData() || "").slice(0, 120) }); });
  await page.route("**/api/search**", async (route) => {
    const u = new URL(route.request().url()); const p = Object.fromEntries(u.searchParams);
    const rec = { at: Date.now(), q: p.q, live: p.live === "1", v: p.v };
    reqs.push(rec);
    if (rec.live) return route.fulfill({ json: { results: rows("L", 12), nextPageToken: "" } });
    const resp = await route.fetch(); rec.answer = (await resp.text()).slice(0, 50);
    return route.fulfill({ response: resp });
  });
  await page.goto(BASE + "/default");
  const s = page.locator("#song-search-input");
  if (!(await s.isVisible().catch(() => false))) { const n = page.locator("#nickname-input"); await n.waitFor({ timeout: 60000 }); await n.fill("AppTester"); await n.press("Enter"); }
  await s.waitFor({ timeout: 60000 });
  return { ctx, page, reqs, posts, errs, s };
}
const type = async (page, s, t) => { await s.click(); await page.keyboard.type(t, { delay: 120 }); return Date.now(); };
const tl = (reqs, t0) => reqs.map((r) => `    ${((r.at - t0) / 1000).toFixed(2).padStart(6)}s ${r.live ? "LIVE=1" : "index "} q="${r.q}"${r.answer ? " -> " + r.answer : ""}`).join("\n") || "    (no requests)";
const lives = (reqs, after = 0) => reqs.filter((r) => r.live && r.at >= after);
const mode = (page, v) => page.locator(`label:has(input[name=song-search-mode][value='${v}'])`).click();

async function hintFit(b, L, vp) {
  const { ctx, page, s } = await open(b, L, vp);
  await type(page, s, "soda stete");
  const h = page.locator("[data-testid=search-enter-hint]");
  await h.waitFor({ timeout: 10000 });
  await sleep(300);
  const m = await h.evaluate((el) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    const rng = document.createRange(); rng.selectNodeContents(el);
    const lines = new Set([...rng.getClientRects()].map((x) => Math.round(x.top))).size;
    const inp = document.querySelector("#song-search-input").getBoundingClientRect();
    const prev = el.previousElementSibling && el.previousElementSibling.getBoundingClientRect();
    const next = el.nextElementSibling && el.nextElementSibling.getBoundingClientRect();
    return { text: el.textContent.trim(), w: r.width, left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, fs: cs.fontSize, color: cs.color, bg: getComputedStyle(document.body).backgroundColor,
      lines, h: r.height, lh, scrollW: el.scrollWidth, clientW: el.clientWidth, docOverflow: document.documentElement.scrollWidth > innerWidth,
      inputBottom: inp.bottom, overlapInput: r.top < inp.bottom - 1 && r.bottom > inp.top, nextTop: next && next.top, overlapNext: !!next && r.bottom > next.top + 1 && r.top < next.bottom };
  });
  await page.screenshot({ path: `${EV}/${L}-${vp}-hint-1-after-index-miss.png` });
  await h.scrollIntoViewIfNeeded();
  await h.screenshot({ path: `${EV}/${L}-${vp}-hint-2-element-closeup.png` });
  log(`[hint ${L} ${vp}] ${JSON.stringify(m)}`);
  const fits = m.left >= 0 && m.right <= m.vw && !m.docOverflow && m.scrollW <= m.clientW + 1 && !m.overlapInput && !m.overlapNext;
  verdict(`hint ${L} ${vp}: fits viewport, no overflow, no overlap`, fits, `lines=${m.lines} w=${m.w.toFixed(0)}/${m.vw} fs=${m.fs}`);
  await ctx.close();
  return m;
}

async function enterQueues(b, L, vp, how) {
  const { ctx, page, posts, s } = await open(b, L, vp);
  const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  await s.click(); await s.fill(url); await sleep(1500);
  // Pasted link may move focus to the add button (TICKET-40): put the caret back in the field.
  await s.click();
  const focusIn = await page.evaluate(() => document.activeElement && document.activeElement.id);
  await page.screenshot({ path: `${EV}/${L}-${vp}-enterlink-1-before-enter-${how}.png` });
  const t = Date.now();
  if (how === "enter") await page.keyboard.press("Enter");
  else { // phone search key: Enter keydown with keyCode 13 / enterkeyhint=search via CDP (real key event path)
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }
  await sleep(2500);
  await page.screenshot({ path: `${EV}/${L}-${vp}-enterlink-2-after-enter-${how}.png` });
  const hasErr = await page.locator("[role=alert]").allTextContents().catch(() => []);
  log(`[enterlink ${L} ${vp} ${how}] focus=#${focusIn} posts=${JSON.stringify(posts.map((p) => ({ dt: ((p.at - t) / 1000).toFixed(2), body: p.body })))} alerts=${JSON.stringify(hasErr)}`);
  verdict(`pasted link + ${how} inside search field queues exactly once (${L} ${vp})`, focusIn === "song-search-input" && posts.length === 1 && /dQw4w9WgXcQ/.test(posts[0].body), `focus=${focusIn} posts=${posts.length}`);
  await ctx.close();
}

async function modeFlip(b, L) {
  const { ctx, page, reqs, s } = await open(b, L, "phone390");
  const T = "soda stete";
  // sing: idle live fires once
  const t0 = await type(page, s, T); await sleep(7000);
  let l = lives(reqs); log(`[modeflip ${L}] sing idle\n${tl(reqs, t0)}`);
  verdict(`modeflip ${L}: sing idle fires 1 live`, l.length === 1, `lives=${l.length}`);
  // flip to listen: nothing
  const n = reqs.length; const tf = Date.now(); await mode(page, "listen-dance"); await sleep(7000);
  log(`[modeflip ${L}] flip→listen, then 7 s idle, no typing\n${tl(reqs.filter((r) => r.at >= tf - 50), tf)}`);
  verdict(`modeflip ${L}: mode change alone fires nothing (0 requests in 7 s)`, reqs.length === n, `new=${reqs.length - n}`);
  await page.screenshot({ path: `${EV}/${L}-phone390-modeflip-1-after-flip-nothing.png` });
  // settle in new mode: touch the text (add + remove a char) → idle fires again for listen
  const nb = reqs.length; await s.click(); await s.fill(""); await sleep(300); await page.keyboard.type(T, { delay: 120 }); const t1 = Date.now(); await sleep(7000);
  const nl = lives(reqs, t1 - 2000); log(`[modeflip ${L}] settle same text in listen mode (clear + retype; t=0 last key)\n${tl(reqs.filter((r) => r.at >= t1 - 2000), t1)}`);
  verdict(`modeflip ${L}: settling in listen fires exactly 1 live for the same text`, nl.length === 1 && nl[0].q === T && nl[0].at - t1 > 3500, `lives=${nl.length} q=${nl[0] && nl[0].q}`);
  await page.screenshot({ path: `${EV}/${L}-phone390-modeflip-2-listen-settled-live.png` });
  // same mode+text again: no second fire (Enter)
  const t2 = Date.now(); await page.keyboard.press("Enter"); await sleep(2000);
  verdict(`modeflip ${L}: same mode+text Enter again fires nothing`, lives(reqs, t2 - 100).length === 0, `lives=${lives(reqs, t2 - 100).length}`);
  // flip back to sing and Enter → sing scope differs from last (listen) → fires
  await mode(page, "sing"); await sleep(500); const t3 = Date.now(); await s.click(); await page.keyboard.press("Enter"); await sleep(2000);
  const back = lives(reqs, t3 - 100); log(`[modeflip ${L}] flip back to sing then Enter (t=0 flip back)\n${tl(reqs.filter((r) => r.at >= t3 - 700), t3)}`);
  verdict(`modeflip ${L}: back to sing + Enter fires 1 live (new scope)`, back.length === 1, `lives=${back.length}`);
  await ctx.close();
}

async function modeFlipEnter(b, L) {
  const { ctx, page, reqs, s } = await open(b, L, "phone390");
  const T = "soda stete";
  await type(page, s, T); await sleep(600);
  await page.keyboard.press("Enter"); await sleep(1500);            // sing live #1
  await mode(page, "listen-dance"); await sleep(600);
  const t = Date.now(); await s.click(); await page.keyboard.press("Enter"); await sleep(2000); // listen Enter, same text
  const l = lives(reqs); log(`[modeflip-enter ${L}] sing Enter, flip listen, Enter\n${tl(reqs, reqs[0].at)}`);
  verdict(`modeflip-enter ${L}: Enter after flip fires a fresh live for listen (2 lives total, 2nd raw q)`, l.length === 2 && !/karaok/i.test(l[1].q), `lives=${l.length} q2=${l[1] && l[1].q}`);
  await ctx.close();
}

async function regression(b, L) {
  // index hit
  let o = await open(b, L, "phone390");
  let t0 = await type(o.page, o.s, "evidencias"); await sleep(9000);
  log(`[regr ${L}] index hit\n${tl(o.reqs, t0)}`);
  verdict(`regr ${L}: index hit fires 0 live=1`, lives(o.reqs).length === 0);
  await o.ctx.close();
  // miss + idle
  o = await open(b, L, "phone390");
  t0 = await type(o.page, o.s, "soda stete"); await sleep(8000);
  const l = lives(o.reqs); const dt = l[0] ? (l[0].at - t0) / 1000 : NaN;
  log(`[regr ${L}] miss + idle\n${tl(o.reqs, t0)}`);
  verdict(`regr ${L}: miss+idle → exactly 1 live=1 at ~4 s`, l.length === 1 && dt >= 3.8 && dt <= 5, `lives=${l.length} at=${dt.toFixed(2)}s`);
  await o.ctx.close();
  // Enter
  o = await open(b, L, "phone390");
  await type(o.page, o.s, "soda stete"); await sleep(900);
  const tE = Date.now(); await o.page.keyboard.press("Enter"); await sleep(8000);
  const e = lives(o.reqs); log(`[regr ${L}] Enter\n${tl(o.reqs, tE)}`);
  verdict(`regr ${L}: Enter → immediate single live=1, no idle follow-up`, e.length === 1 && e[0].at - tE < 600, `lives=${e.length} at=${e[0] ? ((e[0].at - tE) / 1000).toFixed(2) : "-"}s`);
  await o.ctx.close();
}

(async () => {
  fs.mkdirSync(EV, { recursive: true });
  const b = await chromium.launch({ headless: true });
  const step = process.env.STEP || "all";
  const run = async (name, f) => { try { await f(); } catch (e) { verdict(name, false, "EXCEPTION " + e.message.split("\n")[0]); } };
  if (step === "all" || step === "hint") for (const vp of Object.keys(VP)) for (const L of ["pt-BR", "en", "es"]) await run(`hint ${L} ${vp}`, () => hintFit(b, L, vp));
  if (step === "all" || step === "enter") for (const L of ["pt-BR", "en", "es"]) { await run(`enterlink ${L}`, () => enterQueues(b, L, "phone390", "enter")); await run(`enterlink-key ${L}`, () => enterQueues(b, L, "phone390", "searchkey")); }
  if (step === "all" || step === "enter") await run("enterlink desktop", () => enterQueues(b, "en", "desktop", "enter"));
  if (step === "all" || step === "mode") for (const L of ["pt-BR", "en", "es"]) { await run(`modeflip ${L}`, () => modeFlip(b, L)); await run(`modeflip-enter ${L}`, () => modeFlipEnter(b, L)); }
  if (step === "all" || step === "regr") for (const L of ["pt-BR", "en", "es"]) await run(`regr ${L}`, () => regression(b, L));
  await b.close();
  log(`\nSUMMARY: ${results.filter((r) => r.ok).length}/${results.length} passed`);
  for (const r of results.filter((r) => !r.ok)) log("  FAIL " + r.n);
  fs.writeFileSync(process.env.OUT || `${EV}/recheck-timeline-${step}.txt`, out.join("\n") + "\n");
})();
