#!/usr/bin/env node
/**
 * Old-Chromium runtime gate (TICKET-99), sibling to check-bundle-es-target.mjs
 * and check-css-target.mjs.
 *
 * WHY THIS EXISTS: the ES-parse gate (TICKET-98) and the CSS-target gate
 * (TICKET-101) both catch STATIC compatibility defects by reading source —
 * neither one ever runs the app. A chunk can parse at ES2019 and a stylesheet
 * can avoid every listed feature and the app can STILL fail to boot or render
 * on the real target engine, because of something only observable at runtime:
 * a Web API the engine lacks, a polyfill that itself needs a newer feature, a
 * hydration mismatch that only old V8 exhibits, timing. This gate is the one
 * that actually launches the pinned old Chromium and watches the page live —
 * it is slow and heavy on purpose, which is why the other two gates exist to
 * catch what they catch cheaply and this one is reserved for what they can't.
 *
 * SCOPE, stated honestly: this proves the app boots and renders meaningful DOM
 * on ONE pinned old-Chromium build, driven headless, on ONE machine. It does
 * not prove every TV model, every input device, every network condition. See
 * work/reports/TICKET-99-runtime-checkpoint.md for the feasibility record and
 * the reverse-check (known-bad commit fails, post-fix commit passes) that
 * proves this gate is discriminating rather than a permanent false green.
 *
 * WHY RAW CDP, NOT PLAYWRIGHT/PUPPETEER: both drive browsers through protocol
 * surfaces (and, for Puppeteer's launcher assumptions) that assume a modern
 * Chromium. The pinned build here is Chromium 68 (2018) — talking to it needs
 * nothing more than the Chrome DevTools Protocol over a plain WebSocket, which
 * Node has natively (globalThis.WebSocket, confirmed present on Node 22+).
 * Reaching for a browser-automation library here would silently upgrade what
 * actually gets tested.
 *
 * WHY NEVER WEBKIT: WebKit is a different engine lineage than the ones this
 * gate targets (old-Chromium webOS TVs). A WebKit probe would load both the
 * broken pre-fix bundle and the fixed one cleanly under a spoofed webOS UA —
 * it has no Chrome 68 V8/Blink parse or CSS floor to trip on — which would
 * make this gate a permanent false green on exactly the defect class TICKET-98
 * and TICKET-101 exist to catch. Chromium only.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, openSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, loadavg } from "node:os";
import { join } from "node:path";

/**
 * The oldest engine we intend to boot AND render on, expressed as the
 * Chromium build actually pinned and launched. Revision 561733 == Chromium
 * 68.0.3440.0 == LG webOS 4.5/5.0 (2019-2020 TVs) — same floor as the other
 * two TICKET-99-family gates. Raising this is a PRODUCT decision, not a
 * script tweak (see check-bundle-es-target.mjs's TARGET_ECMA comment).
 */
const CHROMIUM_REVISION = "561733";
const CHROMIUM_SNAPSHOT_URL = `https://commondatastorage.googleapis.com/chromium-browser-snapshots/Mac/${CHROMIUM_REVISION}/chrome-mac.zip`;

const DEFAULT_CACHE_DIR = join(tmpdir(), "boraoke-tv-runtime-check-chromium");
const CDP_PORT = Number(process.env.TV_RUNTIME_CDP_PORT ?? 9333);
const OVERALL_TIMEOUT_MS = Number(process.env.TV_RUNTIME_TIMEOUT_MS ?? 120_000);
const LAUNCH_TIMEOUT_MS = Number(process.env.TV_RUNTIME_LAUNCH_TIMEOUT_MS ?? 60_000);
const SETTLE_MS = Number(process.env.TV_RUNTIME_SETTLE_MS ?? 5_000);

function log(...args) {
  console.log(`[tv-runtime-check]`, ...args);
}
function errlog(...args) {
  console.error(`[tv-runtime-check]`, ...args);
}

