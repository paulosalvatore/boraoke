// TICKET-125 prod verification on https://boraoke.com (headless).
const { createRequire } = require("module");
const req = createRequire("/Users/paulosalvatore/Documents/GitHub/boraoke/package.json");
const { chromium } = req("playwright");
const fs = require("fs");
const path = require("path");

const BASE = "https://boraoke.com";
const OUT = "/Users/paulosalvatore/Documents/GitHub/boraoke/work/evidence/TICKET-125/prod-verify";
fs.mkdirSync(OUT, { recursive: true });

const MISS_CANDIDATES = [
  "hoppipolla sigur ros",
  "tamacun rodrigo y gabriela",
  "svefn g englar sigur ros",
  "diablo rojo rodrigo y gabriela",
  "olsen olsen sigur ros",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const timeline = [];
const note = (ctx, ev) => {
  const e = { tMs: Date.now() - T0, at: new Date().toISOString(), ctx, ...ev };
  timeline.push(e);
  console.log(JSON.stringify(e));
};

function wire(page, ctxName) {
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith("/api/search")) return;
    note(ctxName, { kind: "request", q: u.searchParams.get("q"), v: u.searchParams.get("v"), live: u.searchParams.get("live") === "1", page: u.searchParams.get("page") });
  });
  page.on("response", async (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith("/api/search")) return;
    let body = null;
    try { body = await r.json(); } catch {}
    note(ctxName, {
      kind: "response", status: r.status(), q: u.searchParams.get("q"), live: u.searchParams.get("live") === "1",
      results: body && Array.isArray(body.results) ? body.results.length : Array.isArray(body) ? body.length : null,
      liveRequired: body?.liveRequired ?? null, deferred: body?.deferred ?? null, source: body?.source ?? null,
    });
  });
}
const lives = (ctx, sinceMs = 0) => timeline.filter((e) => e.ctx === ctx && e.kind === "request" && e.live && e.tMs >= sinceMs);
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name), fullPage: false });

async function typeQuery(page, input, text) {
  await input.fill("");
  await input.pressSequentially(text, { delay: 110 });
  return Date.now() - T0; // time of last keystroke
}

// Find an index miss: type, check hint within ~1.3 s, else clear and try next (well under the 4 s idle).
async function findMiss(page, input, ctx, skip = new Set()) {
  for (const q of MISS_CANDIDATES) {
    if (skip.has(q)) continue;
    const tLast = await typeQuery(page, input, q);
    const hint = page.getByTestId("search-enter-hint");
    try { await hint.waitFor({ state: "visible", timeout: 1300 }); return { q, tLast }; } catch {}
    note(ctx, { kind: "note", msg: `candidate '${q}' was not a miss (no hint) — clearing` });
    await input.fill("");
    await sleep(300);
  }
  throw new Error("no index miss found among candidates");
}

