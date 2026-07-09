import { chromium } from "@playwright/test";

const PORT = process.env.PORT ?? "3430";
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.OUT ?? "work/evidence/ticket-30";

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log("wrote", `${OUT}/${name}.png`);
}

const browser = await chromium.launch();

// pt-BR default (force pt-BR Accept-Language)
{
  const ctx = await browser.newContext({ locale: "pt-BR", viewport: { width: 480, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/new`, { waitUntil: "networkidle" });
  await shot(page, "01-new-ptBR-default");
  // open the switcher menu
  await page.getByTestId("lang-switcher-trigger").click();
  await page.getByTestId("lang-switcher-menu").waitFor();
  await shot(page, "02-switcher-menu-open");
  await ctx.close();
}

// English via switcher
{
  const ctx = await browser.newContext({ locale: "pt-BR", viewport: { width: 480, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/new`, { waitUntil: "networkidle" });
  await page.getByTestId("lang-switcher-trigger").click();
  await page.getByTestId("lang-option-en").click();
  await page.getByRole("heading", { name: /create a room/i }).waitFor();
  await shot(page, "03-new-en-after-switch");
  await ctx.close();
}

// Spanish via Accept-Language first visit
{
  const ctx = await browser.newContext({ locale: "es-MX", viewport: { width: 480, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/new`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /crear sala/i }).waitFor();
  await shot(page, "04-new-es-accept-language");
  await ctx.close();
}

await browser.close();
console.log("done");
