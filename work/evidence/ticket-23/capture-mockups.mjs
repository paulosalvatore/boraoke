// TICKET-23 designer mockup capture (plain Playwright, capture-screenshots conventions).
// Serve work/design/mockups-v2 (e.g. python3 -m http.server 8023) then run.
import { chromium } from "@playwright/test";

const EV = new URL("./mockups-v2/", import.meta.url).pathname;
const BASE = process.env.MOCKUP_BASE ?? "http://localhost:8023";

const shots = [
  { file: "index.html", name: "00-index", vp: { width: 1280, height: 800 } },
  { file: "landing.html", name: "01-landing-desktop", vp: { width: 1280, height: 900 }, full: true },
  { file: "landing.html", name: "02-landing-mobile-390", vp: { width: 390, height: 844 }, full: true },
  { file: "patron.html", name: "03-patron-flow-3up", vp: { width: 1440, height: 900 }, full: true },
  { file: "admin-live.html", name: "04-admin-live-loggedout", vp: { width: 1280, height: 900 }, full: true },
  { file: "admin-history.html", name: "05-admin-history-loggedin", vp: { width: 1280, height: 900 }, full: true },
  { file: "tv-bar.html", name: "06-tv-bar-1080p", vp: { width: 1920, height: 1080 } },
  { file: "tv-party.html", name: "07-tv-party-1080p", vp: { width: 1920, height: 1080 } },
  { file: "tv-corporate.html", name: "08-tv-corporate-light-1080p", vp: { width: 1920, height: 1080 } },
  { file: "switchers.html", name: "09-switchers", vp: { width: 1280, height: 800 }, full: true },
];

const browser = await chromium.launch();
for (const s of shots) {
  const page = await browser.newPage({ viewport: s.vp });
  await page.goto(`${BASE}/${s.file}`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${EV}${s.name}.png`, fullPage: !!s.full });
  await page.close();
  console.log(s.name);
}
await browser.close();
console.log("done ->", EV);
