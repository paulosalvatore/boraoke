// App Tester harness for TICKET-118/112 (PR #96). Usage: node apptest-t118.cjs <locale> <w> <h> [regression]
const REPO = "/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t118-session-revocation";
const { chromium } = require(REPO + "/node_modules/playwright");
const fs = require("fs");
const BASE = "http://127.0.0.1:3119";
const EV = REPO + "/work/evidence/TICKET-118/apptest";
const [locale, W, H, regr] = [process.argv[2], +process.argv[3], +process.argv[4], process.argv[5] === "regression"];
const msgs = JSON.parse(fs.readFileSync(`${REPO}/messages/${locale}.json`, "utf8"));
function findNs(o) { for (const k in o) { if (o[k] && typeof o[k] === "object") { if ("signOutAll" in o[k]) return o[k]; const r = findNs(o[k]); if (r) return r; } } }
const T = findNs(msgs);
const tag = `${locale}-${W}`;
const results = [];
const consoleErrs = [];
const revokeLog = [];
function rec(step, ok, note) { results.push({ step, ok: !!ok, note: note || "" }); console.log(`${ok ? "PASS" : "FAIL"} [${tag}] ${step} ${note || ""}`); }
async function shot(page, name) { await page.screenshot({ path: `${EV}/${tag}-${name}.png` }); }
function watch(page, who) {
  page.on("console", (m) => { if (m.type() === "error") consoleErrs.push(`${tag} ${who}: ${m.text().slice(0, 200)}`); });
  page.on("response", (r) => { if (r.url().includes("/api/host/revoke-sessions")) { revokeLog.push(`${who} ${r.request().method()} ${r.status()}`); } });
  page.on("pageerror", (e) => consoleErrs.push(`${tag} ${who} pageerror: ${String(e).slice(0, 200)}`));
}
async function newDevice(browser, who) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, baseURL: BASE, locale });
  await ctx.addCookies([{ name: "NEXT_LOCALE", value: locale, url: BASE }]);
  ctx.setDefaultTimeout(60000); const page = await ctx.newPage(); watch(page, who);
  return { ctx, page };
}
const dash = (p) => p.getByTestId("moderation-card");
async function loginWithCode(page, room, code) {
  await page.goto(`/${room}/admin`);
  const input = page.locator("main input").first();
  await input.waitFor({ timeout: 60000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  for (let i = 0; i < 3; i++) {
    await input.fill(code);
    await page.locator('main form button[type="submit"]').click();
    try { await dash(page).waitFor({ timeout: 150000 }); return; } catch (e) {
      const err = await page.locator("main form p").allInnerTexts().catch(() => []);
      console.log("login attempt", i, "failed; gate text:", JSON.stringify(err), "code len", code.length);
      if (i === 2) { await page.screenshot({ path: `${EV}/${tag}-DEBUG-login.png` }); throw e; }
    }
  }
}
async function layoutCheck(page, label) {
  const r = await page.evaluate(() => {
    const out = { hscroll: document.documentElement.scrollWidth > window.innerWidth + 1, overlaps: [], clipped: [] };
    const vis = [...document.querySelectorAll('[data-testid="admin-logout-button"],[data-testid="admin-revoke-button"],[data-testid="admin-patron-link"],[data-testid="admin-tv-link"],[data-testid="admin-analytics-link"],[data-testid="admin-logout-confirm"],[data-testid="admin-revoke-confirm"],[data-testid="admin-revoke-toast"]')];
    const boxes = vis.map((e) => [e.dataset.testid, e.getBoundingClientRect()]);
    for (let i = 0; i < boxes.length; i++) {
      const [n, b] = boxes[i];
      if (b.right > window.innerWidth + 1 || b.left < -1) out.clipped.push(n);
      for (let j = i + 1; j < boxes.length; j++) {
        const [m, c] = boxes[j];
        const ox = Math.min(b.right, c.right) - Math.max(b.left, c.left), oy = Math.min(b.bottom, c.bottom) - Math.max(b.top, c.top);
        if (ox > 1 && oy > 1) out.overlaps.push(`${n}x${m}`);
      }
    }
    return out;
  });
  rec(`layout ${label} @${page.viewportSize().width}`, !r.hscroll && !r.overlaps.length && !r.clipped.length, JSON.stringify(r));
}
const confirmBtns = (page, id) => page.getByTestId(id).locator("button");
async function openRevokeAndConfirm(page) {
  await page.getByTestId("admin-revoke-button").click();
  await page.getByTestId("admin-revoke-confirm").waitFor();
  await confirmBtns(page, "admin-revoke-confirm").first().click();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  // warm (a throwaway device) — every route the flow touches, before any state exists
  {
    const { ctx, page } = await newDevice(browser, "warm");
    const rq = { post: (u, o = {}) => ctx.request.post(u, { timeout: 300000, ...o }), get: (u, o = {}) => ctx.request.get(u, { timeout: 300000, ...o }) };
    await rq.post("/api/rooms", { data: { name: "warm" } });
    await rq.post("/api/host/login", { data: { token: "cantai-dev-host" } });
    await rq.get("/api/host/session?room=default");
    await rq.post("/api/host/session?room=default");
    await rq.post("/api/host/claim?room=!!");
    await rq.post("/api/host/revoke-sessions?room=default");
    for (const p of ["moderation", "pause", "skip", "remove", "reorder", "language", "mode"]) await rq.post(`/api/host/${p}`, { data: {} });
    await rq.get("/api/host/pending"); await rq.post("/api/host/pending/approve", { data: { pendingId: "w" } }); await rq.post("/api/host/pending/reject", { data: { pendingId: "w" } });
    await rq.get("/api/queue?room=default");
    await rq.post("/api/queue", { data: { room: "default", videoId: "dQw4w9WgXcQ", nickname: "warm", patronUuid: "00000000-0000-4000-8000-000000000000", mode: "sing" } });
    for (const u of ["/new", "/default", "/default/admin", "/default/tv"]) await page.goto(u, { waitUntil: "load", timeout: 300000 });
    await ctx.close();
  }
  // Scenario 1: owner A creates room
  const A = await newDevice(browser, "A");
  await A.page.goto("/new");
  await A.page.waitForLoadState("networkidle").catch(() => {});
  for (let i = 0; i < 3; i++) {
    await A.page.locator("form input").first().fill(`Bar ${tag}`);
    await A.page.locator('form button[type="submit"]').click();
    try { await A.page.getByTestId("join-url").waitFor({ timeout: 40000 }); break; } catch (e) { console.log("create attempt", i, "failed"); if (i === 2) throw e; await A.page.goto("/new"); await A.page.waitForLoadState("networkidle").catch(() => {}); }
  }
  const room = (await A.page.getByTestId("join-url").textContent()).trim().split("/").pop();
  const code = (await A.page.getByTestId("host-code").textContent()).trim();
  await A.page.goto(`/${room}/admin`);
  await dash(A.page).waitFor({ timeout: 30000 });
  const pa = A.page;
  rec("1 A (owner) sees logout", await pa.getByTestId("admin-logout-button").isVisible());
  rec("1 A (owner) sees revoke", await pa.getByTestId("admin-revoke-button").isVisible());
  rec("1 labels localised", (await pa.getByTestId("admin-logout-button").innerText()).trim() === T.signOut && (await pa.getByTestId("admin-revoke-button").innerText()).trim() === T.signOutAll, `${T.signOut} / ${T.signOutAll}`);
  await shot(pa, "1-A-owner-header");
  await layoutCheck(pa, "A header");
  const B = await newDevice(browser, "B");
  await loginWithCode(B.page, room, code);
  rec("1 B (staff) sees logout", await B.page.getByTestId("admin-logout-button").isVisible());
  rec("1 B (staff) does NOT see revoke", (await B.page.getByTestId("admin-revoke-button").count()) === 0);
  await shot(B.page, "1-B-staff-header");
  await layoutCheck(B.page, "B header");
  // Scenario 2: plain logout on B
  await B.page.getByTestId("admin-logout-button").click();
  await B.page.getByTestId("admin-logout-confirm").waitFor();
  const bTxt = (await B.page.getByTestId("admin-logout-confirm").innerText());
  rec("2 B logout confirm = this-device text, no owner warning", bTxt.includes(T.signOutQuestion) && !bTxt.includes(T.signOutOwnerWarning), T.signOutQuestion);
  await shot(B.page, "2-B-logout-confirm");
  await layoutCheck(B.page, "B logout confirm");
  await confirmBtns(B.page, "admin-logout-confirm").first().click();
  await B.page.locator("main input").first().waitFor({ timeout: 15000 });
  rec("2 B lands on code gate", true);
  await shot(B.page, "2-B-after-logout-gate");
  await B.page.reload(); await B.page.locator("main input").first().waitFor({ timeout: 15000 });
  rec("2 B still gated after reload", (await dash(B.page).count()) === 0);
  await pa.reload(); await dash(pa).waitFor({ timeout: 15000 });
  rec("2 A still signed in after B logout", true);
  // A without host-session cookie: claim credential survived
  await A.ctx.clearCookies({ name: `cantai_host_${room}` });
  await pa.reload(); await dash(pa).waitFor({ timeout: 15000 });
  rec("2 A re-enters without code after dropping session cookie (claim survived B logout)", true);
  // Scenario 3: owner warning on A
  await pa.getByTestId("admin-logout-button").click();
  await pa.getByTestId("admin-logout-confirm").waitFor();
  const aTxt = await pa.getByTestId("admin-logout-confirm").innerText();
  rec("3 A logout confirm shows owner warning", aTxt.includes(T.signOutOwnerWarning), T.signOutOwnerWarning);
  await shot(pa, "3-A-logout-owner-warning");
  await layoutCheck(pa, "A logout confirm");
  await confirmBtns(pa, "admin-logout-confirm").nth(1).click();
  rec("3 cancel closes panel, A still signed in", (await pa.getByTestId("admin-logout-confirm").count()) === 0 && (await dash(pa).isVisible()));
  // Scenario 4: fresh B login, A revokes
  await loginWithCode(B.page, room, code);
  await pa.getByTestId("admin-revoke-button").click();
  await pa.getByTestId("admin-revoke-confirm").waitFor();
  rec("4 revoke confirm copy", (await pa.getByTestId("admin-revoke-confirm").innerText()).includes(T.signOutAllWarning), T.signOutAllWarning);
  await shot(pa, "4-A-revoke-confirm");
  await layoutCheck(pa, "A revoke confirm");
  await confirmBtns(pa, "admin-revoke-confirm").first().click();
  await pa.getByTestId("admin-revoke-toast").waitFor();
  rec("4 done message", (await pa.getByTestId("admin-revoke-toast").innerText()).trim() === T.signOutAllDone, T.signOutAllDone);
  await shot(pa, "4-A-revoke-done");
  await layoutCheck(pa, "A done toast");
  await pa.reload(); await dash(pa).waitFor({ timeout: 15000 });
  rec("4 A signed in after reload and keeps button", await pa.getByTestId("admin-revoke-button").isVisible());
  // B's next action
  const st = await B.page.evaluate(async (r) => (await fetch(`/api/host/moderation?room=${r}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ moderation: true }) })).status, room);
  rec("4 B's next host action is rejected (401)", st === 401, `status ${st}`);
  await B.page.getByTestId("moderation-track").click().catch(() => {});
  await B.page.waitForTimeout(3500);
  const gateNoReload = (await B.page.locator("main input").count()) > 0 && (await dash(B.page).count()) === 0;
  await shot(B.page, "4-B-after-action-no-reload");
  await B.page.reload(); await B.page.locator("main input").first().waitFor({ timeout: 15000 });
  rec("4 B lands on code gate (after reload)", true, `gate without reload: ${gateNoReload}`);
  await shot(B.page, "4-B-gate-after-revoke");
  // Scenario 5: staff forced request
  await loginWithCode(B.page, room, code);
  const forced = await B.page.evaluate(async (r) => { const x = await fetch(`/api/host/revoke-sessions?room=${r}`, { method: "POST" }); return { s: x.status, b: await x.text() }; }, room);
  rec("5 staff forced revoke -> 403 friendly JSON", forced.s === 403 && /ownerOnly/.test(forced.b), JSON.stringify(forced));
  rec("5 staff B still signed in after refused revoke", (await B.page.evaluate(async (r) => (await fetch(`/api/host/session?room=${r}`)).status, room)) === 200);
  // UI path of the friendly message: harness mocks the owner hint on B (stale-hint case)
  await B.page.route("**/api/host/session**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const resp = await route.fetch(); let j = {}; try { j = await resp.json(); } catch {}
    await route.fulfill({ response: resp, json: { ...j, owner: true } });
  });
  await B.page.reload(); await dash(B.page).waitFor({ timeout: 15000 });
  if (await B.page.getByTestId("admin-revoke-button").count()) {
    await openRevokeAndConfirm(B.page);
    await B.page.getByTestId("admin-revoke-toast").waitFor();
    const m = (await B.page.getByTestId("admin-revoke-toast").innerText()).trim();
    rec("5 UI shows friendly owner-only message (owner hint mocked)", m === T.signOutAllOwnerOnly && (await dash(B.page).isVisible()), m);
    await shot(B.page, "5-B-forced-403-friendly");
    await layoutCheck(B.page, "B 403 toast");
  } else rec("5 UI mock path", false, "button did not render with mocked hint");
  await B.page.unroute("**/api/host/session**");
  // Scenario 6: throttle (use 1 done already; 2 more successes, 4th refused)
  for (let i = 2; i <= 3; i++) {
    await openRevokeAndConfirm(pa);
    await pa.getByTestId("admin-revoke-toast").waitFor();
    rec(`6 use #${i} succeeds`, (await pa.getByTestId("admin-revoke-toast").innerText()).trim() === T.signOutAllDone);
  }
  await openRevokeAndConfirm(pa);
  await pa.getByTestId("admin-revoke-toast").waitFor();
  await pa.waitForTimeout(500);
  console.log("REVOKE_LOG", JSON.stringify(revokeLog));
  const th = (await pa.getByTestId("admin-revoke-toast").innerText()).trim();
  rec("6 4th use shows throttle message", th === T.signOutAllThrottled, th);
  await shot(pa, "6-A-throttled");
  await layoutCheck(pa, "A throttle toast");
  rec("6 A still signed in after throttle", await dash(pa).isVisible());
  // Scenario 7: 320px
  await pa.setViewportSize({ width: 320, height: 640 });
  await pa.getByTestId("admin-logout-button").click();
  await pa.getByTestId("admin-logout-confirm").waitFor();
  await shot(pa, "7-320-A-logout-confirm"); await layoutCheck(pa, "320 logout confirm");
  await pa.getByTestId("admin-revoke-button").click();
  await pa.getByTestId("admin-revoke-confirm").waitFor();
  await shot(pa, "7-320-A-revoke-confirm+toast"); await layoutCheck(pa, "320 revoke confirm");
  await pa.setViewportSize({ width: W, height: H });
  // Scenario 8 regression (host A is signed in after all revokes)
  if (regr) {
    await pa.reload(); await dash(pa).waitFor();
    const tog = pa.getByTestId("moderation-track"); await tog.click();
    await pa.waitForFunction(() => document.querySelector('[data-testid="moderation-toggle"]').checked);
    rec("8 moderation toggle on", true);
    const P = await newDevice(browser, "patron");
    await P.page.goto(`/${room}`);
    await P.page.getByLabel("Seu apelido").fill("Patron");
    await P.page.getByRole("button", { name: /entrar na fila/i }).click();
    await P.page.getByRole("heading", { name: /adicionar música/i }).waitFor();
    await P.page.getByLabel(/Buscar música/i).fill("https://youtu.be/dQw4w9WgXcQ");
    await P.page.getByText(/Selecionada: dQw4w9WgXcQ/).waitFor({ timeout: 20000 });
    await P.page.getByPlaceholder(/^ex\.: Evidências$/).fill("Musica Regressao");
    await P.page.getByRole("button", { name: /adicionar à fila/i }).click();
    await pa.getByTestId("pending-card").waitFor({ timeout: 15000 });
    rec("8 pending card appears for host", true);
    await shot(pa, "8-A-pending");
    await pa.getByTestId("pending-approve").first().click();
    await pa.getByText("Musica Regressao").first().waitFor({ timeout: 15000 });
    rec("8 approve -> song in queue", true);
    await shot(pa, "8-A-queue");
    const TV = await newDevice(browser, "tv");
    await TV.page.goto(`/${room}/tv`, { waitUntil: "load", timeout: 60000 });
    await TV.page.getByText("Musica Regressao").first().waitFor({ timeout: 20000 });
    rec("8 TV shows the queued song", true);
    await shot(TV.page, "8-TV");
    const st = await pa.evaluate(async (r) => ({ pause: (await fetch(`/api/host/pause?room=${r}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: true }) })).status, unpause: (await fetch(`/api/host/pause?room=${r}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: false }) })).status, skip: (await fetch(`/api/host/skip?room=${r}`, { method: "POST" })).status }), room);
    rec("8 host pause/unpause/skip still authorised (200)", st.pause === 200 && st.unpause === 200 && st.skip === 200, JSON.stringify(st));
  }
  fs.writeFileSync(`${EV}/results-${tag}.json`, JSON.stringify({ room, results, revokeLog, consoleErrs }, null, 2));
  console.log("CONSOLE_ERRS", consoleErrs.length, consoleErrs.slice(0, 5));
  await browser.close();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); fs.writeFileSync(`${EV}/results-${tag}.json`, JSON.stringify({ error: String(e), results, consoleErrs }, null, 2)); process.exit(2); });
