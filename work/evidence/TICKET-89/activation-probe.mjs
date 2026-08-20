/**
 * TICKET-89 — user-activation probe.
 *
 * The v2 probe showed `requestFullscreen()` resolving with no obvious gesture,
 * which is exactly the kind of result you must not build a kiosk fix on. This
 * probe separates the three cases so the answer is not an artifact of a click
 * that happened earlier in the page's life:
 *
 *   H0  never-clicked page, requestFullscreen()            -> is automation bypassing activation?
 *   H1  clicked once long ago (STICKY activation only)     -> does sticky alone suffice?
 *   H2  already fullscreen on the iframe, request fullscreen on documentElement
 *       with NO new gesture                                -> is "escalate to root" viable?
 *   H3  same as H2 but from inside a setTimeout, i.e. the async path our React
 *       effect would really run on.
 *
 * Run: node work/evidence/TICKET-89/activation-probe.mjs [--mode chromium|headed]
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const PAGE = `<!doctype html><meta charset=utf-8><title>activation probe</title>
<style>#anc{width:400px;height:300px;background:#0a0}iframe{width:300px;height:200px}</style>
<button id=go>go</button>
<div id=anc><iframe id=frame src=about:blank></iframe></div>
<script>
  document.getElementById("go").addEventListener("click", () => {
    document.getElementById("frame").requestFullscreen().catch(() => {});
  });
</script>`;

const mkPage = async (browser) => {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.route("**/probe", (r) => r.fulfill({ contentType: "text/html", body: PAGE }));
  await page.goto("http://probe.local/probe");
  return page;
};

const attempt = (page, expr) => page.evaluate(expr);

const run = async (mode) => {
  const browser = await chromium.launch(
    mode === "headed" ? { headless: false, channel: "chromium" } : { headless: true, channel: "chromium" }
  );
  const results = {};

  // ---- H0: a page that has NEVER been clicked ----------------------------
  {
    const page = await mkPage(browser);
    results.H0_never_clicked = await attempt(page, async () => {
      try {
        await document.getElementById("anc").requestFullscreen();
        return { resolved: true, fullscreenElement: document.fullscreenElement?.id ?? null };
      } catch (e) { return { resolved: false, error: String(e && e.name), message: String(e && e.message) }; }
    });
    results.H0_never_clicked.interpretation = results.H0_never_clicked.resolved
      ? "AUTOMATION BYPASSES ACTIVATION — this harness cannot measure gesture policy"
      : "activation is enforced here; the harness IS a valid oracle";
    await page.close();
  }

  // ---- H1: sticky activation only (clicked once, on an unrelated button) --
  {
    const page = await mkPage(browser);
    await page.evaluate(() => {
      // a click that does NOT request fullscreen, purely to grant sticky activation
      const b = document.createElement("button"); b.id = "noop"; document.body.appendChild(b);
    });
    await page.click("#noop");
    await page.waitForTimeout(1200); // let transient activation lapse (~5s window, but measure anyway)
    results.H1_sticky_activation_only = await attempt(page, async () => {
      try {
        await document.getElementById("anc").requestFullscreen();
        return { resolved: true, fullscreenElement: document.fullscreenElement?.id ?? null };
      } catch (e) { return { resolved: false, error: String(e && e.name) }; }
    });
    await page.close();
  }

  // ---- H2 / H3: escalate an EXISTING fullscreen to documentElement --------
  {
    const page = await mkPage(browser);
    await page.click("#go"); // genuine gesture -> iframe is the fullscreen element
    await page.waitForTimeout(600);
    results.H2_precondition = await page.evaluate(() => document.fullscreenElement?.id ?? null);

    // let any transient activation expire before we try the escalation
    await page.waitForTimeout(6000);

    results.H2_escalate_to_documentElement_no_new_gesture = await attempt(page, async () => {
      try {
        await document.documentElement.requestFullscreen();
        return {
          resolved: true,
          fullscreenElement: document.fullscreenElement === document.documentElement ? "HTML" : (document.fullscreenElement?.id ?? null),
        };
      } catch (e) { return { resolved: false, error: String(e && e.name), message: String(e && e.message) }; }
    });
    await page.close();
  }

  // ---- H3: same, but from a setTimeout (the async React-effect path) ------
  {
    const page = await mkPage(browser);
    await page.click("#go");
    await page.waitForTimeout(600);
    await page.waitForTimeout(6000);
    results.H3_escalate_from_setTimeout = await attempt(page, async () => {
      return await new Promise((resolve) => {
        setTimeout(async () => {
          try {
            await document.documentElement.requestFullscreen();
            resolve({ resolved: true, fullscreenElement: document.fullscreenElement === document.documentElement ? "HTML" : (document.fullscreenElement?.id ?? null) });
          } catch (e) { resolve({ resolved: false, error: String(e && e.name) }); }
        }, 300);
      });
    });
    await page.close();
  }

  await browser.close();
  results._meta = { mode, ranAt: new Date().toISOString() };
  return results;
};

const i = process.argv.indexOf("--mode");
const mode = i > -1 ? process.argv[i + 1] : "chromium";
const results = await run(mode);
writeFileSync(join(HERE, `activation-probe-${mode}.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
