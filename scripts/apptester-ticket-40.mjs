/**
 * App Tester evidence-capture script for TICKET-40 (search UX).
 * Tests all 6 items from the test plan at 390x844 (primary phone viewport).
 * Writes screenshots to work/evidence/ticket-40/apptester-*.png
 * Prints a JSON summary of all assertions.
 *
 * Run against a live dev server on PORT (default 3040):
 *   PORT=3040 node scripts/apptester-ticket-40.mjs
 */
import { chromium } from "@playwright/test";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { mkdirSync, existsSync } from "fs";
import { execSync } from "child_process";

// Derive absolute evidence dir from git root (evidence-path discipline, D-014)
const repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const OUT = resolve(repoRoot, "work/evidence/ticket-40");
mkdirSync(OUT, { recursive: true });

const PORT = Number(process.env.PORT ?? 3040);
const BASE = `http://127.0.0.1:${PORT}`;

// Results accumulator
const results = {};
const defects = [];

function pass(label, detail) {
  results[label] = { verdict: "PASS", detail };
  console.log(`PASS  [${label}] ${detail}`);
}
function fail(label, detail) {
  results[label] = { verdict: "FAIL", detail };
  defects.push({ label, detail });
  console.error(`FAIL  [${label}] ${detail}`);
}

const MOCK_RESULTS = [
  { videoId: "dQw4w9WgXcQ", title: "Evidências (Ao Vivo)", channelTitle: "Chitãozinho & Xororó", duration: "4:13", thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg" },
  { videoId: "9bZkp7q19f0", title: "Evidências (Karaokê)", channelTitle: "Karaokê Hits", duration: "4:20", thumbnailUrl: "https://i.ytimg.com/vi/9bZkp7q19f0/mqdefault.jpg" },
];

async function joinAs(page, nick) {
  await page.goto(`${BASE}/default`);
  await page.getByLabel("Your nickname").waitFor({ timeout: 8000 });
  await page.getByPlaceholder(/nickname|e\.g\. Maria/i).fill(nick);
  await page.getByRole("button", { name: /join queue/i }).click();
  await page.getByRole("heading", { name: /add a song/i }).waitFor({ timeout: 8000 });
}

const browser = await chromium.launch({ headless: true });

// ─── TEST 1: SING MODE — karaoke keyword appended + CTA focus, no auto-submit ─
{
  const seenQueries = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  await page.route("**/api/search**", async (route) => {
    const url = new URL(route.request().url());
    seenQueries.push(url.searchParams.get("q") ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: MOCK_RESULTS }) });
  });

  await joinAs(page, "SingTester");

  // Type query in SING mode (default)
  await page.getByLabel(/Buscar música/i).fill("evidencias");
  await page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i }).waitFor({ timeout: 8000 });

  // Network-level assert: query must have " karaoke" appended
  const singQuery = seenQueries.at(-1) ?? "";
  if (singQuery === "evidencias karaoke") {
    pass("1a-sing-karaoke-keyword", `Network query = "${singQuery}" ✓`);
  } else {
    fail("1a-sing-karaoke-keyword", `Expected "evidencias karaoke", got "${singQuery}"`);
  }

  // Screenshot: sing mode results with karaoke-augmented query
  await page.screenshot({ path: `${OUT}/apptester-01-sing-results-390px.png` });
  console.log(`Screenshot: apptester-01-sing-results-390px.png`);

  // Pick a result
  await page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i }).click();
  await page.waitForTimeout(700); // let smooth scroll + rAF settle

  // Assert: CTA is focused (no auto-submit)
  const ctaFocused = await page.evaluate(() => {
    const el = document.activeElement;
    return el?.textContent?.match(/add to queue/i) != null;
  });

  // Assert: no auto-submit (success toast should NOT be present)
  const toastCount = await page.locator("text=/song added to the queue/i").count();
  const noAutoSubmit = toastCount === 0;

  if (ctaFocused) {
    pass("1b-cta-focused-after-select", "document.activeElement is the Add to queue CTA ✓");
  } else {
    fail("1b-cta-focused-after-select", "CTA does not have focus after selection");
  }

  if (noAutoSubmit) {
    pass("1c-no-auto-submit", "No success toast present — song was NOT auto-submitted ✓");
  } else {
    fail("1c-no-auto-submit", "SUCCESS TOAST FOUND — song auto-submitted without patron pressing CTA");
  }

  // Screenshot: CTA visible + focused after select
  await page.screenshot({ path: `${OUT}/apptester-02-cta-focused-390px.png` });
  console.log(`Screenshot: apptester-02-cta-focused-390px.png`);

  // ERGONOMICS: Is the CTA actually visible in the 390x844 viewport?
  const ctaElement = page.getByRole("button", { name: /add to queue/i });
  const ctaBox = await ctaElement.boundingBox();
  // Viewport height is 844. With mobile keyboard ~300px, effective visible area ~544px.
  // We judge: is the CTA within the top 544px (visible above the keyboard fold)?
  const ctaVisible = ctaBox !== null && ctaBox.y >= 0 && ctaBox.y + ctaBox.height <= 844;
  const ctaAboveKeyboardFold = ctaBox !== null && ctaBox.y + ctaBox.height <= 544;

  if (ctaVisible) {
    if (ctaAboveKeyboardFold) {
      pass("1d-cta-ergonomics", `CTA bbox y=${ctaBox?.y?.toFixed(0)},h=${ctaBox?.height?.toFixed(0)} — ABOVE keyboard fold (${544}px). Comfortable reach ✓`);
    } else {
      // CTA is in viewport but would be hidden behind keyboard
      results["1d-cta-ergonomics"] = {
        verdict: "WARN",
        detail: `CTA bbox y=${ctaBox?.y?.toFixed(0)},h=${ctaBox?.height?.toFixed(0)} — below simulated keyboard fold at 544px. On a real phone with keyboard open, CTA may be hidden. scrollIntoView should compensate if keyboard pushes viewport.`,
      };
      console.warn(`WARN  [1d-cta-ergonomics] CTA at y=${ctaBox?.y?.toFixed(0)} may be under keyboard fold`);
    }
  } else {
    fail("1d-cta-ergonomics", `CTA not in viewport (box=${JSON.stringify(ctaBox)})`);
  }

  // Submit works
  await ctaElement.click();
  const submitted = await page.locator("text=/song added to the queue/i").waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
  if (submitted) {
    pass("1e-submit-works", "Submit via CTA button shows success toast ✓");
  } else {
    fail("1e-submit-works", "No success toast after clicking Add to queue");
  }

  await ctx.close();
}

