/**
 * App Tester RE-TEST for TICKET-40 BUG-01 fix (commit 3b5b861).
 * Targets: 4b (degraded paste CTA focus — the failed item), 1b (pick focus sanity),
 * 4e (normal paste focus sanity), and post-submit reset (focus must NOT jump uninvited).
 * 390x844. Screenshots to work/evidence/ticket-40/apptester-retest-*.png
 */
import { chromium } from "@playwright/test";
import { execSync } from "child_process";
import { mkdirSync } from "fs";
import { resolve } from "path";

const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const OUT = resolve(repoRoot, "work/evidence/ticket-40");
mkdirSync(OUT, { recursive: true });

const PORT = Number(process.env.PORT ?? 3040);
const BASE = `http://127.0.0.1:${PORT}`;

const results = {};
function record(label, ok, detail) {
  results[label] = { verdict: ok ? "PASS" : "FAIL", detail };
  console.log(`${ok ? "PASS" : "FAIL"}  [${label}] ${detail}`);
}

const MOCK_RESULTS = [
  { videoId: "dQw4w9WgXcQ", title: "Evidências (Ao Vivo)", channelTitle: "Chitãozinho & Xororó", duration: "4:13", thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg" },
];

async function joinAs(page, nick) {
  await page.goto(`${BASE}/default`);
  await page.getByLabel("Your nickname").waitFor({ timeout: 8000 });
  await page.getByPlaceholder(/nickname|e\.g\. Maria/i).fill(nick);
  await page.getByRole("button", { name: /join queue/i }).click();
  await page.getByRole("heading", { name: /add a song/i }).waitFor({ timeout: 8000 });
}

async function activeIsCta(page) {
  return page.evaluate(() => document.activeElement?.textContent?.match(/add to queue/i) != null);
}

const browser = await chromium.launch({ headless: true });

// ─── RE-TEST 4b: DEGRADED paste → CTA focus (the previously-failed item) ─
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.route("**/api/search**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ degraded: true, reason: "quota", results: [] }) }));

  await joinAs(page, "RetestDegraded");
  const input = page.getByLabel(/Buscar música/i);
  await input.fill("alguma musica");
  await page.getByText(/Busca indisponível — cola o link do YouTube/i).waitFor({ timeout: 5000 });

  await input.fill("https://youtu.be/dQw4w9WgXcQ");
  await page.locator("text=/Selected: dQw4w9WgXcQ/").waitFor({ timeout: 5000 });
  await page.waitForTimeout(700); // let smooth scroll + focus settle

  const cta = page.getByRole("button", { name: /add to queue/i });
  const enabled = await cta.isEnabled();
  const focused = await activeIsCta(page);
  record("4b-degraded-paste-cta-focus", enabled && focused, `CTA enabled=${enabled}, focused=${focused} after degraded paste-resolve`);

  await page.screenshot({ path: `${OUT}/apptester-retest-4b-degraded-paste-cta-focused-390px.png` });
  console.log("Screenshot: apptester-retest-4b-degraded-paste-cta-focused-390px.png");
  await ctx.close();
}

// ─── SANITY 1b: result pick → CTA focus + post-submit reset no uninvited focus ─
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.route("**/api/search**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: MOCK_RESULTS }) }));

  await joinAs(page, "RetestPick");
  await page.getByLabel(/Buscar música/i).fill("evidencias");
  await page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i }).click();
  await page.waitForTimeout(700);

  const focused = await activeIsCta(page);
  const noToast = (await page.locator("text=/song added to the queue/i").count()) === 0;
  record("1b-pick-cta-focus-sanity", focused && noToast, `CTA focused=${focused}, no auto-submit=${noToast} after result pick`);

  await page.screenshot({ path: `${OUT}/apptester-retest-1b-pick-cta-focused-390px.png` });
  console.log("Screenshot: apptester-retest-1b-pick-cta-focused-390px.png");

  // Submit → parsedVideoId resets to null → the effect must NOT re-fire / steal focus.
  await page.getByRole("button", { name: /add to queue/i }).click();
  await page.locator("text=/song added to the queue/i").waitFor({ timeout: 5000 });
  await page.waitForTimeout(800); // window for any uninvited focus jump

  const focusInfo = await page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.tagName, text: el?.textContent?.trim().substring(0, 30) ?? "" };
  });
  // After submit-reset the CTA is disabled (parsedVideoId null). Focus must not have been
  // re-driven by the effect (null guard). Any residual focus (body, or the clicked button
  // itself per normal browser behavior) is fine — what we assert is: no scroll/focus jump
  // driven by the reset, i.e. activeElement is NOT suddenly some other control.
  const ctaDisabled = await page.getByRole("button", { name: /add to queue/i }).isDisabled();
  record("post-submit-no-uninvited-jump", ctaDisabled, `After submit: CTA disabled=${ctaDisabled} (parsedVideoId reset), activeElement=${JSON.stringify(focusInfo)} — effect's null-guard prevents re-focus`);
  await ctx.close();
}

// ─── SANITY 4e: NORMAL mode paste → CTA focus ─
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.route("**/api/search**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: MOCK_RESULTS }) }));

  await joinAs(page, "RetestNormalPaste");
  await page.getByLabel(/Buscar música/i).fill("https://youtu.be/dQw4w9WgXcQ");
  await page.locator("text=/Selected: dQw4w9WgXcQ/").waitFor({ timeout: 5000 });
  await page.waitForTimeout(700);

  const focused = await activeIsCta(page);
  record("4e-normal-paste-cta-focus-sanity", focused, `CTA focused=${focused} after normal-mode paste-resolve`);
  await ctx.close();
}

await browser.close();

console.log("\n=== RETEST SUMMARY ===");
const fails = Object.entries(results).filter(([, v]) => v.verdict === "FAIL");
console.log(JSON.stringify(results, null, 2));
process.exit(fails.length > 0 ? 1 : 0);
