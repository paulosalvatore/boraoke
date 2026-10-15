// App Tester harness for TICKET-124 (PR #88). Headless Chromium, own browser
// context, dedicated port. Never calls YouTube: the server runs with no
// YOUTUBE_API_KEY and a local index fixture (KARAOKE_INDEX_FILE).
// Usage: node apptest.mjs <evidenceDir> <baseUrl>
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [, , EVIDENCE_DIR, BASE = "http://127.0.0.1:3134"] = process.argv;
if (!EVIDENCE_DIR || !path.isAbsolute(EVIDENCE_DIR)) throw new Error("absolute evidence dir required");
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const log = [];
const note = (...a) => { const s = a.join(" "); log.push(s); console.log(s); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "desktop", width: 1280, height: 800 },
];

async function run(vp) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, locale: "pt-BR",
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
  const searchCalls = [];
  page.on("response", async (res) => {
    if (!res.url().includes("/api/search")) return;
    let body = {};
    try { body = await res.json(); } catch {}
    const u = new URL(res.url());
    searchCalls.push({
      q: u.searchParams.get("q"), page: u.searchParams.get("page"),
      pageToken: u.searchParams.get("pageToken"), status: res.status(),
      source: body.source ?? (body.cached ? "cache" : body.degraded ? `degraded:${body.reason}` : "live"),
      n: (body.results || []).length, next: body.nextPageToken ?? null,
      titles: (body.results || []).map((r) => r.title),
    });
  });
  const shot = async (n) => {
    const f = path.join(EVIDENCE_DIR, `${vp.name}-${n}.png`);
    await page.screenshot({ path: f, fullPage: true });
    note(`  shot ${path.basename(f)}`);
  };

  // Join the default room as a patron.
  await page.goto(`${BASE}/default`);
  await page.getByPlaceholder(/ex\.: Maria/i).fill(`Tester ${vp.name}`);
  await page.getByRole("button", { name: /entrar na fila/i }).click();
  await page.getByRole("heading", { name: /adicionar música/i }).waitFor();
  const input = page.getByLabel(/Buscar música/i);
  const sing = page.getByRole("radio", { name: /Cantar/i });
  const listen = page.getByRole("radio", { name: /Só curtir/i });
  await sing.check();

  async function search(q, label, { slow = false } = {}) {
    const before = searchCalls.length;
    if (slow) {
      await page.route("**/api/search**", async (r) => { await wait(1500); await r.continue(); });
    }
    await input.fill("");
    await input.fill(q);
    if (slow) {
      await page.getByTestId("search-skeleton").waitFor({ timeout: 5000 });
      await shot(`${label}-loading`);
    }
    for (let i = 0; i < 60 && searchCalls.length === before; i++) await wait(100);
    if (slow) await page.unroute("**/api/search**");
    await page.getByTestId("search-skeleton").waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
    await wait(300);
    const c = searchCalls[searchCalls.length - 1];
    const rows = await page.locator("button.song-row").count();
    const degraded = await page.getByTestId("search-degraded").isVisible().catch(() => false);
    note(`[${vp.name}] "${q}" -> api q="${c?.q}" status=${c?.status} source=${c?.source} apiRows=${c?.n} uiRows=${rows} degraded=${degraded}`);
    await shot(label);
    await wait(2200); // stay under the 5-per-10s per-uuid search window
    return { c, rows, degraded };
  }

  // 1. common PT-BR songs (sing mode)
  const ev = await search("evidencias", "01-sing-evidencias", { slow: true });
  const esc = await search("escurinho do cinema", "02-sing-escurinho-do-cinema");
  const escp = await search("escurinho do cin", "03-sing-escurinho-do-cin-partial");
  const ze = await search("ze ramalho", "04-sing-ze-ramalho");
  const br = await search("brasil karaoke", "05-sing-brasil-karaoke");
  const br2 = await search("brasil", "06-sing-brasil");
  for (const [k, r] of [["brasil karaoke", br], ["brasil", br2]]) {
    const bad = (r.c?.titles || []).filter((t) => !/brasil/i.test(t));
    note(`[${vp.name}] channel-dump check "${k}": ${r.c?.n} rows, ${bad.length} without "brasil" in title ${bad.length ? JSON.stringify(bad) : ""}`);
  }
  // 2. typos / partials
  await search("evidencas", "07-sing-typo-evidencas");
  await search("ze ramlho", "08-sing-typo-ze-ramlho");
  await search("evid", "09-sing-partial-evid");
  await search("zeca pagod", "10-sing-partial-zeca-pagod");
  // 3. no index match, live unavailable
  await search("xyzzyqq florbix", "11-sing-no-match-live-unavailable");

  // 4. load more past an index answer
  await search("evidencias", "12-loadmore-0-index-answer");
  for (let tap = 1; tap <= 4; tap++) {
    const lm = page.getByTestId("search-load-more");
    if (!(await lm.isVisible().catch(() => false))) { note(`[${vp.name}] load-more not visible before tap ${tap}`); break; }
    const before = searchCalls.length;
    await lm.click();
    await wait(1200);
    const rows = await page.locator("button.song-row").count();
    const newCall = searchCalls.length > before ? searchCalls[searchCalls.length - 1] : null;
    note(`[${vp.name}] load-more tap ${tap}: uiRows=${rows} newRequest=${newCall ? JSON.stringify({ page: newCall.page, pageToken: newCall.pageToken, source: newCall.source, status: newCall.status }) : "none"} degraded=${await page.getByTestId("search-degraded").isVisible().catch(() => false)}`);
    await shot(`13-loadmore-tap${tap}`);
    if (newCall) break;
  }
  await wait(2500);

  // 5. listen mode — index must not answer
  await listen.check();
  await wait(800);
  const callsBeforeFlip = searchCalls.length;
  note(`[${vp.name}] mode flip fetched: ${searchCalls.length !== callsBeforeFlip}`);
  await search("evidencias ", "14-listen-evidencias");

  // 6. queue an index-found song end to end
  await sing.check();
  const q = await search("escurinho do cin", "15-queue-0-search");
  await page.locator("button.song-row").first().click();
  await page.getByRole("button", { name: /adicionar à fila/i }).click();
  await page.getByText(/música na fila/i).first().waitFor({ timeout: 8000 });
  await shot("16-queue-1-queued");
  const title = q.c?.titles?.[0] ?? "";
  const qres = await page.request.get(`${BASE}/api/queue`);
  const qjson = await qres.json().catch(() => ({}));
  note(`[${vp.name}] /api/queue contains picked title: ${JSON.stringify(qjson).includes(title.slice(0, 20))} (title="${title}")`);
  const tv = await ctx.newPage();
  await tv.setViewportSize({ width: 1280, height: 720 });
  await tv.goto(`${BASE}/default/tv`);
  await wait(4000);
  const tvText = await tv.locator("body").innerText();
  note(`[${vp.name}] /tv shows picked title: ${tvText.includes(title.slice(0, 20))}`);
  await tv.screenshot({ path: path.join(EVIDENCE_DIR, `${vp.name}-17-tv-shows-queued.png`) });
  note(`  shot ${vp.name}-17-tv-shows-queued.png`);
  await tv.close();

  note(`[${vp.name}] console errors: ${consoleErrors.length} ${JSON.stringify(consoleErrors.slice(0, 10))}`);
  fs.writeFileSync(path.join(EVIDENCE_DIR, `${vp.name}-search-calls.json`), JSON.stringify(searchCalls, null, 2));
  await browser.close();
}

for (const vp of VIEWPORTS) {
  await run(vp);
  // Drain the queue between viewports is not needed: each viewport queues its own row.
  await wait(11000); // fresh rate-limit window
}
fs.writeFileSync(path.join(EVIDENCE_DIR, "run-log.txt"), log.join("\n") + "\n");
