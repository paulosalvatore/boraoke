// Re-run of the post-revoke check on throwaway room 2. Host code goes ONLY to HOSTCODE_FILE (scratchpad).
const { chromium } = require("/Users/paulosalvatore/Documents/GitHub/boraoke/node_modules/@playwright/test");
const fs = require("fs");
const BASE = "https://boraoke.com";
const EV = "/Users/paulosalvatore/Documents/GitHub/boraoke/work/evidence/TICKET-118/prod-verify";
const CODE_FILE = process.env.HOSTCODE_FILE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [], net = [];
const out = (s) => { console.log(s); log.push(s); };
const save = () => { fs.writeFileSync(`${EV}/run-log-revoke-recheck.txt`, log.join("\n") + "\n"); fs.writeFileSync(`${EV}/network-revoke-recheck.txt`, net.join("\n") + "\n"); };
(async () => {
  const browser = await chromium.launch({ headless: true });
  const opts = { viewport: { width: 1280, height: 900 }, locale: "pt-BR" };
  const A = await browser.newContext(opts), B = await browser.newContext(opts);
  const a = await A.newPage(), b = await B.newPage();
  let searches = 0;
  for (const p of [a, b]) p.on("request", (r) => { if (r.url().includes("/api/search")) searches++; });
  b.on("response", (r) => { if (r.url().includes("/api/host/") || r.url().includes("/api/queue")) net.push(`B ${r.request().method()} ${r.url().replace(BASE, "")} -> ${r.status()}`); });
  a.on("response", (r) => { if (r.url().includes("/api/host/")) net.push(`A ${r.request().method()} ${r.url().replace(BASE, "")} -> ${r.status()}`); });
  try {
    await a.goto(`${BASE}/new`, { timeout: 90000 });
    await a.getByLabel("Nome do bar").fill("t118-prod-verify-throwaway-2");
    await a.getByRole("button", { name: /^criar sala$/i }).click();
    await a.getByTestId("join-url").waitFor({ timeout: 60000 });
    const id = (await a.getByTestId("join-url").textContent()).trim().split("/").pop();
    const code = (await a.getByTestId("host-code").textContent()).trim();
    fs.writeFileSync(CODE_FILE, code + "\n", { mode: 0o600 });
    out(`room id: ${id}`);
    await a.goto(`${BASE}/${id}/admin`);
    await a.getByTestId("moderation-card").waitFor({ timeout: 60000 });
    await b.goto(`${BASE}/${id}/admin`);
    await b.getByLabel("Código do host").waitFor({ timeout: 60000 });
    await b.getByLabel("Código do host").fill(code);
    await b.getByRole("button", { name: /^entrar$/i }).click();
    await b.getByTestId("moderation-card").waitFor({ timeout: 60000 });
    out("B logged in with code: true");
    const before = (await (await b.request.get(`${BASE}/api/queue?room=${id}`)).json()).moderation;
    out(`moderation flag before: ${before}`);

    await a.getByTestId("admin-revoke-button").click();
    await a.getByTestId("admin-revoke-confirm").waitFor();
    await a.getByTestId("admin-revoke-confirm-yes").click();
    await a.getByTestId("admin-revoke-toast").waitFor({ timeout: 30000 });
    out(`A revoke toast: ${JSON.stringify((await a.getByTestId("admin-revoke-toast").innerText()).trim())}`);
    await a.screenshot({ path: `${EV}/09-A-revoke-done-room2.png` });

    const modResp = b.waitForResponse((r) => r.url().includes("/api/host/moderation"), { timeout: 20000 });
    await b.getByTestId("moderation-track").click();
    const mr = await modResp;
    out(`CHECK2 B host action (moderation toggle) status: ${mr.status()} (want 401)`);
    await sleep(2500);
    await b.screenshot({ path: `${EV}/10-B-after-failed-action-room2.png` });
    // fresh read from a context with no cookies
    const fresh = await browser.newContext();
    const after = (await (await fresh.request.get(`${BASE}/api/queue?room=${id}`)).json()).moderation;
    out(`moderation flag after (fresh read): ${after} (want ${before}, unchanged)`);
    await fresh.close();
    await b.goto(`${BASE}/${id}/admin`);
    await sleep(4000);
    out(`CHECK2 B reload: codeGate=${await b.getByLabel("Código do host").count()} dashboard=${await b.getByTestId("moderation-card").count()}`);
    await b.screenshot({ path: `${EV}/11-B-code-gate-room2.png` });
    const aSess = await a.request.get(`${BASE}/api/host/session?room=${id}`);
    await a.reload(); await sleep(4000);
    out(`CHECK3 A: session ${aSess.status()}, dashboard=${await a.getByTestId("moderation-card").count()}, gate=${await a.getByLabel("Código do host").count()}, revoke button=${await a.getByTestId("admin-revoke-button").count()}`);
    await a.screenshot({ path: `${EV}/12-A-still-in-room2.png` });
    out(`search requests: ${searches}`);
  } catch (e) { out("ERROR " + (e.stack || e)); }
  save();
  await browser.close();
})();