function parseArgs(argv) {
  const out = { url: null, chromiumPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--chromium-path") out.chromiumPath = argv[++i];
  }
  return out;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Locate a usable Chromium binary. Checked-in override > cache dir > fetch.
 * The binary itself is NEVER committed — the cache dir is gitignored, and if
 * absent this fetches the pinned snapshot fresh (~83MB) and quarantine-clears
 * it (macOS Gatekeeper blocks an unsigned x86_64 binary otherwise).
 */
async function resolveChromium(explicitPath) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`--chromium-path given but not found: ${explicitPath}`);
    }
    return explicitPath;
  }

  const cachedBinary = join(DEFAULT_CACHE_DIR, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium");
  if (existsSync(cachedBinary)) {
    log(`using cached Chromium ${CHROMIUM_REVISION} at ${cachedBinary}`);
    return cachedBinary;
  }

  log(`no cached Chromium found — fetching pinned revision ${CHROMIUM_REVISION} (~83MB, one-time)`);
  mkdirSync(DEFAULT_CACHE_DIR, { recursive: true });
  const zipPath = join(DEFAULT_CACHE_DIR, "chrome-mac.zip");

  const res = await fetchWithTimeout(CHROMIUM_SNAPSHOT_URL, 60_000);
  if (!res.ok) {
    throw new Error(`Chromium snapshot fetch failed: HTTP ${res.status} from ${CHROMIUM_SNAPSHOT_URL}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(zipPath, buf);

  await run("unzip", ["-q", zipPath, "-d", DEFAULT_CACHE_DIR]);
  await run("xattr", ["-cr", join(DEFAULT_CACHE_DIR, "chrome-mac", "Chromium.app")]);

  if (!existsSync(cachedBinary)) {
    throw new Error(`Chromium fetched+unzipped but binary not found at expected path: ${cachedBinary}`);
  }
  log(`fetched and quarantine-cleared Chromium ${CHROMIUM_REVISION}`);
  return cachedBinary;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    p.on("error", reject);
  });
}

/**
 * Launch Chromium headless with the exact flags proven (TICKET-99 Phase 1) to
 * bind CDP on this build. --enable-logging=stderr --v=1 is kept PERMANENTLY —
 * it is what distinguishes "wedged in sandbox init" from "wedged in IPC" on a
 * future failure; a silent probe can only be re-run, a verbose one can be
 * diagnosed. Logs are captured to a file, never dropped.
 */
function launchChromium(binaryPath, userDataDir, logPath) {
  const args = [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--enable-logging=stderr",
    "--v=1",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ];
  const fd = openSync(logPath, "a");
  const child = spawn(binaryPath, args, { stdio: ["ignore", fd, fd] });
  return child;
}

async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(`http://127.0.0.1:${port}/json/version`, 2000);
      if (res.ok) return await res.json();
    } catch (e) {
      lastErr = e;
    }
    await sleep(500);
  }
  throw new Error(`CDP never bound port ${port} within ${timeoutMs}ms (last error: ${lastErr?.message ?? "n/a"})`);
}

/** Open a fresh CDP target navigated at `url` and return its websocket URL. */
async function newTarget(port, url) {
  const res = await fetchWithTimeout(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, 5000);
  if (!res.ok) throw new Error(`/json/new failed: HTTP ${res.status}`);
  const target = await res.json();
  if (!target.webSocketDebuggerUrl) throw new Error(`/json/new returned no webSocketDebuggerUrl: ${JSON.stringify(target)}`);
  return target;
}

/** Minimal raw-CDP client over the global WebSocket. */
function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const eventHandlers = [];

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const h of eventHandlers) h(msg.method, msg.params);
    }
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (e) => reject(new Error(`CDP websocket error: ${e.message ?? e}`)));
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function onEvent(handler) {
    eventHandlers.push(handler);
  }

  function close() {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  return { ready, send, onEvent, close };
}

