const WT = "/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t125-enter-idle-search";
const { chromium } = require(WT + "/node_modules/@playwright/test");
const BASE = "http://127.0.0.1:3135";
async function setup(b) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addCookies([{ name: "NEXT_LOCALE", value: "pt-BR", url: BASE }]);
  const page = await ctx.newPage();
  const reqs = [];
  page.on("request", (r) => { const u = r.url().replace(BASE, ""); if (u.startsWith("/api/search") || (r.method() === "POST" && u.startsWith("/api/queue"))) reqs.push({ at: Date.now(), d: r.method() + " " + decodeURIComponent(u).replace(/uuid=[^&]+&/, "").slice(0, 80) }); });
  await page.route("**/api/search**", async (route) => {
    const u = new URL(route.request().url());
    if (u.searchParams.get("live") === "1") return route.fulfill({ json: { results: [{ videoId: "mockLive001", title: "MOCK live row", channelTitle: "Mock", duration: "3:00", thumbnailUrl: "https://i.ytimg.com/vi/x/mqdefault.jpg" }] } });
    return route.continue();
  });
  await page.goto(BASE + "/default");
  await page.locator("#nickname-input").fill("Probe3"); await page.locator("#nickname-input").press("Enter");
  const s = page.locator("#song-search-input"); await s.waitFor();
  return { ctx, page, reqs, s };
}
const dump = (reqs, t0) => reqs.map((r) => `   ${((r.at - t0) / 1000).toFixed(2).padStart(6)}s  ${r.d}`).join("\n");
(async () => {
  const b = await chromium.launch();
  // A: pasted link + Enter: where is focus, does the form submit?
  { const { ctx, page, reqs, s } = await setup(b);
    await s.click(); await s.fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ"); await page.waitForTimeout(800);
    const focus = await page.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName}#${a.id} type=${a.getAttribute("type")} text="${(a.textContent||"").trim().slice(0,30)}"` : "none"; });
    const t0 = Date.now(); await page.keyboard.press("Enter"); await page.waitForTimeout(2000);
    console.log(`A pasted link: activeElement after paste = ${focus}\n${dump(reqs, t0)}`);
    // A2: user taps back into the search field and presses Enter/Go there
    await s.fill("https://www.youtube.com/watch?v=9bZkp7q19f0"); await page.waitForTimeout(800);
    await s.focus(); const t1 = Date.now(); await page.keyboard.press("Enter"); await page.waitForTimeout(2000);
    const err = await page.locator("text=/link|fila/i").allTextContents().catch(() => []);
    console.log(`A2 pasted link, focus forced back INTO the search input, Enter:\n${dump(reqs.filter(r => r.at >= t1 - 1500), t1)}`);
    await page.screenshot({ path: process.argv[2] + "/pt-BR-phone-14-pasted-link-enter-in-input.png" });
    await ctx.close(); }
  // B: once-guard vs mode: live in sing, flip to listen, Enter same text
  { const { ctx, page, reqs, s } = await setup(b);
    await s.click(); await page.keyboard.type("soda stete", { delay: 100 }); await page.waitForTimeout(800);
    const t0 = Date.now(); await page.keyboard.press("Enter"); await page.waitForTimeout(1500);
    await page.locator("label:has(input[name=song-search-mode][value='listen-dance'])").click(); await page.waitForTimeout(800);
    await s.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(5500);
    console.log(`B once-guard vs mode (Enter in sing at t=0, flip to listen, Enter again at ~+2.3s, wait 5.5s):\n${dump(reqs, t0)}`);
    await page.screenshot({ path: process.argv[2] + "/pt-BR-phone-15-mode-flip-then-enter.png" });
    await ctx.close(); }
  // C: Android IME-style Enter (keyCode 229) via CDP
  { const { ctx, page, reqs, s } = await setup(b);
    await s.click(); await page.keyboard.type("soda stete", { delay: 100 }); await page.waitForTimeout(800);
    const cdp = await ctx.newCDPSession(page);
    const t0 = Date.now();
    for (const type of ["rawKeyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await page.waitForTimeout(1500);
    const errText = await page.locator("main").innerText();
    const shownErr = /link do YouTube|cole um link|link válido/i.test(errText.split("Fila")[0]);
    console.log(`C Enter with keyCode 229 (Android IME-style):\n${dump(reqs, t0)}\n   form error text visible? ${shownErr}`);
    await page.screenshot({ path: process.argv[2] + "/pt-BR-phone-16-keycode229-enter.png" });
    await page.waitForTimeout(4000);
    console.log(`C after idle:\n${dump(reqs, t0)}`);
    await ctx.close(); }
  await b.close();
})();
