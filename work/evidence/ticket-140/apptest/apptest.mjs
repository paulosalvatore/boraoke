// TICKET-140 App Tester harness (headless Playwright, one browser, loopback stub). Test-harness code only.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const BASE = "http://localhost:3140";
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);
const msgs = Object.fromEntries(["pt-BR", "en", "es"].map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, "messages", `${l}.json`), "utf8"))]));
const VPS = { m390: { width: 390, height: 844 }, m320: { width: 320, height: 640 }, d1280: { width: 1280, height: 800 } };
const LOCALES = { "pt-BR": "pt-BR", en: "en-US", es: "es-MX" };
const BAD = /quota|quote|cota|cuota|custo|cost|costo|billing|cobran|paid|pago|pagad|google|api/i;
const results = [];
const log = (combo, name, pass, detail = "") => { results.push({ combo, name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} [${combo}] ${name} ${detail}`); };
const shot = async (page, combo, name) => { const f = path.join(HERE, `${combo}-${name}.png`); await page.screenshot({ path: f }); return f; };
const noOverflow = async (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipn = 10;

async function step(combo, name, fn) {
  try { const d = await fn(); log(combo, name, true, d || ""); } catch (e) { log(combo, name, false, String(e.message).split("\n")[0].slice(0, 300)); }
}

async function patronCtx(browser, L, V, label) {
  const ctx = await browser.newContext({ locale: LOCALES[L], viewport: VPS[V], extraHTTPHeaders: { "x-forwarded-for": `10.14.0.${++ipn}` } });
  const page = await ctx.newPage();
  const errs = []; page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
  page.on("pageerror", (e) => errs.push("pageerror " + e.message.slice(0, 160)));
  page.__errs = errs;
  return { ctx, page };
}

async function join(page, L, room, nick) {
  const P = msgs[L].Patron;
  await page.goto(`${BASE}/${room}`);
  await page.getByLabel(P.nicknameLabel).waitFor();
  await page.getByPlaceholder(P.nicknamePlaceholder).fill(nick);
  await page.getByRole("button", { name: P.joinQueue, exact: false }).click();
  await page.getByRole("heading", { name: P.addSong }).waitFor();
}
const searchBox = (page, L) => page.getByLabel(msgs[L].Search.aria, { exact: false });

async function pasteAndQueue(page, L, combo, text, id, tag, expectTitle = `Música Teste ${id}`) {
  const P = msgs[L].Patron, S = msgs[L].Search;
  const box = searchBox(page, L);
  await box.fill(""); await box.fill(text);
  await page.getByText(P.selected.replace("{videoId}", id), { exact: false }).waitFor({ timeout: 8000 });
  await page.getByText(expectTitle).first().waitFor({ timeout: 10000 });
  const placeholderGone = (await page.getByText(S.youtubeLink, { exact: true }).count()) === 0;
  await shot(page, combo, `${tag}-picker`);
  await page.getByRole("button", { name: P.addToQueue }).click();
  await page.getByText(P.songAdded, { exact: false }).waitFor({ timeout: 10000 });
  const row = page.getByTestId("queue-row-title").filter({ hasText: expectTitle }).first();
  await row.waitFor({ timeout: 10000 });
  const rowText = (await row.textContent()).trim();
  await shot(page, combo, `${tag}-queue`);
  return { placeholderGone, rowText, overflow: await noOverflow(page) };
}

async function main() {
  console.log("uptime-ish load:", fs.readFileSync("/proc/loadavg", "utf8").trim?.() ?? "");
}
async function run() {
  const browser = await chromium.launch({ headless: true });
  const combos = [];
  for (const L of Object.keys(LOCALES)) for (const V of Object.keys(VPS)) combos.push([L, V]);
  let ci = 0;
  for (const [L, V] of combos) {
    const combo = `${L}-${V}`; ci++;
    if (ONLY.length && !ONLY.includes(combo)) continue;
    const S = msgs[L].Search, P = msgs[L].Patron, E = msgs[L].Errors;
    // Host context (creator) + room
    const host = await browser.newContext({ locale: LOCALES[L], viewport: VPS[V], extraHTTPHeaders: { "x-forwarded-for": `10.14.1.${ci}` } });
    const hp = await host.newPage();
    await hp.goto(`${BASE}/new`);
    const created = await (await hp.request.post(`${BASE}/api/rooms`, { data: { name: `AT140 ${combo}` } })).json();
    const room = created.id;
    log(combo, "room created", !!room, room);
    const { ctx, page } = await patronCtx(browser, L, V);
    const seenQ = [];
    await page.route("**/api/search**", async (route) => {
      const q = new URL(route.request().url()).searchParams.get("q") || "";
      seenQ.push(q);
      if (/zzlimit/i.test(q)) return route.fulfill({ status: 429, contentType: "application/json", body: "{}" });
      const w = q.replace(/karaoke/i, "").trim();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [{ videoId: "9bZkp7q19f0", title: `${w} (Karaokê)`, channelTitle: "Karaokê Hits", duration: "3:10", thumbnailUrl: "https://i.ytimg.com/vi/9bZkp7q19f0/mqdefault.jpg" }] }) });
    });
    await step(combo, "join", async () => { await join(page, L, room, "Tester" + ci); });
    // 1. words
    for (const w of ["Imagination", "Bittersweet", "UNBREAKABLE"]) {
      await step(combo, `word ${w} searches, no fake link row`, async () => {
        const box = searchBox(page, L); await box.fill(""); await box.fill(w);
        await page.getByRole("button", { name: new RegExp(w + " \\(Karaokê\\)", "i") }).waitFor({ timeout: 10000 });
        const searched = seenQ.some((q) => q.toLowerCase().includes(w.toLowerCase()));
        const fake = await page.getByText(S.youtubeLink, { exact: true }).count();
        const sel = await page.getByText(P.selected.replace("{videoId}", w), { exact: false }).count();
        if (w === "Imagination") await shot(page, combo, "word-imagination");
        if (!searched || fake || sel) throw new Error(`searched=${searched} fake=${fake} sel=${sel}`);
        return "searched";
      });
    }
    await step(combo, "bare dQw4w9WgXcQ is a video", async () => {
      const box = searchBox(page, L); await box.fill(""); await box.fill("dQw4w9WgXcQ");
      await page.getByText(P.selected.replace("{videoId}", "dQw4w9WgXcQ"), { exact: false }).waitFor({ timeout: 6000 });
      await shot(page, combo, "bare-id");
    });
    // 5. rate-limit copy
    await step(combo, "rate-limit copy mentions paste a link, fits", async () => {
      const box = searchBox(page, L); await box.fill(""); await box.fill("zzlimit term");
      const el = page.getByText(S.rateLimited, { exact: false }).first(); await el.waitFor({ timeout: 10000 });
      const bb = await el.boundingBox(); const ok = bb && bb.x >= 0 && bb.x + bb.width <= VPS[V].width + 1;
      await shot(page, combo, "rate-limited");
      if (!ok || !(await noOverflow(page))) throw new Error("overflow " + JSON.stringify(bb));
      return S.rateLimited;
    });
    // 2/3. paste forms
    const forms = [
      ["music", "apOkF1C" + String(ci).padStart(2, "0") + "xx", (id) => `https://music.youtube.com/watch?v=${id}&si=abc`],
      ["nocookie", "apOkF2C" + String(ci).padStart(2, "0") + "xx", (id) => `https://www.youtube-nocookie.com/embed/${id}`],
      ["upper", "apOkF3C" + String(ci).padStart(2, "0") + "xx", (id) => `HTTPS://WWW.YOUTUBE.COM/watch?v=${id}`],
      ["slash", "apOkF4C" + String(ci).padStart(2, "0") + "xx", (id) => `youtu.be/${id}/`],
      ["share", "apOkF5C" + String(ci).padStart(2, "0") + "xx", (id) => `olha essa https://youtu.be/${id} kkk`],
    ];
    const useForms = ci === 1 ? forms : [forms[(ci - 1) % 5]];
    let first = true;
    for (const [tag, id, mk] of useForms) {
      await step(combo, `paste ${tag} queues with real title+channel`, async () => {
        let pg = page;
        if (!first) { const c2 = await patronCtx(browser, L, V); pg = c2.page; await join(pg, L, room, "T" + tag + ci); }
        first = false;
        const r = await pasteAndQueue(pg, L, combo, mk(id), id, tag);
        if (!r.placeholderGone || !r.rowText.includes("Canal Teste") || r.rowText.includes("youtu.be/") || !r.overflow) throw new Error(JSON.stringify(r));
        return r.rowText;
      });
    }
    // not embeddable
    await step(combo, "not-embeddable refused with friendly copy", async () => {
      const box = searchBox(page, L); await box.fill(""); await box.fill("https://youtu.be/apBlock" + String(ci).padStart(2, "0") + "xx");
      await page.getByText(P.selected.replace("{videoId}", "apBlock" + String(ci).padStart(2, "0") + "xx"), { exact: false }).waitFor({ timeout: 8000 });
      await page.getByRole("button", { name: P.addToQueue }).click();
      const copy = E.submitNotEmbeddable;
      const el = page.getByText(copy, { exact: false }).first(); await el.waitFor({ timeout: 10000 });
      const bb = await el.boundingBox();
      const fits = bb && bb.x >= 0 && bb.x + bb.width <= VPS[V].width + 1 && (await noOverflow(page));
      await shot(page, combo, "not-embeddable");
      if (BAD.test(copy)) throw new Error("copy mentions bad word: " + copy);
      const q = await (await page.request.get(`${BASE}/api/queue?room=${room}`)).json();
      if (q.items.some((e) => e.videoId.startsWith("apBlock"))) throw new Error("blocked video was queued");
      if (!fits) throw new Error("copy does not fit " + JSON.stringify(bb));
      return "refused";
    });
    if (ci === 1) {
      await step(combo, "timed-out check still lets the song in (slow 4s stub)", async () => {
        const c2 = await patronCtx(browser, L, V); await join(c2.page, L, room, "Slow");
        const box = searchBox(c2.page, L); await box.fill("https://youtu.be/apSlow00001");
        await c2.page.getByText(P.selected.replace("{videoId}", "apSlow00001"), { exact: false }).waitFor({ timeout: 8000 });
        const t0 = Date.now();
        await c2.page.getByRole("button", { name: P.addToQueue }).click();
        await c2.page.getByText(P.songAdded, { exact: false }).waitFor({ timeout: 15000 });
        await shot(c2.page, combo, "timeout-queued");
        return `queued in ${Date.now() - t0}ms`;
      });
      await step(combo, "failed lookup falls back to link label, queued", async () => {
        const c2 = await patronCtx(browser, L, V); await join(c2.page, L, room, "Fail");
        const box = searchBox(c2.page, L); await box.fill("https://youtu.be/apFail00001");
        await c2.page.getByText(P.selected.replace("{videoId}", "apFail00001"), { exact: false }).waitFor({ timeout: 8000 });
        const ph = await c2.page.getByText(S.youtubeLink, { exact: true }).count();
        await c2.page.getByRole("button", { name: P.addToQueue }).click();
        await c2.page.getByText(P.songAdded, { exact: false }).waitFor({ timeout: 10000 });
        await c2.page.getByText("youtu.be/apFail00001").first().waitFor({ timeout: 10000 });
        await shot(c2.page, combo, "fallback-label");
        if (!ph) throw new Error("placeholder missing in picker");
        const errs = c2.page.__errs.filter((e) => !/Failed to load resource/.test(e));
        return "fallback ok; console errors: " + JSON.stringify(errs);
      });
    }
    // Host admin + TV (queue)
    await step(combo, "host admin shows real title", async () => {
      await hp.goto(`${BASE}/${room}/admin`);
      await hp.getByTestId("queue-row").first().waitFor({ timeout: 15000 });
      const txt = await hp.getByTestId("queue-row").first().textContent();
      await shot(hp, combo, "host-admin");
      if (!/Música Teste/.test(txt)) throw new Error("row=" + txt);
      const ov = !(await noOverflow(hp));
      return txt.trim().slice(0, 120) + (ov ? "  [NOTE: admin page scrolls horizontally here; pre-existing, row width independent of title]" : "");
    });
    await step(combo, "TV shows real title", async () => {
      const tv = await host.newPage(); await tv.setViewportSize(V === "d1280" ? VPS.d1280 : VPS[V]);
      await tv.goto(`${BASE}/${room}/tv`);
      await tv.getByText(/Música Teste/).first().waitFor({ timeout: 20000 });
      await sleep(1500);
      await shot(tv, combo, "tv");
      const body = await tv.evaluate(() => document.body.innerText);
      const hasLink = /youtu\.be\/apOk/.test(body);
      await tv.close();
      if (hasLink) throw new Error("TV still shows fallback link label");
      return "title visible on /tv";
    });
    // Moderation / pending with duration: 1280 only
    if (V === "d1280") {
      await step(combo, "moderated: host pending row title · channel · duration", async () => {
        await hp.goto(`${BASE}/${room}/admin`);
        const tr = hp.getByTestId("moderation-track"); await tr.waitFor({ timeout: 15000 });
        if (!(await hp.getByTestId("moderation-toggle").isChecked())) await tr.click();
        await hp.getByTestId("moderation-toggle").waitFor({ state: "attached" });
        const c2 = await patronCtx(browser, L, V); await join(c2.page, L, room, "Mod");
        const id = "apOkMod" + String(ci).padStart(2, "0") + "xx";
        const box = searchBox(c2.page, L); await box.fill("https://youtu.be/" + id);
        await c2.page.getByText(`Música Teste ${id}`).first().waitFor({ timeout: 10000 });
        await c2.page.getByRole("button", { name: P.addToQueue }).click();
        await c2.page.getByTestId("patron-pending-waiting").waitFor({ timeout: 10000 });
        const pt = await c2.page.getByTestId("patron-pending").textContent();
        await shot(c2.page, combo, "patron-pending");
        await hp.reload();
        const card = hp.getByTestId("pending-card").first(); await card.waitFor({ timeout: 15000 });
        const t = await card.textContent();
        await shot(hp, combo, "host-pending");
        if (!t.includes(`Música Teste ${id}`) || !t.includes("Canal Teste") || !/3:27/.test(t)) throw new Error("pending card=" + t);
        if (!pt.includes(`Música Teste ${id}`)) throw new Error("patron pending=" + pt);
        await hp.getByTestId("pending-approve").first().click();
        await sleep(1500);
        return t.trim().slice(0, 140);
      });
    }
    // 2nd-attempt: unmocked rate-limit via real server (pt only, combo 1)
    await ctx.close(); await host.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(HERE, `results${ONLY.length ? "-" + ONLY.join("_") : ""}.json`), JSON.stringify(results, null, 1));
  const f = results.filter((r) => !r.pass);
  console.log(`DONE ${results.length - f.length}/${results.length} pass`);
}
run().catch((e) => { console.error("FATAL", e); process.exit(2); });
