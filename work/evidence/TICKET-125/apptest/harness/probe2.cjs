const WT = "/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t125-enter-idle-search";
const { chromium } = require(WT + "/node_modules/@playwright/test");
const BASE = "http://127.0.0.1:3135";
const EV = process.argv[2];
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addCookies([{ name: "NEXT_LOCALE", value: "pt-BR", url: BASE }]);
  const page = await ctx.newPage();
  const reqs = [];
  // NOT mocked: live=1 goes to the real server (no real key) to show what it answers.
  await page.route("**/api/search**", async (route) => {
    const u = new URL(route.request().url()); reqs.push({ at: Date.now(), live: u.searchParams.get("live") === "1", q: u.searchParams.get("q") });
    const resp = await route.fetch(); const body = await resp.text(); reqs[reqs.length-1].answer = body.slice(0, 70); return route.fulfill({ response: resp, body });
    return route.continue();
  });
  await page.goto(BASE + "/default");
  await page.locator("#nickname-input").fill("ProbeTwo"); await page.locator("#nickname-input").press("Enter");
  const s = page.locator("#song-search-input"); await s.waitFor();
  const attrs = await s.evaluate((el) => ({ enterkeyhint: el.getAttribute("enterkeyhint"), inputmode: el.getAttribute("inputmode"), autocomplete: el.getAttribute("autocomplete") }));
  console.log("search input attributes (phone search key):", JSON.stringify(attrs));
  await s.click(); await page.keyboard.type("evidencias", { delay: 120 }); const t0 = Date.now();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: EV + "/pt-BR-phone-12-indexhit-before-enter.png" });
  const tE = Date.now(); await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: EV + "/pt-BR-phone-13-indexhit-after-enter.png" });
  console.log("Enter pressed while INDEX results were on screen (t=0 = Enter):");
  for (const r of reqs) console.log(`  ${((r.at - tE) / 1000).toFixed(2).padStart(6)}s  ${r.live ? "LIVE=1" : "index "}  q="${r.q}"  -> ${r.answer || ""}`);
  await b.close();
})();
