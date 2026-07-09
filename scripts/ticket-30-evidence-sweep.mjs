import { chromium } from "@playwright/test";

const BASE = `http://127.0.0.1:${process.env.PORT ?? "3430"}`;
const OUT = process.env.OUT ?? "work/evidence/ticket-30";
const browser = await chromium.launch();

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log("wrote", name);
}

// Create a room + set its language to es (host flow)
const setup = await browser.newContext({ locale: "pt-BR" });
const sp = await setup.newPage();
const created = await (await sp.request.post(`${BASE}/api/rooms`, { data: { name: "Bar Evidencia" } })).json();
const roomId = created.id;
console.log("room:", roomId);
const login = await sp.request.post(`${BASE}/api/host/login?room=${roomId}`, { data: { token: created.hostCode } });
if (!login.ok()) throw new Error("host login failed");
const lang = await sp.request.post(`${BASE}/api/host/language?room=${roomId}`, { data: { language: "es" } });
if (!lang.ok()) throw new Error("set language failed");
// Seed one song so the patron queue shows entries
await sp.request.post(`${BASE}/api/queue`, { data: { room: roomId, videoId: "dQw4w9WgXcQ", title: "Evidencias (Karaoke)", nickname: "Maria", patronUuid: "12345678-1234-4123-8123-123456789012", table: "4", mode: "sing" } });

// 05 — patron page in ENGLISH (en-US browser, no cookie)
{
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 480, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/default`, { waitUntil: "networkidle" });
  await shot(page, "05-patron-en-accept-language");
  await ctx.close();
}

// 06 — patron page: room default language ES wins over en-US browser (no cookie)
{
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 480, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/${roomId}`, { waitUntil: "networkidle" });
  await shot(page, "06-patron-room-default-es-over-en-browser");
  // join to show the full patron page in es
  await page.getByLabel("Tu apodo").fill("Maria");
  await page.getByRole("button", { name: /entrar a la fila/i }).click().catch(() => {});
  await page.waitForTimeout(800);
  await shot(page, "07-patron-es-full-page");
  await ctx.close();
}

// 08 — TV follows the ROOM language (es), even with a pt-BR browser
{
  const ctx = await browser.newContext({ locale: "pt-BR", viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/${roomId}/tv`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await shot(page, "08-tv-room-language-es");
  await ctx.close();
}

// 09 — admin room-language selector (pt-BR host UI, selector shows Español)
{
  const ctx = await browser.newContext({ locale: "pt-BR", viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/${roomId}/admin`, { waitUntil: "networkidle" });
  const gate = page.getByLabel("Código do host");
  if (await gate.count()) {
    await gate.fill(created.hostCode);
    await page.getByRole("button", { name: /^entrar$/i }).click();
    await page.waitForTimeout(1200);
  }
  await shot(page, "09-admin-room-language-selector");
  await ctx.close();
}

await setup.close();
await browser.close();
console.log("done");
