// TICKET-140 App Tester RE-CHECK harness (head fb373ed). Headless Playwright, one browser, loopback stub on 4140.
import { chromium } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const BASE = "http://localhost:3141";
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);
const msgs = Object.fromEntries(["pt-BR", "en", "es"].map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, "messages", `${l}.json`), "utf8"))]));
const OLD_TITLE_LABEL = { "pt-BR": "Título da música", en: "Song title", es: "Título de la canción" };
const VPS = { m390: { width: 390, height: 844 }, d1280: { width: 1280, height: 800 } };
const LOCALES = { "pt-BR": "pt-BR", en: "en-US", es: "es-MX" };
const HINT = /link|enlace/i;
const results = [];
const log = (combo, name, pass, detail = "") => { results.push({ combo, name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} [${combo}] ${name} ${detail}`); };
const shot = async (page, combo, name) => { await page.screenshot({ path: path.join(HERE, `${combo}-${name}.png`) }); };
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ipn = 10;
async function step(combo, name, fn) {
  try { const d = await fn(); log(combo, name, true, d || ""); } catch (e) { log(combo, name, false, String(e.message).split("\n")[0].slice(0, 400)); }
}
async function patronCtx(browser, L, V) {
  const ctx = await browser.newContext({ locale: LOCALES[L], viewport: VPS[V], extraHTTPHeaders: { "x-forwarded-for": `10.15.0.${++ipn}` } });
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
// search mock: words return a result; ids passed via "pick:<id>:<patron text>"; zz429 -> 429; zz500 -> 500; zzabort -> abort; zzdeg -> degraded
async function mockSearch(page, seenQ) {
  await page.route("**/api/search**", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") || "";
    seenQ.push(q);
    if (/zz429srv/i.test(q)) return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "SERVER_COPY_429" }) });
    if (/zz429/i.test(q)) return route.fulfill({ status: 429, contentType: "application/json", body: "{}" });
    if (/zz500json/i.test(q)) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
    if (/zz500/i.test(q)) return route.fulfill({ status: 500, contentType: "text/plain", body: "boom" });
    if (/zzabort/i.test(q)) return route.abort();
    if (/zzdeg/i.test(q)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ degraded: true, reason: "error" }) });
    const m = q.match(/pick (\w{11}) (.*?)( karaoke)?$/i);
    const id = m ? m[1] : "9bZkp7q19f0"; const title = m ? m[2] : `${q.replace(/karaoke/i, "").trim()} (Karaokê)`;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [{ videoId: id, title, channelTitle: "Canal Busca", duration: "3:10", thumbnailUrl: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` }] }) });
  });
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
    const pad = String(ci).padStart(2, "0");
    const host = await browser.newContext({ locale: LOCALES[L], viewport: VPS[V], extraHTTPHeaders: { "x-forwarded-for": `10.15.1.${ci}` } });
    const hp = await host.newPage();
    await hp.goto(`${BASE}/new`);
    const created = await (await hp.request.post(`${BASE}/api/rooms`, { data: { name: `AT140r2 ${combo}` } })).json();
    let room = created.id; log(combo, "room created", !!room, room);
    const { ctx, page } = await patronCtx(browser, L, V);
    const seenQ = []; await mockSearch(page, seenQ);
    await step(combo, "join", () => join(page, L, room, "Tester" + ci));

    // 1. form without the title field: layout + submit
    await step(combo, "1 no 'song title' field, layout aligned, no gap", async () => {
      const txt = await page.locator("body").innerText();
      if (txt.includes(OLD_TITLE_LABEL[L])) throw new Error("old title label still visible");
      const info = await page.evaluate(() => {
        const inp = document.querySelector("#song-search-input"); const form = inp.closest("form");
        const kids = [...form.children].filter((c) => c.getBoundingClientRect().height > 0).map((c) => { const r = c.getBoundingClientRect(); return { tag: c.tagName, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), t: (c.innerText || "").slice(0, 30).replace(/\n/g, "|") }; });
        const inputs = [...form.querySelectorAll("input,textarea,select")].filter((i) => i.getBoundingClientRect().height > 0).map((i) => i.id || i.placeholder || i.type);
        return { kids, inputs };
      });
      const { kids } = info; const gaps = [];
      for (let i = 1; i < kids.length; i++) gaps.push(kids[i].y - (kids[i - 1].y + kids[i - 1].h));
      const lefts = new Set(kids.map((k) => k.x)); const rights = new Set(kids.map((k) => k.x + k.w));
      await shot(page, combo, "form-no-title");
      if (lefts.size !== 1 || rights.size !== 1) throw new Error("misaligned edges " + JSON.stringify(kids));
      if (gaps.some((g) => g < -1 || g > 40)) throw new Error("odd gap " + JSON.stringify({ gaps, kids }));
      if (!(await noOverflow(page))) throw new Error("horizontal overflow");
      return `inputs=${JSON.stringify(info.inputs)} gaps=${JSON.stringify(gaps)}`;
    });
    await step(combo, "1 submit still works (paste + table)", async () => {
      const id = `apOkPa${"C" + pad}xx`.slice(0, 11);
      const box = searchBox(page, L); await box.fill(`https://youtu.be/${id}`);
      await page.getByText(`Música Teste ${id}`).first().waitFor({ timeout: 12000 });
      await page.locator("input[placeholder]").filter({ hasNot: page.locator("#song-search-input") }).last().fill("7").catch(() => {});
      await shot(page, combo, "form-filled");
      await page.getByRole("button", { name: P.addToQueue }).click();
      await page.getByText(P.songAdded, { exact: false }).waitFor({ timeout: 12000 });
      const row = page.getByTestId("queue-row-title").filter({ hasText: `Música Teste ${id}` }).first();
      await row.waitFor({ timeout: 12000 });
      const t = (await row.textContent()).trim();
      await shot(page, combo, "paste-queued");
      if (!t.includes("Canal Teste") || t.includes("youtu.be/")) throw new Error("row=" + t);
      return t;
    });

    // 2. failed lookup -> youtu.be/<id> everywhere, never patron text
    const failId = `apFailC${pad}xx`; const PATRON = "PATRONTEXT_XYZ_" + ci;
    await step(combo, "2 failed lookup shows youtu.be/<id>, never patron text (picker pick, queue, host, TV)", async () => {
      const room2 = (await (await hp.request.post(`${BASE}/api/rooms`, { data: { name: `AT140r2f ${combo}` } })).json()).id;
      if (!room2) throw new Error("no room2");
      const room0 = room; room = room2;
      const c2 = await patronCtx(browser, L, V); await join(c2.page, L, room, "Fail" + ci); await mockSearch(c2.page, []);
      const box = searchBox(c2.page, L); await box.fill(`pick ${failId} ${PATRON}`);
      const resBtn = c2.page.getByRole("button", { name: new RegExp(PATRON) }).first();
      await resBtn.waitFor({ timeout: 12000 });
      await shot(c2.page, combo, "fail-picker-results");
      await resBtn.click();
      await c2.page.getByText(P.selected.replace("{videoId}", failId), { exact: false }).waitFor({ timeout: 8000 });
      await c2.page.getByRole("button", { name: P.addToQueue }).click();
      await c2.page.getByText(P.songAdded, { exact: false }).waitFor({ timeout: 12000 });
      await c2.page.getByText(`youtu.be/${failId}`).first().waitFor({ timeout: 12000 });
      const body = await c2.page.locator("body").innerText();
      await shot(c2.page, combo, "fail-queue");
      if (body.includes(PATRON)) throw new Error("patron text visible in patron queue (after submit)");
      // direct API with an evil title
      const evilId = `apFailD${pad}xxx`.slice(0, 11);
      const r = await c2.page.request.post(`${BASE}/api/queue`, { data: { youtubeUrl: `https://youtu.be/${evilId}`, title: "EVIL_API_TITLE", nickname: "Api", patronUuid: "11111111-1111-4111-8111-" + String(ci).padStart(12, "0"), room, mode: "sing", table: "" } });
      const apiStatus = r.status();
      await hp.goto(`${BASE}/${room}/admin`);
      await hp.getByText(`youtu.be/${failId}`).first().waitFor({ timeout: 15000 });
      const adm = await hp.locator("body").innerText(); await shot(hp, combo, "fail-host-admin");
      if (adm.includes(PATRON) || adm.includes("EVIL_API_TITLE")) throw new Error("patron text on host admin");
      const tv = await host.newPage(); await tv.setViewportSize(VPS[V]);
      await tv.goto(`${BASE}/${room}/tv`);
      await tv.getByText(/youtu\.be\//).first().waitFor({ timeout: 45000 });
      const tvb = await tv.evaluate(() => document.body.innerText); await shot(tv, combo, "fail-tv");
      await tv.close(); await c2.ctx.close(); room = room0;
      if (tvb.includes(PATRON) || tvb.includes("EVIL_API_TITLE")) throw new Error("patron text on TV");
      if (!/youtu\.be\/apFail/.test(tvb)) throw new Error("TV does not show youtu.be/<id>: " + tvb.replace(/\n+/g, " | ").slice(0, 300));
      const qj = await (await hp.request.get(`${BASE}/api/queue?room=${room}`)).json();
      const stored = qj.items.filter((e) => e.videoId === failId || e.videoId === evilId).map((e) => `${e.videoId}:${e.title ?? "none"}`);
      if (qj.items.some((e) => (e.videoId === failId || e.videoId === evilId) && e.title)) throw new Error("title stored for failed lookup " + stored);
      return `api POST ${apiStatus}; stored ${stored.join(",")}; TV has youtu.be: ${tvb.includes("youtu.be/" + failId)}`;
    });

    // 3. 512 limit
    await step(combo, "3 very long paste is cut off at 512, no freeze", async () => {
      const box = searchBox(page, L); await box.fill(""); await box.click();
      const long = "a".repeat(5000);
      const t0 = Date.now(); await page.keyboard.insertText(long);
      const val = await box.inputValue(); const dt = Date.now() - t0;
      const alive = await Promise.race([page.evaluate(() => 1 + 1), sleep(5000).then(() => "frozen")]);
      await shot(page, combo, "long-paste-5000");
      if (val.length > 512) throw new Error("not cut: " + val.length);
      if (alive !== 2) throw new Error("page frozen");
      await box.fill("ok" + "x"); await page.keyboard.type("y");
      const v2 = await box.inputValue();
      return `kept ${val.length} chars in ${dt}ms; still typable (${v2})`;
    });
    await step(combo, "3 programmatic 100k string (bypasses maxLength): refused/handled, no freeze", async () => {
      const box = searchBox(page, L); const t0 = Date.now();
      await box.fill("(".repeat(100000));
      const alive = await Promise.race([page.evaluate(() => 1 + 1), sleep(8000).then(() => "frozen")]);
      const dt = Date.now() - t0;
      const sel = await page.getByText(P.selected.replace("{videoId}", ""), { exact: false }).count();
      await shot(page, combo, "long-paste-100k");
      if (alive !== 2) throw new Error("frozen");
      await box.fill(""); await box.fill("https://youtu.be/dQw4w9WgXcQ " + "z".repeat(600));
      const fake = await page.getByText(P.selected.replace("{videoId}", "dQw4w9WgXcQ"), { exact: false }).count();
      return `100k fill ${dt}ms alive; selected-line count ${sel}; link+600 junk selects video: ${fake > 0}`;
    });
    await step(combo, "3 link followed by long junk in a real paste: link kept (within 512) and queueable", async () => {
      const box = searchBox(page, L); await box.fill(""); await box.click();
      const id = `apOkLo${"C" + pad}xx`.slice(0, 11);
      await page.keyboard.insertText(`https://youtu.be/${id} ` + "z".repeat(900));
      const val = await box.inputValue();
      await page.getByText(P.selected.replace("{videoId}", id), { exact: false }).waitFor({ timeout: 8000 });
      await shot(page, combo, "long-paste-with-link");
      return `value ${val.length} chars, link still recognised`;
    });

    // 4. hint in 429 and error states
    for (const [tag, q, expect] of [["429", "zz429 a", S.rateLimited], ["429-server-copy", "zz429srv a", "SERVER_COPY_429"], ["500-json", "zz500json a", null], ["500-plaintext", "zz500 a", null], ["network-abort", "zzabort a", S.degraded], ["degraded-200", "zzdeg a", null]]) {
      await step(combo, `4 state ${tag} shows paste hint`, async () => {
        const box = searchBox(page, L); await box.fill(""); await box.fill(q);
        let el;
        if (expect) el = page.getByText(expect, { exact: false }).first();
        else el = page.getByTestId("search-degraded");
        try { await el.waitFor({ timeout: 12000 }); } catch (e) { await shot(page, combo, `state-${tag}-NOHINT`); if (tag.startsWith("500")) return "OBS: an HTTP 500 from /api/search shows nothing (route never returns 500, it answers degraded JSON; pre-existing, unreachable)"; throw new Error("no message shown; body: " + (await page.locator("body").innerText()).replace(/\n+/g, " | ").slice(0, 300)); }
        const txt = (await el.textContent()).trim(); const bb = await el.boundingBox();
        await shot(page, combo, `state-${tag}`);
        if (!bb || bb.x < 0 || bb.x + bb.width > VPS[V].width + 1 || !(await noOverflow(page))) throw new Error("overflow " + JSON.stringify(bb));
        if (tag !== "429-server-copy" && !HINT.test(txt)) throw new Error("no paste hint in: " + txt);
        return txt;
      });
    }
    // real server 429 copy (ci==1 only; 31 calls from one uuid, unmocked)
    if (ci === 1) await step(combo, "4 real server 429 body carries the paste hint", async () => {
      const c2 = await patronCtx(browser, L, V); let last;
      for (let i = 0; i < 40; i++) { last = await c2.page.request.get(`${BASE}/api/search?q=${encodeURIComponent("real term " + i)}&uuid=${crypto.randomUUID()}&v=2`); if (last.status() === 429) break; await sleep(50); }
      const st = last.status(); const body = await last.text(); await c2.ctx.close();
      if (st !== 429) return `no 429 reached (status ${st}); skipped`;
      if (!HINT.test(body)) throw new Error("429 body: " + body);
      return body.slice(0, 200);
    });

    // 5. regression
    await step(combo, "5 normal search + pick + queue", async () => {
      const c2 = await patronCtx(browser, L, V); await join(c2.page, L, room, "Srch" + ci); await mockSearch(c2.page, []);
      const id = `apOkSr${"C" + pad}xx`.slice(0, 11);
      const box = searchBox(c2.page, L); await box.fill(`pick ${id} Imagination Cover`);
      await c2.page.getByRole("button", { name: /Imagination Cover/ }).first().click();
      await c2.page.getByText(P.selected.replace("{videoId}", id), { exact: false }).waitFor({ timeout: 8000 });
      await c2.page.getByRole("button", { name: P.addToQueue }).click();
      await c2.page.getByText(P.songAdded, { exact: false }).waitFor({ timeout: 12000 });
      const row = c2.page.getByTestId("queue-row-title").filter({ hasText: `Música Teste ${id}` }).first(); await row.waitFor({ timeout: 12000 });
      const t = (await row.textContent()).trim(); await shot(c2.page, combo, "search-queued"); await c2.ctx.close();
      return t;
    });
    await step(combo, "5 not-embeddable refused, nothing queued", async () => {
      const id = `apBlockC${pad}x`.slice(0, 11);
      const box = searchBox(page, L); await box.fill(""); await box.fill(`https://youtu.be/${id}`);
      await page.getByText(P.selected.replace("{videoId}", id), { exact: false }).waitFor({ timeout: 8000 });
      await page.getByRole("button", { name: P.addToQueue }).click();
      const el = page.getByText(E.submitNotEmbeddable, { exact: false }).first(); await el.waitFor({ timeout: 12000 });
      const bb = await el.boundingBox(); await shot(page, combo, "not-embeddable");
      const q = await (await page.request.get(`${BASE}/api/queue?room=${room}`)).json();
      if (q.items.some((e) => e.videoId === id)) throw new Error("blocked queued");
      if (!bb || bb.x < 0 || bb.x + bb.width > VPS[V].width + 1 || !(await noOverflow(page))) throw new Error("copy overflow");
      return "refused";
    });
    await step(combo, "5 host admin + TV show real titles for resolved songs", async () => {
      await hp.goto(`${BASE}/${room}/admin`); await hp.getByTestId("queue-row").first().waitFor({ timeout: 15000 });
      const adm = await hp.locator("body").innerText();
      if (!/Música Teste/.test(adm)) throw new Error("no real title on admin");
      await shot(hp, combo, "host-admin");
      return "ok";
    });
    await ctx.close(); await host.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(HERE, `results${ONLY.length ? "-" + ONLY.join("_") : ""}.json`), JSON.stringify(results, null, 1));
  const f = results.filter((r) => !r.pass);
  console.log(`DONE ${results.length - f.length}/${results.length} pass`);
}
run().catch((e) => { console.error("FATAL", e); process.exit(2); });
