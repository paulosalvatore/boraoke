import { chromium } from "@playwright/test";
const BASE = "http://127.0.0.1:3430";
const OUT = process.env.OUT;
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "pt-BR", viewport: { width: 1100, height: 900 } });
const page = await ctx.newPage();
const created = await (await page.request.post(`${BASE}/api/rooms`, { data: { name: "Bar Seletor" } })).json();
console.log("room:", created.id);
await page.goto(`${BASE}/${created.id}/admin`, { waitUntil: "networkidle" });
await page.getByLabel("Código do host").fill(created.hostCode);
await page.getByRole("button", { name: /^entrar$/i }).click();
await page.getByTestId("room-language-select").waitFor({ timeout: 10000 });
// switch the room to Español via the UI
await page.getByTestId("room-language-select").selectOption("es");
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/09-admin-room-language-selector.png`, fullPage: true });
console.log("wrote 09");
await browser.close();
