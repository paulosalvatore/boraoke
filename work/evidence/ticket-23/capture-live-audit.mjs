// TICKET-23 designer live-audit capture (plain Playwright, capture-screenshots conventions).
// Captures the LIVE product surfaces + local-dev patron flow into EVIDENCE_DIR/live-audit.
import { chromium } from "@playwright/test";

const EV = new URL("./live-audit/", import.meta.url).pathname;
const LIVE = "https://cantai-snowy.vercel.app";
const LOCAL = "http://localhost:3023";

const browser = await chromium.launch();
const shot = async (page, name) =>
  page.screenshot({ path: `${EV}${name}.png` });

// ── Desktop surfaces ─────────────────────────────────────────────
const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await desktop.goto(`${LIVE}/`);
await desktop.waitForTimeout(1000);
await shot(desktop, "01-live-landing-desktop");

await desktop.goto(`${LIVE}/new`);
await desktop.waitForTimeout(500);
await shot(desktop, "02-live-new-desktop");

// Create a room to audit the created-confirmation + admin surfaces.
await desktop.fill("input", "Boteco Auditoria v2");
await desktop.click("button:has-text('Criar sala')");
await desktop.waitForSelector("text=Sala criada", { timeout: 15000 });
await shot(desktop, "03-live-room-created-desktop");

const patronUrl = await desktop
  .locator("text=/cantai-snowy.vercel.app\\//")
  .first()
  .innerText();
const slug = patronUrl.trim().split("/").pop();
const hostCode = (await desktop.locator("p:below(:text('Código do host'))").first().innerText()).trim();
console.log("room:", slug, "code:", hostCode);

// Admin: host-code gate + logged-in admin.
await desktop.goto(`${LIVE}/${slug}/admin`);
await desktop.waitForTimeout(500);
await shot(desktop, "04-live-admin-gate-desktop");
await desktop.fill("input", hostCode);
await desktop.press("input", "Enter");
await desktop.waitForSelector("text=Modo da noite", { timeout: 15000 });
await desktop.waitForTimeout(500);
await shot(desktop, "05-live-admin-desktop");

// ── TV (1080p) ───────────────────────────────────────────────────
const tv = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await tv.goto(`${LIVE}/${slug}/tv`);
await tv.waitForTimeout(1500);
await shot(tv, "06-live-tv-idle-1080p");
await tv.close();

// ── Mobile patron (live: expected 404 bug; local: real flow) ─────
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mobile.goto(`${LIVE}/${slug}`);
await mobile.waitForTimeout(800);
await shot(mobile, "07-live-patron-room-mobile"); // documents the room-404 P0 if it reproduces

await mobile.goto(`${LOCAL}/default`);
await mobile.waitForTimeout(800);
await shot(mobile, "08-local-patron-join-mobile");
await mobile.fill("input", "Paulo");
await mobile.click("button:has-text('Join queue')").catch(() => mobile.press("input", "Enter"));
await mobile.waitForTimeout(800);
await shot(mobile, "09-local-patron-main-mobile");

await browser.close();
console.log("done ->", EV);
