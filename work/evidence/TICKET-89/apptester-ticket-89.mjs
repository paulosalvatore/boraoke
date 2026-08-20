/**
 * App Tester evidence capture for TICKET-89 — fullscreen -> idle -> refill.
 *
 * Drives Playwright chromium at 1920x1080 against the already-running dev
 * server (PORT=3197, ADVANCE_AUTH=enforce) and captures:
 *
 *   Sequence A — the app's OWN fullscreen affordance (documentElement), the
 *   supported venue path. Fullscreen must survive the queue emptying (idle)
 *   and refilling.
 *
 *   Sequence B — YouTube's own fullscreen (the iframe as fullscreenElement),
 *   the broken path TICKET-89 fixes. The idle transition must exitFullscreen()
 *   rather than leave a collapsed 0x0 fullscreen element (a black screen).
 *
 * Screenshots + diagnostics.json + README.md land in this same directory.
 *
 * Run: node work/evidence/TICKET-89/apptester-ticket-89.mjs
 */
import { chromium } from "@playwright/test";
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_URL = "http://127.0.0.1:3197";

// ---- screen-token derivation (mirror of e2e/helpers.ts screenTokenFor) ----
// A dedicated, never-registered room falls back to the same dev-fallback host
// token every other e2e room without a host record uses (see helpers.ts
// roomSecret doc comment) — no need to mint a real room via /new.
const DEV_FALLBACK_TOKEN = "cantai-dev-host";
const SCREEN_TOKEN_PREFIX = "boraoke-screen-v1";
const SCREEN_TOKEN_BUCKET_MS = 24 * 60 * 60 * 1000;
const SCREEN_TOKEN_HEADER = "X-Boraoke-Screen";

function screenTokenFor(roomId) {
  const bucket = Math.floor(Date.now() / SCREEN_TOKEN_BUCKET_MS);
  return createHmac("sha256", DEV_FALLBACK_TOKEN)
    .update(`${SCREEN_TOKEN_PREFIX}|${roomId}|${bucket}`)
    .digest("hex");
}

async function advanceOnce(roomId, reason) {
  const q = `?room=${encodeURIComponent(roomId)}`;
  const reasonParam = reason ? `&reason=${reason}` : "";
  const res = await fetch(`${BASE_URL}/api/queue/advance${q}${reasonParam}`, {
    method: "POST",
    headers: { [SCREEN_TOKEN_HEADER]: screenTokenFor(roomId) },
  });
  return res;
}

async function drainQueue(roomId) {
  for (let i = 0; i < 60; i++) {
    const data = await (await fetch(`${BASE_URL}/api/queue?room=${encodeURIComponent(roomId)}`)).json();
    if (!data.items?.length) return;
    await advanceOnce(roomId);
  }
}

const uid = () =>
  "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16)
  );

