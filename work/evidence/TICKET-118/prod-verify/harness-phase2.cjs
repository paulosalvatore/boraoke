// Phase 2 (after phase 1 crashed post-revoke and lost the owner device's cookies):
// two code-login devices; B plain logout must leave A2 signed in. Host code read
// from the scratchpad file only, never logged.
const { chromium } = require("/Users/paulosalvatore/Documents/GitHub/boraoke/node_modules/@playwright/test");
const fs = require("fs");
const BASE = "https://boraoke.com";
const ID = "t118-prod-verify-throwaway";
const EV = "/Users/paulosalvatore/Documents/GitHub/boraoke/work/evidence/TICKET-118/prod-verify";
const code = fs.readFileSync(process.env.HOSTCODE_FILE, "utf8").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const out = (s) => { console.log(s); log.push(s); };
(async () => {
  const browser = await chromium.launch({ headless: true });
  const opts = { viewport: { width: 1280, height: 900 }, locale: "pt-BR" };
  const login = async (p) => {
    await p.goto(`${BASE}/${ID}/admin`, { timeout: 90000 });
    await p.getByLabel("Código do host").waitFor({ timeout: 60000 });
    await p.getByLabel("Código do host").fill(code);
    await p.getByRole("button", { name: /^entrar$/i }).click();
    await p.getByTestId("moderation-card").waitFor({ timeout: 60000 });
  };
  const a2 = await (await browser.newContext(opts)).newPage();
  const b = await (await browser.newContext(opts)).newPage();
  await login(a2); await login(b);
  out(`A2 and B logged in with the code; revoke button A2=${await a2.getByTestId("admin-revoke-button").count()} B=${await b.getByTestId("admin-revoke-button").count()} (non-owner devices, want 0/0)`);
  await b.getByTestId("admin-logout-button").click();
  const c = b.getByTestId("admin-logout-confirm");
  await c.waitFor();
  out(`B logout confirm owner warning count: ${await b.getByTestId("admin-logout-owner-warning").count()} (want 0)`);
  await c.getByRole("button", { name: /^confirmar$/i }).click();
  await b.getByLabel("Código do host").waitFor({ timeout: 30000 });
  await b.goto(`${BASE}/${ID}/admin`); await sleep(4000);
  out(`B after plain logout + reload: gate=${await b.getByLabel("Código do host").count()} dashboard=${await b.getByTestId("moderation-card").count()}`);
  const s = await a2.request.get(`${BASE}/api/host/session?room=${ID}`);
  await a2.reload(); await sleep(4000);
  out(`A2 after B logout: session ${s.status()}, dashboard=${await a2.getByTestId("moderation-card").count()}, gate=${await a2.getByLabel("Código do host").count()}`);
  await a2.screenshot({ path: `${EV}/07-A2-still-in-after-B-logout.png` });
  await b.screenshot({ path: `${EV}/08-B-gate-after-logout.png` });
  fs.writeFileSync(`${EV}/run-log-phase2.txt`, log.join("\n") + "\n");
  await browser.close();
})().catch((e) => { console.error(e); fs.writeFileSync(`${EV}/run-error-phase2.txt`, String(e.stack || e)); process.exit(1); });