/** DOM selectors the checkpoint already identified — see the checkpoint file. */
const ALWAYS_PRESENT_SELECTORS = ['[data-testid="tv-root"]', '[data-testid="tv-chrome"]'];
const MEANINGFUL_CONTENT_SELECTORS = ['[data-testid="tv-idle"]', '[data-testid="tv-hero"]'];

async function main() {
  const { url, chromiumPath } = parseArgs(process.argv.slice(2));
  if (!url) {
    errlog("FAIL — no --url given. Usage: tv-runtime-check.mjs --url http://localhost:3099/default/tv");
    process.exit(1);
  }

  const loadAvg1 = loadavg()[0];
  log(`starting — target url: ${url}, host 1-min load average: ${loadAvg1.toFixed(2)}`);

  const binaryPath = await resolveChromium(chromiumPath);
  const userDataDir = mkdtempSync(join(tmpdir(), "boraoke-tv-runtime-udata-"));
  const logPath = join(userDataDir, "chromium-stderr.log");

  let child = null;
  let cdp = null;
  const overallTimer = setTimeout(() => {
    errlog(`FAIL — hard overall timeout (${OVERALL_TIMEOUT_MS}ms) exceeded. Forcing exit.`);
    cleanup();
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);
  overallTimer.unref?.();

  function cleanup() {
    try {
      cdp?.close();
    } catch {
      /* noop */
    }
    try {
      if (child && !child.killed) child.kill("SIGKILL");
    } catch {
      /* noop */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }

  const runtimeExceptions = [];
  const consoleErrors = [];

  try {
    log(`launching Chromium ${CHROMIUM_REVISION} headless on CDP port ${CDP_PORT} (launch timeout ${LAUNCH_TIMEOUT_MS}ms)`);
    child = launchChromium(binaryPath, userDataDir, logPath);
    child.on("exit", (code, sig) => {
      if (code !== null) log(`chromium process exited early: code=${code}`);
      if (sig) log(`chromium process killed by signal: ${sig}`);
    });

    const version = await waitForCdp(CDP_PORT, LAUNCH_TIMEOUT_MS);
    log(`CDP bound. Browser: ${version.Browser}, Protocol-Version: ${version["Protocol-Version"]}, V8-Version: ${version["V8-Version"] ?? "n/a"}`);

    const target = await newTarget(CDP_PORT, "about:blank");
    cdp = cdpClient(target.webSocketDebuggerUrl);
    await cdp.ready;

    cdp.onEvent((method, params) => {
      if (method === "Runtime.exceptionThrown") {
        runtimeExceptions.push(params);
      } else if (method === "Log.entryAdded") {
        const entry = params.entry;
        if (entry && (entry.level === "error" || entry.level === "SEVERE")) {
          consoleErrors.push(entry);
        }
      } else if (method === "Console.messageAdded") {
        const m = params.message;
        if (m && m.level === "error") {
          consoleErrors.push({ source: "console", text: m.text, level: m.level });
        }
      }
    });

    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Console.enable");
    await cdp.send("Page.enable");

    log(`navigating to ${url}`);
    const navResult = await cdp.send("Page.navigate", { url });
    if (navResult.errorText) {
      throw new Error(`Page.navigate failed: ${navResult.errorText}`);
    }

    // Wait for load, bounded — old Chromium can be slow, but never unbounded.
    await Promise.race([
      new Promise((resolve) => {
        cdp.onEvent((method) => {
          if (method === "Page.loadEventFired") resolve();
        });
      }),
      sleep(30_000),
    ]);

    // Settle time for client-side hydration/render after the load event.
    await sleep(SETTLE_MS);

    const domCheck = await cdp.send("Runtime.evaluate", {
      expression: `
        (function() {
          const always = ${JSON.stringify(ALWAYS_PRESENT_SELECTORS)};
          const meaningful = ${JSON.stringify(MEANINGFUL_CONTENT_SELECTORS)};
          const alwaysFound = always.map(function(s) { return { selector: s, found: !!document.querySelector(s) }; });
          const meaningfulFound = meaningful.map(function(s) { return { selector: s, found: !!document.querySelector(s) }; });
          return {
            alwaysFound: alwaysFound,
            meaningfulFound: meaningfulFound,
            bodyChildCount: document.body ? document.body.children.length : -1,
            readyState: document.readyState
          };
        })()
      `,
      returnByValue: true,
    });

    if (domCheck.exceptionDetails) {
      throw new Error(`Runtime.evaluate for DOM check threw: ${JSON.stringify(domCheck.exceptionDetails)}`);
    }

    const domResult = domCheck.result.value;

    clearTimeout(overallTimer);

    // ---- Report + verdict ----
    log(`document.readyState: ${domResult.readyState}, body children: ${domResult.bodyChildCount}`);
    for (const { selector, found } of domResult.alwaysFound) {
      log(`  always-present selector ${selector}: ${found ? "FOUND" : "MISSING"}`);
    }
    for (const { selector, found } of domResult.meaningfulFound) {
      log(`  meaningful-content selector ${selector}: ${found ? "FOUND" : "MISSING"}`);
    }
    log(`Runtime.exceptionThrown count: ${runtimeExceptions.length}`);
    for (const exc of runtimeExceptions) {
      errlog(`  exception: ${exc.exceptionDetails?.text ?? "?"} — ${exc.exceptionDetails?.exception?.description ?? ""}`);
    }
    log(`error-level console/log entries: ${consoleErrors.length}`);
    for (const entry of consoleErrors) {
      errlog(`  console error: ${entry.text ?? JSON.stringify(entry)}`);
    }

    const failures = [];
    if (runtimeExceptions.length > 0) failures.push(`${runtimeExceptions.length} Runtime.exceptionThrown event(s)`);
    if (consoleErrors.length > 0) failures.push(`${consoleErrors.length} error-level console/log entr(y/ies)`);
    for (const { selector, found } of domResult.alwaysFound) {
      if (!found) failures.push(`always-present selector missing: ${selector}`);
    }
    const anyMeaningful = domResult.meaningfulFound.some((m) => m.found);
    if (!anyMeaningful) {
      failures.push(`neither meaningful-content selector present: ${MEANINGFUL_CONTENT_SELECTORS.join(" or ")}`);
    }

    cleanup();

    if (failures.length > 0) {
      errlog(`\ntv-runtime-check: FAIL (Chromium ${CHROMIUM_REVISION}, url=${url})\n`);
      for (const f of failures) errlog(`  - ${f}`);
      errlog(`\nChromium stderr log: ${logPath} (see it before it's deleted — it isn't, it's under the temp user-data-dir)`);
      errlog(`Host 1-min load average at run time was ${loadAvg1.toFixed(2)}; if this failure looks like a hard`);
      errlog(`incompatibility, re-check under a quiet host before concluding — a heavily loaded host can produce`);
      errlog(`misleading timing/liveness results, not just slow ones.`);
      process.exit(1);
    }

    log(`\ntv-runtime-check: OK — app booted and rendered meaningful DOM on Chromium ${CHROMIUM_REVISION} (${url}).\n`);
    process.exit(0);
  } catch (err) {
    clearTimeout(overallTimer);
    errlog(`FAIL — ${err.message ?? err}`);
    errlog(`Host 1-min load average at run time was ${loadAvg1.toFixed(2)}.`);
    if (existsSync(logPath)) {
      errlog(`Chromium stderr log at ${logPath} (captured via --enable-logging=stderr --v=1):`);
      try {
        errlog(readFileSync(logPath, "utf8").slice(-4000));
      } catch {
        /* noop */
      }
    }
    cleanup();
    process.exit(1);
  }
}

main();
