// One-off evidence capture for TICKET-40 (search UX). Run against a live dev
// server on PORT (default 3040). Mocks /api/search so results render without a
// YouTube key. Writes screenshots into work/evidence/ticket-40/.
import { chromium } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3040);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = "work/evidence/ticket-40";

const MOCK_RESULTS = [
  { videoId: "dQw4w9WgXcQ", title: "Evidências (Ao Vivo)", channelTitle: "Chitãozinho & Xororó", duration: "4:13", thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg" },
  { videoId: "9bZkp7q19f0", title: "Evidências (Karaokê)", channelTitle: "Karaokê Hits", duration: "4:20", thumbnailUrl: "https://i.ytimg.com/vi/9bZkp7q19f0/mqdefault.jpg" },
];

const seenQueries = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 740 } });
const page = await ctx.newPage();

await page.route("**/api/search**", async (route) => {
  const url = new URL(route.request().url());
  seenQueries.push(url.searchParams.get("q") ?? "");
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: MOCK_RESULTS }) });
});

// Join the default room.
await page.goto(`${BASE}/default`);
await page.getByLabel("Your nickname").waitFor();
await page.getByPlaceholder(/nickname|e\.g\. Maria/i).fill("EvidenceUser");
await page.getByRole("button", { name: /join queue/i }).click();
await page.getByRole("heading", { name: /add a song/i }).waitFor();

// Sing mode is default — type a query, results render, CTA gets focus on pick.
await page.getByLabel(/Buscar música/i).fill("evidencias");
await page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i }).waitFor({ timeout: 5000 });

// Evidence 1: sing-mode results (query augmented to "evidencias karaoke").
await page.screenshot({ path: `${OUT}/01-sing-mode-results-390px.png` });

// Pick the result → CTA scrolls into view + receives focus.
await page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i }).click();
await page.waitForTimeout(600); // let smooth scroll + focus settle

// Evidence 2: focused Add-to-queue CTA after selection (mobile).
await page.screenshot({ path: `${OUT}/02-cta-focused-after-select-390px.png` });

// Sanity: confirm focus + the augmented query for the report.
const focusedIsCta = await page.evaluate(() => document.activeElement?.textContent?.match(/add to queue/i) != null);

// Switch to listen/dance → search re-runs raw.
await page.getByLabel("Mode").selectOption("listen-dance");
await page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i }).waitFor({ timeout: 5000 });
await page.waitForTimeout(300);

// Evidence 3: listen mode results (raw query, no karaoke keyword).
await page.screenshot({ path: `${OUT}/03-listen-mode-results-390px.png` });

console.log(JSON.stringify({ seenQueries, focusedIsCta }, null, 2));

await browser.close();
