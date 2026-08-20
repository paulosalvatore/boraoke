/**
 * TICKET-89 — standalone Fullscreen API probe (v2).
 *
 * The TICKET-82 fix hides `.main` with `display: none` while the queue is idle.
 * The player iframe lives INSIDE `.main`, so the question that decides this
 * ticket is the ANCESTOR case: if the iframe is the fullscreen element (the
 * venue clicked YouTube's own fullscreen button, `controls: 1`), does hiding an
 * ancestor exit fullscreen?
 *
 * Probes:
 *   A  display:none on the fullscreen element ITSELF
 *   B  display:none on an ANCESTOR of the fullscreen element   <-- the ticket
 *   C  display:none on a DESCENDANT of the fullscreen element
 *   D  fullscreen on documentElement + display:none on a descendant
 *      (= what boraoke's OWN `F` / "fullscreen" affordance does)
 *   E  visibility:hidden on an ancestor of the fullscreen element
 *   F  requestFullscreen WITHOUT a user gesture
 *   G  does hidden (display:none / visibility:hidden) media keep playing audio
 *
 * Run:  node work/evidence/TICKET-89/fullscreen-probe.mjs [--mode shell|chromium|headed]
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const PAGE = `<!doctype html><meta charset=utf-8><title>fs probe</title>
<style>
  #anc{width:400px;height:300px;background:#0a0}
  #target{width:300px;height:200px;background:#00a}
  #desc{width:80px;height:40px;background:#a00}
</style>
<button id=go>go</button>
<div id=anc><div id=target><div id=desc></div><iframe id=frame src=about:blank></iframe></div></div>
<script>
  window.__log = [];
  document.addEventListener("fullscreenchange", () =>
    window.__log.push(document.fullscreenElement ? (document.fullscreenElement.id || "HTML") : "NONE"));
  document.getElementById("go").addEventListener("click", () => {
    var id = window.__target || "target";
    var el = id === "HTML" ? document.documentElement : document.getElementById(id);
    el.requestFullscreen().catch(e => window.__log.push("REJECT:" + e.name));
  });
</script>`;

const run = async (mode) => {
  const launch = { args: ["--autoplay-policy=no-user-gesture-required"] };
  if (mode === "shell") launch.headless = true;
  if (mode === "chromium") { launch.headless = true; launch.channel = "chromium"; }
  if (mode === "headed") { launch.headless = false; launch.channel = "chromium"; }

  const browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.route("**/probe", (r) => r.fulfill({ contentType: "text/html", body: PAGE }));
  await page.goto("http://probe.local/probe");

  const results = {};
  const fsEl = () => page.evaluate(() => (document.fullscreenElement ? document.fullscreenElement.id || "HTML" : null));
  const log = () => page.evaluate(() => window.__log);
  const enter = async (id) => {
    await page.evaluate((t) => { window.__target = t; window.__log = []; }, id);
    await page.click("#go"); // genuine user gesture
    await page.waitForTimeout(500);
    return fsEl();
  };
  const exit = async () => {
    await page.evaluate(() => document.fullscreenElement && document.exitFullscreen().catch(() => {}));
    await page.waitForTimeout(400);
  };
  const setStyle = (id, prop, val) =>
    page.evaluate(([i, p, v]) => (document.getElementById(i).style[p] = v), [id, prop, val]);

  const hideCase = async (name, fsTargetId, hideId, prop, val) => {
    await exit();
    const entered = await enter(fsTargetId);
    await setStyle(hideId, prop, val);
    await page.waitForTimeout(600);
    const after = await fsEl();
    const painted = await page.evaluate((i) => {
      const el = document.getElementById(i) || document.documentElement;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { w: Math.round(r.width), h: Math.round(r.height), display: cs.display, visibility: cs.visibility };
    }, fsTargetId === "HTML" ? "" : fsTargetId);
    results[name] = { fullscreenBefore: entered, fullscreenAfter: after, exited: entered !== null && after === null, events: await log(), fullscreenElementBox: painted };
    await setStyle(hideId, prop, "");
    await exit();
  };

  await hideCase("A_hide_the_fullscreen_element_itself", "target", "target", "display", "none");
  await hideCase("B_hide_an_ANCESTOR_of_the_fullscreen_element", "target", "anc", "display", "none");
  await hideCase("C_hide_a_DESCENDANT_of_the_fullscreen_element", "target", "desc", "display", "none");
  await hideCase("D_documentElement_fullscreen__hide_a_descendant", "HTML", "anc", "display", "none");
  await hideCase("E_visibilityHidden_on_an_ANCESTOR", "target", "anc", "visibility", "hidden");

  // ---- F: requestFullscreen with NO user gesture --------------------------
  await exit();
  results.F_requestFullscreen_without_user_gesture = await page.evaluate(async () => {
    try {
      await document.getElementById("target").requestFullscreen();
      return { resolved: true, fullscreenElement: document.fullscreenElement?.id ?? null };
    } catch (e) {
      return { resolved: false, error: String(e && e.name), message: String(e && e.message) };
    }
  });
  await exit();

  // ---- G: does hidden media keep playing? ---------------------------------
  results.G_hidden_media_keeps_playing = await page.evaluate(async () => {
    const out = {};
    const ctxTone = () => {
      // A real, decodable 0.5s 440Hz WAV so the element genuinely enters PLAYING.
      const sr = 8000, n = sr / 2, bytes = 44 + n * 2;
      const b = new ArrayBuffer(bytes), v = new DataView(b);
      const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
      s(0, "RIFF"); v.setUint32(4, bytes - 8, true); s(8, "WAVEfmt ");
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true);
      v.setUint16(34, 16, true); s(36, "data"); v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin((i / sr) * 440 * 2 * Math.PI) * 16000, true);
      let bin = ""; new Uint8Array(b).forEach((c) => (bin += String.fromCharCode(c)));
      return "data:audio/wav;base64," + btoa(bin);
    };
    const a = document.createElement("audio");
    a.src = ctxTone(); a.loop = true;
    document.getElementById("target").appendChild(a);
    try { await a.play(); } catch (e) { return { error: String(e && e.name) }; }
    const st = () => ({ paused: a.paused, muted: a.muted, volume: a.volume, currentTime: Number(a.currentTime.toFixed(3)) });
    out.whileVisible = st();
    document.getElementById("anc").style.display = "none";
    await new Promise((r) => setTimeout(r, 700));
    out.afterAncestorDisplayNone = st();
    document.getElementById("anc").style.display = "";
    document.getElementById("anc").style.visibility = "hidden";
    await new Promise((r) => setTimeout(r, 700));
    out.afterAncestorVisibilityHidden = st();
    document.getElementById("anc").style.visibility = "";
    a.pause(); a.remove();
    out.verdict =
      !out.afterAncestorDisplayNone.paused || !out.afterAncestorVisibilityHidden.paused
        ? "HIDING DOES NOT STOP AUDIO — silence must be explicit (stopVideo/mute)"
        : "hiding paused the media";
    return out;
  });

  await browser.close();
  results._meta = { mode, ranAt: new Date().toISOString() };
  return results;
};

const modeArg = process.argv.indexOf("--mode");
const mode = modeArg > -1 ? process.argv[modeArg + 1] : "shell";
const results = await run(mode);
const out = join(HERE, `fullscreen-probe-${mode}.json`);
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
console.log("\nwrote", out);