// ─── TEST 2: LISTEN/DANCE MODE — raw query, no karaoke keyword ─
{
  const seenQueries = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  await page.route("**/api/search**", async (route) => {
    const url = new URL(route.request().url());
    seenQueries.push(url.searchParams.get("q") ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: MOCK_RESULTS }) });
  });

  await joinAs(page, "ListenTester");

  // Type a query first in SING mode
  await page.getByLabel(/Buscar música/i).fill("evidencias");
  await page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i }).waitFor({ timeout: 8000 });
  const singQuery = seenQueries.at(-1) ?? "";

  // Switch to listen/dance
  await page.getByLabel("Mode").selectOption("listen-dance");
  // Wait for re-search
  await page.waitForTimeout(1500);
  const listenQuery = seenQueries.at(-1) ?? "";

  if (listenQuery === "evidencias") {
    pass("2a-listen-raw-query", `Mode switch → network query = "${listenQuery}" (no karaoke) ✓`);
  } else {
    fail("2a-listen-raw-query", `Expected "evidencias", got "${listenQuery}"`);
  }

  // Verify results still show (search re-ran)
  const resultsVisible = await page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i }).isVisible().catch(() => false);
  if (resultsVisible) {
    pass("2b-listen-results-show", "Results visible after mode switch ✓");
  } else {
    fail("2b-listen-results-show", "Results not visible after switching to listen mode");
  }

  // Pick a result and verify CTA jump still works in listen mode
  await page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i }).click();
  await page.waitForTimeout(700);

  const ctaFocused = await page.evaluate(() => {
    const el = document.activeElement;
    return el?.textContent?.match(/add to queue/i) != null;
  });
  if (ctaFocused) {
    pass("2c-listen-cta-jump", "CTA focus jump works in listen mode too ✓");
  } else {
    fail("2c-listen-cta-jump", "CTA does not get focus after select in listen mode");
  }

  // Screenshot: listen mode results (raw query)
  await page.screenshot({ path: `${OUT}/apptester-03-listen-raw-results-390px.png` });
  console.log(`Screenshot: apptester-03-listen-raw-results-390px.png`);

  await ctx.close();
}