const results = {};
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    // ── pt-BR context ──
    const pt = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "pt-BR" });
    await pt.addCookies([{ name: "NEXT_LOCALE", value: "pt-BR", url: BASE }]);
    const p = await pt.newPage();
    wire(p, "pt");
    await p.goto(`${BASE}/new`);
    await p.getByLabel("Nome do bar").fill("T125 prod verify (throwaway)");
    await p.getByRole("button", { name: /^criar sala$/i }).click();
    await p.getByTestId("join-url").waitFor({ timeout: 20000 });
    const joinUrl = (await p.getByTestId("join-url").textContent()).trim();
    const room = joinUrl.split("/").pop();
    results.room = room;
    note("pt", { kind: "note", msg: `created throwaway room ${room} (${joinUrl})` });
    await shot(p, "00-room-created.png");

    await p.goto(`${BASE}/${room}`);
    await p.getByPlaceholder(/ex\.: Maria/i).fill("T125 verify");
    await p.getByRole("button", { name: /entrar na fila/i }).click();
    await p.getByRole("heading", { name: /adicionar música/i }).waitFor({ timeout: 15000 });
    const input = p.getByLabel(/Buscar música/i);

    // (a) index hit while typing
    const aStart = Date.now() - T0;
    note("pt", { kind: "step", step: "a", msg: "type 'evidencias'" });
    await input.pressSequentially("evid", { delay: 110 });
    await sleep(700);
    const rowsMid = await p.locator("button.song-row").count();
    await shot(p, "a1-while-typing-evid.png");
    await input.pressSequentially("encias", { delay: 110 });
    await sleep(1200);
    const rowsEnd = await p.locator("button.song-row").count();
    await shot(p, "a2-evidencias-index-rows.png");
    if (rowsEnd > 0) await sleep(4500); // an index answer must never trigger the idle live search
    results.a = { rowsWhileTyping_evid: rowsMid, rowsAfter_evidencias: rowsEnd, liveCalls: lives("pt", aStart).length, waitedPastIdle: rowsEnd > 0 };
    note("pt", { kind: "step", step: "a-done", ...results.a });
    await input.fill("");
    await sleep(500);

    // (b) index miss -> hint, no live while typing
    const bStart = Date.now() - T0;
    note("pt", { kind: "step", step: "b", msg: "type an index miss" });
    const miss1 = await findMiss(p, input, "pt");
    const hintTextPt = (await p.getByTestId("search-enter-hint").textContent()).trim();
    await shot(p, "b1-miss-hint-pt-BR.png");
    results.b = { query: miss1.q, hintPt: hintTextPt, liveCallsBeforeEnter: lives("pt", bStart).length, msSinceLastKey: Date.now() - T0 - miss1.tLast };

    // (c) Enter -> exactly one live=1
    const cStart = Date.now() - T0;
    note("pt", { kind: "step", step: "c", msg: `press Enter on '${miss1.q}'` });
    await input.press("Enter");
    let rowsC = 0;
    try { await p.locator("button.song-row").first().waitFor({ timeout: 10000 }); rowsC = await p.locator("button.song-row").count(); } catch {}
    await shot(p, "c1-after-enter-results.png");
    await sleep(6000); // no repeat on the same text
    results.c = { query: miss1.q, liveCalls: lives("pt", cStart).length, rows: rowsC, hintGone: (await p.getByTestId("search-enter-hint").count()) === 0 };
    note("pt", { kind: "step", step: "c-done", ...results.c });

    // (d) fresh miss + wait >= 5 s without Enter -> one live at ~4 s
    const dStart = Date.now() - T0;
    note("pt", { kind: "step", step: "d", msg: "fresh miss, then idle" });
    const miss2 = await findMiss(p, input, "pt", new Set([miss1.q]));
    await shot(p, "d1-fresh-miss-hint.png");
    await sleep(Math.max(0, 6500 - (Date.now() - T0 - miss2.tLast)));
    const dLives = lives("pt", dStart);
    let rowsD = await p.locator("button.song-row").count();
    await shot(p, "d2-after-idle-results.png");
    results.d = { query: miss2.q, liveCalls: dLives.length, liveAtMsAfterLastKey: dLives.map((e) => e.tMs - miss2.tLast), rows: rowsD };
    note("pt", { kind: "step", step: "d-done", ...results.d });
    await pt.close();

    // ── en context: hint copy only, closed well before the 4 s idle ──
    const en = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
    await en.addCookies([{ name: "NEXT_LOCALE", value: "en", url: BASE }]);
    const e = await en.newPage();
    wire(e, "en");
    await e.goto(`${BASE}/${room}`);
    await e.getByLabel("Your nickname").fill("T125 verify en");
    await e.getByRole("button", { name: /join the queue/i }).click();
    const enInput = e.getByLabel(/Search for a song|Search a song/i).first();
    await enInput.waitFor({ timeout: 15000 });
    const enStart = Date.now() - T0;
    const miss3 = await findMiss(e, enInput, "en", new Set([miss1.q, miss2.q]));
    const hintTextEn = (await e.getByTestId("search-enter-hint").textContent()).trim();
    await shot(e, "b2-miss-hint-en.png");
    await enInput.fill(""); // abandon before the idle timer
    await sleep(300);
    results.bEn = { query: miss3.q, hintEn: hintTextEn, liveCalls: lives("en", enStart).length };
    await en.close();
    await sleep(500);
    results.bEn.liveCallsAfterClose = lives("en", enStart).length;
  } catch (err) {
    results.error = String(err && err.stack || err);
    console.error(err);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(OUT, "network-timeline.json"), JSON.stringify({ base: BASE, startedAt: new Date(T0).toISOString(), results, timeline }, null, 2));
    console.log("RESULTS " + JSON.stringify(results, null, 2));
  }
})();
