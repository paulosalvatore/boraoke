/**
 * TICKET-18 evidence capture (plain Playwright — capture-screenshots skill conventions).
 * Usage: node work/evidence/ticket-18/capture.mjs <before|after> [baseUrl]
 * Captures /tv idle + playing states at 1920x1080 into this directory (absolute paths).
 */
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const tag = process.argv[2] ?? "before";
const base = process.argv[3] ?? "http://127.0.0.1:3018";
const dir = path.dirname(fileURLToPath(import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

async function drainQueue() {
  for (let i = 0; i < 220; i++) {
    const res = await page.request.get(`${base}/api/queue`);
    const data = await res.json();
    if (!data.items || data.items.length === 0) return;
    await page.request.post(`${base}/api/queue/advance`);
  }
}

async function seed(entry) {
  const res = await page.request.post(`${base}/api/queue`, { data: entry });
  if (!res.ok()) throw new Error(`seed failed: ${res.status()} ${await res.text()}`);
}

const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16)
  );

// 1. Idle state
await drainQueue();
await page.goto(`${base}/tv`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(dir, `${tag}-tv-idle-1080p.png`) });

// 2. Playing state (now playing + 3 up next)
await seed({ videoId: "dQw4w9WgXcQ", title: "Garota de Ipanema", nickname: "Beto", patronUuid: uuid(), table: "3", mode: "sing" });
await seed({ videoId: "dQw4w9WgXcQ", title: "Como Nossos Pais", nickname: "Carla", patronUuid: uuid(), table: "5", mode: "sing" });
await seed({ videoId: "dQw4w9WgXcQ", title: "Baile de Favela (remix)", nickname: "DJ Formiga", patronUuid: uuid(), mode: "listen-dance" });
await seed({ videoId: "dQw4w9WgXcQ", title: "Evidências", nickname: "Marina", patronUuid: uuid(), table: "7", mode: "sing" });
await page.goto(`${base}/tv`, { waitUntil: "networkidle" });
await page.waitForTimeout(3500); // let the YT player mount
await page.mouse.move(1500, 350); // poke the chrome (outside the YT iframe — it swallows mouse events)
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(dir, `${tag}-tv-playing-1080p.png`) });

// 3. (after only) chrome hidden state — wait past the auto-hide window
if (tag === "after") {
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(dir, `${tag}-tv-playing-chrome-hidden-1080p.png`) });
}

await drainQueue(); // leave the shared store clean
await browser.close();
console.log(`captured ${tag} evidence into ${dir}`);