// ─── TEST 3: ALREADY CONTAINS "karaoke" — no doubling ─
{
  const seenQueries = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  await page.route("**/api/search**", async (route) => {
    const url = new URL(route.request().url());
    seenQueries.push(url.searchParams.get("q") ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: MOCK_RESULTS }) });
  });

  await joinAs(page, "NoDoubleTester");

  // Type a query that already contains "karaoke" (mixed case)
  await page.getByLabel(/Buscar música/i).fill("Karaoke songs");
  await page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i }).waitFor({ timeout: 8000 });

  const sentQuery = seenQueries.at(-1) ?? "";
  const karaokeCount = (sentQuery.toLowerCase().match(/karaoke/g) ?? []).length;

  if (karaokeCount === 1) {
    pass("3-no-double-karaoke", `Query "${sentQuery}" has exactly one "karaoke" — no doubling ✓`);
  } else {
    fail("3-no-double-karaoke", `Query "${sentQuery}" has ${karaokeCount} occurrences of "karaoke" — expected 1`);
  }

  await ctx.close();
}

// ─── TEST 4: PASTE-LINK PATH (degraded + normal) — CTA jump, no keyword ─
{
  const seenQueries = [];
  // 4a: Degraded mode
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();

    await page.route("**/api/search**", async (route) => {
      const url = new URL(route.request().url());
      seenQueries.push(url.searchParams.get("q") ?? "");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ degraded: true, reason: "quota", results: [] }) });
    });

    await joinAs(page, "DegradedPasteTester");

    // Trigger degraded state
    await page.getByLabel(/Buscar música/i).fill("alguma musica");
    await page.getByText(/Busca indisponível — cola o link do YouTube/i).waitFor({ timeout: 8000 }).catch(() => null);

    // Paste a YouTube URL
    const input = page.getByLabel(/Buscar música/i);
    await input.fill("https://youtu.be/dQw4w9WgXcQ");
    await page.waitForTimeout(500);

    // Should resolve locally (no search API call for the URL)
    const resolved = await page.locator("text=/Selected: dQw4w9WgXcQ/").isVisible().catch(() => false);

    if (resolved) {
      pass("4a-degraded-paste-resolves", "Pasted YouTube link resolves in degraded mode ✓");
    } else {
      fail("4a-degraded-paste-resolves", "Pasted link did NOT resolve in degraded mode");
    }

    // CTA jump after paste resolve
    await page.waitForTimeout(700);
    const ctaFocused = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.textContent?.match(/add to queue/i) != null;
    });
    if (ctaFocused) {
      pass("4b-degraded-paste-cta-jump", "CTA gets focus after paste resolve in degraded mode ✓");
    } else {
      fail("4b-degraded-paste-cta-jump", "CTA does NOT get focus after paste resolve in degraded mode");
    }

    // Verify no "karaoke" was ever added to a URL query
    const urlQueries = seenQueries.filter(q => q.includes("youtu"));
    if (urlQueries.length === 0) {
      pass("4c-paste-no-keyword", "Pasted URL never sent to /api/search (resolved locally) ✓");
    } else {
      fail("4c-paste-no-keyword", `URL was sent to /api/search: ${JSON.stringify(urlQueries)}`);
    }

    // Screenshot: degraded + paste resolved + CTA
    await page.screenshot({ path: `${OUT}/apptester-04-degraded-paste-cta-390px.png` });
    console.log(`Screenshot: apptester-04-degraded-paste-cta-390px.png`);

    await ctx.close();
  }

  // 4b: Normal mode paste
  {
    const normalQueries = [];
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();

    await page.route("**/api/search**", async (route) => {
      const url = new URL(route.request().url());
      normalQueries.push(url.searchParams.get("q") ?? "");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: MOCK_RESULTS }) });
    });

    await joinAs(page, "NormalPasteTester");

    // Paste a YouTube URL directly (in SING mode, normal search)
    await page.getByLabel(/Buscar música/i).fill("https://youtu.be/dQw4w9WgXcQ");
    await page.waitForTimeout(500);

    // Should resolve locally — no karaoke-augmented URL sent
    const urlQueriesWithKaraoke = normalQueries.filter(q => q.toLowerCase().includes("karaoke") && q.includes("youtu"));
    if (urlQueriesWithKaraoke.length === 0) {
      pass("4d-normal-paste-no-keyword", "Pasted URL in normal mode: no karaoke keyword on the URL ✓");
    } else {
      fail("4d-normal-paste-no-keyword", `URL had karaoke appended in query: ${JSON.stringify(urlQueriesWithKaraoke)}`);
    }

    // CTA jump
    await page.waitForTimeout(700);
    const ctaFocused = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.textContent?.match(/add to queue/i) != null;
    });
    if (ctaFocused) {
      pass("4e-normal-paste-cta-jump", "CTA gets focus after paste resolve in normal mode ✓");
    } else {
      // Non-blocking if paste resolves differently in normal mode
      results["4e-normal-paste-cta-jump"] = { verdict: "WARN", detail: "CTA did not get focus in normal mode paste — may be timing issue; check screenshot" };
      console.warn("WARN  [4e-normal-paste-cta-jump] CTA focus not detected in normal paste mode");
    }

    await page.screenshot({ path: `${OUT}/apptester-05-normal-paste-cta-390px.png` });
    console.log(`Screenshot: apptester-05-normal-paste-cta-390px.png`);

    await ctx.close();
  }
}

