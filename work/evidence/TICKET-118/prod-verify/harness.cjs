// Live prod verify for TICKET-118/112. The host code is written ONLY to the
// scratchpad path in HOSTCODE_FILE (outside the repo), never logged here.
const { chromium } = require("/Users/paulosalvatore/Documents/GitHub/boraoke/node_modules/@playwright/test");
const fs = require("fs");
const BASE = "https://boraoke.com";
const EV = "/Users/paulosalvatore/Documents/GitHub/boraoke/work/evidence/TICKET-118/prod-verify";
const CODE_FILE = process.env.HOSTCODE_FILE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const out = (s) => { console.log(s); log.push(s); };
(async () => {
  const browser = await chromium.launch({ headless: true });
  const opts = { viewport: { width: 1280, height: 900 }, locale: "pt-BR" };
  const A = await browser.newContext(opts);
  const B = await browser.newContext(opts);
  const a = await A.newPage();
  const b = await B.newPage();
  let searches = 0;
  for (const p of [a, b]) p.on("request", (r) => { if (r.url().includes("/api/search")) searches++; });

  // Create the room on A (owner device)
  await a.goto(`${BASE}/new`, { timeout: 90000 });
  await a.getByLabel("Nome do bar").fill("T118 prod verify (throwaway)");
  await a.getByRole("button", { name: /^criar sala$/i }).click();
  await a.getByTestId("join-url").waitFor({ timeout: 60000 });
  const id = (await a.getByTestId("join-url").textContent()).trim().split("/").pop();
  const code = (await a.getByTestId("host-code").textContent()).trim();
  fs.writeFileSync(CODE_FILE, code + "\n", { mode: 0o600 });
  out(`room id: ${id} (host code saved to scratchpad only)`);

  await a.goto(`${BASE}/${id}/admin`);
  await a.getByTestId("moderation-card").waitFor({ timeout: 60000 });
  out(`A dashboard without typing: true`);

  // B logs in with the host code
  const bLogin = async () => {
    await b.goto(`${BASE}/${id}/admin`);
    await b.getByLabel("Código do host").waitFor({ timeout: 60000 });
    await b.getByLabel("Código do host").fill(code);
    await b.getByRole("button", { name: /^entrar$/i }).click();
    await b.getByTestId("moderation-card").waitFor({ timeout: 60000 });
  };
  await bLogin();
  out(`B logged in with code: true`);
  const bRevoke = await b.getByTestId("admin-revoke-button").count();
  const aRevoke = await a.getByTestId("admin-revoke-button").count();
  out(`CHECK1 B sees "Sign out other devices": ${bRevoke} (want 0); A sees it: ${aRevoke} (want 1)`);
  await b.screenshot({ path: `${EV}/01-B-staff-no-revoke-button.png` });

  await a.getByTestId("admin-logout-button").click();
  const aConfirm = a.getByTestId("admin-logout-confirm");
  await aConfirm.waitFor();
  const warn = await a.getByTestId("admin-logout-owner-warning").textContent().catch(() => null);
  out(`CHECK1 A logout confirm owner warning: ${JSON.stringify(warn)}`);
  await a.screenshot({ path: `${EV}/02-A-owner-logout-warning.png` });
  await aConfirm.getByRole("button", { name: /^cancelar$/i }).click();
  await sleep(500);

  // A: sign out other devices
  await a.getByTestId("admin-revoke-button").click();
  const rc = a.getByTestId("admin-revoke-confirm");
  await rc.waitFor();
  out(`A revoke confirm text: ${JSON.stringify((await rc.innerText()).replace(/\s+/g, " "))}`);
  await a.getByTestId("admin-revoke-confirm-yes").click();
  await a.getByTestId("admin-revoke-toast").waitFor({ timeout: 30000 });
  out(`A revoke toast: ${JSON.stringify((await a.getByTestId("admin-revoke-toast").innerText()).trim())}`);
  await a.screenshot({ path: `${EV}/03-A-revoke-done.png` });

  // B's next host action: toggle moderation in the UI
  const modResp = b.waitForResponse((r) => r.url().includes("/api/host/moderation"), { timeout: 20000 });
  await b.getByTestId("moderation-track").click();
  const mr = await modResp;
  out(`CHECK2 B host action (moderation toggle) status: ${mr.status()} (want 401)`);
  await sleep(3000);
  const gateInPlace = await b.getByLabel("Código do host").count();
  out(`CHECK2 B code gate shown in place after failed action: ${gateInPlace}`);
  await b.screenshot({ path: `${EV}/04-B-after-failed-action.png` });
  await b.goto(`${BASE}/${id}/admin`);
  await sleep(4000);
  const gateAfterLoad = await b.getByLabel("Código do host").count();
  const bDash = await b.getByTestId("moderation-card").count();
  out(`CHECK2 B on next admin load: codeGate=${gateAfterLoad} dashboard=${bDash}`);
  await b.screenshot({ path: `${EV}/05-B-code-gate.png` });

  // A still signed in
  const aSess = await a.request.get(`${BASE}/api/host/session?room=${id}`);
  await a.reload();
  await sleep(4000);
  out(`CHECK3 A still signed in: session ${aSess.status()}, dashboard after reload=${await a.getByTestId("moderation-card").count()}, gate=${await a.getByLabel("Código do host").count()}`);
  const modState = (await (await a.request.get(`${BASE}/api/queue?room=${id}`)).json()).moderation;
  out(`room moderation flag after B's failed toggle: ${modState} (want false, i.e. unchanged)`);

  // B logs in again, then plain logout; A stays in
  await bLogin();
  out(`B re-login with code: true; B revoke button: ${await b.getByTestId("admin-revoke-button").count()}`);
  await b.getByTestId("admin-logout-button").click();
  const bConfirm = b.getByTestId("admin-logout-confirm");
  await bConfirm.waitFor();
  out(`B logout confirm has owner warning: ${await b.getByTestId("admin-logout-owner-warning").count()} (want 0)`);
  await bConfirm.getByRole("button", { name: /^confirmar$/i }).click();
  await b.getByLabel("Código do host").waitFor({ timeout: 30000 });
  out(`CHECK4 B after plain logout on gate: true`);
  const aSess2 = await a.request.get(`${BASE}/api/host/session?room=${id}`);
  await a.reload();
  await sleep(4000);
  out(`CHECK4 A after B logout: session ${aSess2.status()}, dashboard=${await a.getByTestId("moderation-card").count()}, gate=${await a.getByLabel("Código do host").count()}`);
  await a.screenshot({ path: `${EV}/06-A-still-in-after-B-logout.png` });
  out(`search requests: ${searches}`);
  fs.writeFileSync(`${EV}/run-log.txt`, log.join("\n") + "\n");
  await browser.close();
})().catch((e) => { console.error(e); fs.writeFileSync(`${EV}/run-error.txt`, String(e.stack || e)); fs.writeFileSync(`${EV}/run-log.txt`, log.join("\n") + "\n"); process.exit(1); });