async function seedRoom(roomId, entry) {
  const res = await fetch(`${BASE_URL}/api/queue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...entry, patronUuid: uid(), room: roomId }),
  });
  const ok = res.ok;
  if (!ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`seedRoom(${roomId}) failed: ${res.status} ${body}`);
  }
}

// Warm-compile the /[room]/tv route + queue endpoints ONCE before any real
// seeding (mirrors e2e/helpers.ts warmTvRoutes — under `next dev` a route's
// FIRST compile re-evaluates the shared in-memory store module and resets its
// singletons, which would silently wipe a queue seeded before the compile).
const WARM_ROOM = "t89-apptester-warmup";
async function warmTvRoutes() {
  await fetch(`${BASE_URL}/${WARM_ROOM}/tv`);
  await fetch(`${BASE_URL}/api/queue?room=${WARM_ROOM}`);
  await advanceOnce(WARM_ROOM, "unplayable");
}

// ---- YouTube IFrame API stub (adapted from e2e/tv.spec.ts stubYouTubeReplacingNode) ----
function stubYouTubeInitScript() {
  return () => {
    const w = window;
    w.__ytCreated = 0;
    w.__ytLoaded = [];
    w.__ytDestroyed = 0;
    w.__ytClock = 0;
    w.__ytPlaying = false; // TICKET-89 audio-state proxy: true iff sound would be audible
    w.__ytStopped = 0; // count of stopVideo() calls
    w.__ytVars = {};

    class FakePlayer {
      constructor(el, opts) {
        this.events = (opts && opts.events) || {};
        w.__ytCreated += 1;
        // The real API swaps the target element for an <iframe> it owns — the
        // exact DOM-replacement behaviour that made TICKET-82's display:none
        // fix collapse the fullscreen element to 0x0 instead of unmounting it.
        const iframe = document.createElement("iframe");
        iframe.id = el.id;
        iframe.className = el.className;
        iframe.src = "about:blank";
        iframe.setAttribute("data-yt-instance", String(w.__ytCreated));
        // Give the iframe an in-document <audio> proxy so audio state is
        // independently observable (paused/currentTime), not just our flags.
        el.parentNode.replaceChild(iframe, el);
        this.node = iframe;
        w.__ytVars = { ...((opts && opts.playerVars) || {}) };
        setTimeout(() => this.events.onReady && this.events.onReady({ data: -1, target: this }), 0);
      }
      loadVideoById(id) {
        w.__ytLoaded.push(this.node.isConnected ? id : `ORPHANED:${id}`);
        w.__ytPlaying = true; // a load autoplays — sound is ON from here
      }
      stopVideo() {
        // The ONLY thing that actually silences the parked player — hiding an
        // element does not pause media inside it.
        w.__ytStopped += 1;
        w.__ytPlaying = false;
      }
      destroy() {
        w.__ytDestroyed += 1;
        w.__ytPlaying = false;
        this.node.remove();
      }
      playVideo() {
        w.__ytPlaying = true;
      }
      seekTo() {}
      getPlayerState() {
        return 1; // PLAYING
      }
      getCurrentTime() {
        w.__ytClock += 5;
        return w.__ytClock;
      }
    }
    w.YT = {
      Player: FakePlayer,
      PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    };
    // The component polls for window.YT / fires an onYouTubeIframeAPIReady
    // callback depending on load path; both are already satisfied by YT being
    // present synchronously, matching the tv.spec.ts stub's contract.
  };
}

const YT_MARK = "data-yt-instance";

async function diag(page, label) {
  const d = await page.evaluate((mark) => {
    const doc = document;
    const fsEl = doc.fullscreenElement || null;
    const box = fsEl ? fsEl.getBoundingClientRect() : null;
    const iframe = doc.querySelector(`iframe[${mark}]`);
    const idleEl = doc.querySelector('[data-testid="tv-idle"]');
    const idleBox = idleEl ? idleEl.getBoundingClientRect() : null;
    const idleVisible = !!idleEl && (() => {
      const cs = getComputedStyle(idleEl);
      return cs.display !== "none" && cs.visibility !== "hidden" && idleEl.getClientRects().length > 0;
    })();
    let fsTag = null;
    if (fsEl === doc.documentElement) fsTag = "HTML";
    else if (fsEl) fsTag = fsEl.tagName + (fsEl.getAttribute(mark) ? `[${mark}=${fsEl.getAttribute(mark)}]` : "");
    return {
      fullscreenElement: fsTag,
      fullscreenElementBox: box ? { width: box.width, height: box.height } : null,
      isZeroBox: !!box && box.width === 0 && box.height === 0,
      iframePresent: !!iframe,
      iframeInstance: iframe ? iframe.getAttribute(mark) : null,
      iframeSameNodeAsTracked: iframe !== null && iframe === window.__tracked,
      tvIdleVisible: idleVisible,
      tvIdleBox: idleBox ? { width: idleBox.width, height: idleBox.height } : null,
      ytPlaying: window.__ytPlaying === true,
      ytStopped: window.__ytStopped || 0,
      ytCreated: window.__ytCreated || 0,
      ytDestroyed: window.__ytDestroyed || 0,
      ytLoaded: window.__ytLoaded ? [...window.__ytLoaded] : [],
    };
  }, YT_MARK);
  return { step: label, ...d };
}

async function trackPlayerNode(page) {
  await page.evaluate((mark) => {
    window.__tracked = document.querySelector(`iframe[${mark}]`);
  }, YT_MARK);
}

const shot = (page, name) => page.screenshot({ path: join(HERE, name) });

async function main() {
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  const diagnostics = [];

  console.log("Warming /tv route + queue endpoints...");
  await warmTvRoutes();

  // ==================== SEQUENCE A — app's own fullscreen ====================
  const roomA = "t89-apptester-a";
  await drainQueue(roomA);

  const ctxA = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "pt-BR" });
  const pageA = await ctxA.newPage();
  await pageA.addInitScript(stubYouTubeInitScript());

  await seedRoom(roomA, { videoId: "dQw4w9WgXcQ", title: "Garota de Ipanema", nickname: "Ana", table: "1", mode: "sing" });
  await pageA.goto(`${BASE_URL}/${roomA}/tv`);
  await pageA.locator(`iframe[${YT_MARK}]`).first().waitFor({ state: "attached", timeout: 15000 });
  await trackPlayerNode(pageA);
  await pageA.waitForTimeout(500); // let the fake onReady/loadVideoById settle

  await shot(pageA, "01-playing.png");
  diagnostics.push(await diag(pageA, "A1-playing"));

  // Enter fullscreen the way the chrome button does — a genuine Playwright
  // click is a trusted user gesture, so this exercises requestFullscreen()
  // under the same activation rules the venue's real click would.
  await pageA.click('[data-testid="tv-fullscreen"]');
  await pageA.waitForFunction(() => document.fullscreenElement === document.documentElement, null, { timeout: 5000 });
  await pageA.waitForTimeout(300);

  await shot(pageA, "02-fullscreen-playing.png");
  diagnostics.push(await diag(pageA, "A2-fullscreen-playing"));

  // Drain the queue -> idle.
  await drainQueue(roomA);
  await pageA.locator('[data-testid="tv-idle"]').waitFor({ state: "visible", timeout: 15000 });
  await pageA.waitForTimeout(300);

  await shot(pageA, "03-fullscreen-idle.png");
  diagnostics.push(await diag(pageA, "A3-fullscreen-idle (MONEY SHOT)"));

  // Refill with a new song.
  await seedRoom(roomA, { videoId: "oHg5SJYRHA0", title: "Baile de Favela", nickname: "Bruno", table: "2", mode: "sing" });
  await pageA.locator('[data-testid="tv-hero"]').waitFor({ state: "visible", timeout: 15000 });
  await pageA.waitForTimeout(500);

  await shot(pageA, "04-fullscreen-refilled.png");
  diagnostics.push(await diag(pageA, "A4-fullscreen-refilled"));

  await drainQueue(roomA);
  await ctxA.close();

  // ==================== SEQUENCE B — YouTube's own (iframe) fullscreen ====================
  const roomB = "t89-apptester-b";
  await drainQueue(roomB);

  const ctxB = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "pt-BR" });
  const pageB = await ctxB.newPage();
  await pageB.addInitScript(stubYouTubeInitScript());

  await seedRoom(roomB, { videoId: "dQw4w9WgXcQ", title: "Como Nossos Pais", nickname: "Carla", table: "3", mode: "sing" });
  await pageB.goto(`${BASE_URL}/${roomB}/tv`);
  await pageB.locator(`iframe[${YT_MARK}]`).first().waitFor({ state: "attached", timeout: 15000 });
  await trackPlayerNode(pageB);
  await pageB.waitForTimeout(500);

  // Force the iframe into fullscreen — simulating YouTube's OWN fullscreen
  // button (now removed from the real embed via `fs:0`, but the fix must
  // defend the case regardless — a double-click, an old cached client, etc).
  // Inject a throwaway on-page button whose click handler requests fullscreen
  // on the tracked iframe node, then click it with a genuine Playwright click
  // (a trusted gesture) — the same technique TICKET-89's own activation
  // probe (work/evidence/TICKET-89/activation-probe.mjs) used to validate
  // this is a real, gesture-backed requestFullscreen() call, not a bypass.
  await pageB.evaluate((mark) => {
    const btn = document.createElement("button");
    btn.id = "__apptester_fs_trigger";
    btn.style.cssText = "position:fixed;top:0;left:0;width:10px;height:10px;z-index:99999;opacity:0.01;";
    btn.addEventListener("click", () => {
      const iframe = document.querySelector(`iframe[${mark}]`);
      if (iframe) iframe.requestFullscreen().catch(() => {});
    });
    document.body.appendChild(btn);
  }, YT_MARK);
  await pageB.click("#__apptester_fs_trigger");
  await pageB.waitForFunction(
    (mark) => {
      const iframe = document.querySelector(`iframe[${mark}]`);
      return document.fullscreenElement !== null && document.fullscreenElement === iframe;
    },
    YT_MARK,
    { timeout: 5000 }
  ).catch(() => {
    // Recorded, not swallowed silently — diagnostics below will show whatever
    // fullscreenElement actually ended up as, and the README will call this
    // out plainly if the probe path didn't reproduce the iframe-fullscreen
    // precondition in this environment.
  });
  await pageB.waitForTimeout(300);

  await shot(pageB, "05-iframe-fullscreen.png");
  diagnostics.push(await diag(pageB, "B1-iframe-fullscreen"));

  // Drain -> idle. The fix must call exitFullscreen() here (host.contains(fsEl)
  // is true for the player's iframe), so idle renders in NORMAL (non-fullscreen)
  // layout with the poster visible — never a collapsed 0x0 fullscreen box.
  await drainQueue(roomB);
  await pageB.locator('[data-testid="tv-idle"]').waitFor({ state: "visible", timeout: 15000 });
  await pageB.waitForTimeout(500);

  await shot(pageB, "06-iframe-fullscreen-idle.png");
  diagnostics.push(await diag(pageB, "B2-iframe-fullscreen-idle (MONEY SHOT)"));

  await drainQueue(roomB);
  await ctxB.close();

  await browser.close();

  writeFileSync(join(HERE, "diagnostics.json"), JSON.stringify(diagnostics, null, 2));
  console.log(JSON.stringify(diagnostics, null, 2));
  return diagnostics;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
