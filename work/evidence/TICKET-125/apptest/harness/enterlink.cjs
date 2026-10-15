const WT = "/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t125-enter-idle-search";
const { chromium } = require(WT + "/node_modules/@playwright/test");
const BASE = "http://127.0.0.1:3135";
(async () => {
  const b = await chromium.launch();
  for (const step of ["short-abc", "link", "indexhit-picked"]) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const reqs = [];
    page.on("request", (r) => { const u = r.url().replace(BASE, ""); if (r.method() === "POST" || u.includes("live=1")) reqs.push(r.method() + " " + u.slice(0, 90)); });
    await page.goto(BASE + "/default");
    await page.locator("#nickname-input").fill("EnterProbe");
    await page.locator("#nickname-input").press("Enter");
    const s = page.locator("#song-search-input"); await s.waitFor();
    if (step === "short-abc") { await s.click(); await page.keyboard.type("abc", { delay: 100 }); }
    else if (step === "link") { await s.fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ"); await page.waitForTimeout(500); }
    else { await s.click(); await page.keyboard.type("evidencias", { delay: 100 }); await page.waitForTimeout(1500);
      await page.locator("button:has-text('Evid')").first().click(); await s.click(); }
    await page.evaluate(() => { window.__kd = []; window.addEventListener("keydown", (e) => window.__kd.push(e.defaultPrevented)); });
    const n0 = reqs.length;
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2500);
    const kd = await page.evaluate(() => window.__kd);
    console.log(`${step}: Enter defaultPrevented=${JSON.stringify(kd)} requests after Enter=${JSON.stringify(reqs.slice(n0))}`);
    await ctx.close();
  }
  await b.close();
})();