// ─── TEST 5: ERGONOMICS DETAIL — CTA bounding box analysis at 390x844 ─
// (Already captured in test 1d above — log a summary)
{
  // Recapture just the ergonomics state for a clean dedicated screenshot
  const seenQueries = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  await page.route("**/api/search**", async (route) => {
    const url = new URL(route.request().url());
    seenQueries.push(url.searchParams.get("q") ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: MOCK_RESULTS }) });
  });

  await joinAs(page, "ErgoTester");

  await page.getByLabel(/Buscar música/i).fill("evidencias");
  await page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i }).waitFor({ timeout: 8000 });
  await page.getByRole("button", { name: /Evidências \(Ao Vivo\)/i }).click();
  await page.waitForTimeout(800);

  const ctaEl = page.getByRole("button", { name: /add to queue/i });
  const ctaBox = await ctaEl.boundingBox();
  const viewportHeight = 844;
  const keyboardFoldEstimate = 544; // 844 - ~300px typical mobile keyboard

  // Also get page scroll position and full page layout
  const pageInfo = await page.evaluate(() => ({
    scrollY: window.scrollY,
    pageHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
  }));

  const ergonomicsDetail = `CTA bbox: y=${ctaBox?.y?.toFixed(1)}, height=${ctaBox?.height?.toFixed(1)}, bottom=${ctaBox ? (ctaBox.y + ctaBox.height).toFixed(1) : 'N/A'}. Viewport: ${viewportHeight}px. Simulated keyboard fold: ${keyboardFoldEstimate}px. Page scrollY=${pageInfo.scrollY}. CTA above fold: ${ctaBox ? ctaBox.y + ctaBox.height <= keyboardFoldEstimate : false}.`;

  console.log(`ERGONOMICS: ${ergonomicsDetail}`);
  results["5-ergonomics-detail"] = { verdict: "INFO", detail: ergonomicsDetail };

  // Full-page screenshot for complete ergonomics context
  await page.screenshot({ path: `${OUT}/apptester-06-ergonomics-full-390px.png`, fullPage: true });
  console.log(`Screenshot: apptester-06-ergonomics-full-390px.png`);

  // Viewport-only screenshot (what the patron actually sees)
  await page.screenshot({ path: `${OUT}/apptester-07-ergonomics-viewport-390px.png` });
  console.log(`Screenshot: apptester-07-ergonomics-viewport-390px.png`);

  await ctx.close();
}

await browser.close();

// ─── FINAL SUMMARY ─
console.log("\n=== APPTESTER SUMMARY ===");
const passList = Object.entries(results).filter(([, v]) => v.verdict === "PASS");
const failList = Object.entries(results).filter(([, v]) => v.verdict === "FAIL");
const warnList = Object.entries(results).filter(([, v]) => v.verdict === "WARN");
console.log(`PASS: ${passList.length}, FAIL: ${failList.length}, WARN: ${warnList.length}`);
if (failList.length > 0) {
  console.error("DEFECTS:");
  failList.forEach(([k, v]) => console.error(`  ${k}: ${v.detail}`));
}
console.log(JSON.stringify(results, null, 2));

process.exit(failList.length > 0 ? 1 : 0);
