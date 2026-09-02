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
 * a Web API/global the engine lacks (see: the `globalThis` defect this exact
 * gate found — valid ES2019 syntax, missing runtime global, invisible to a
 * parser), a polyfill that itself needs a newer feature, a hydration mismatch
 * that only old V8 exhibits, timing. This gate is the one that actually
 * launches the pinned old Chromium and watches the page live — it is slow and
 * heavy on purpose, which is why the other two gates exist to catch what they
 * catch cheaply and this one is reserved for what they can't.
 *
 * SCOPE, stated honestly: this proves the app boots and renders meaningful DOM
 * on ONE pinned old-Chromium build, driven headless, on ONE machine. It does
 * not prove every TV model, every input device, every network condition. See
 * work/reports/TICKET-99-runtime-checkpoint.md for the reverse-check (known-bad
 * commit fails, post-fix commit passes, verbatim output) that proves this gate
 * is discriminating rather than a permanent false green.
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
 *
 * DEFAULT-DENY, BY CONSTRUCTION (D-022 review finding B1): a gate script's
 * unhandled failure mode is Node's own default exit code, which is 0 — GREEN.
 * A reviewer proved this concretely: kill the Chromium process mid-navigate
 * (after CDP binds, before the DOM check runs) and the pre-fix version of this
 * script printed no verdict and exited 0. Root cause was two independent bugs
 * (an `.unref()`'d hard timeout that could never fire once it was the last
 * event-loop handle, and a CDP client that never rejected in-flight promises
 * on socket close) compounding into a silent empty-loop exit. Both are fixed
 * below, AND there is a third, structural backstop: `verdictReached` is set
 * true only at the two places that print an actual verdict, and a
 * `process.on("exit", ...)` handler forces `exitCode = 1` whenever the process
 * is about to end without one having been reached — so ANY future code path
 * that falls through without printing PASS or FAIL is red by construction,
 * not by the author having remembered to add another `process.exit(1)`.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, openSync, chmodSync, writeFileSync, readFileSync } from "node:fs";
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

/**
 * Chromium snapshots are published per-platform under one revision number.
 * This runs both on a developer's Mac and on GitHub Actions' `ubuntu-latest`
 * runners, so the snapshot path, archive layout, and binary location are all
 * platform-dependent — hardcoding `/Mac/` here was a real gap (D-022 review
 * finding B2): it made the gate unable to run in CI at all.
 */
function platformSnapshotInfo() {
  const platform = process.platform;
  if (platform === "darwin") {
    return {
      dirSegment: "Mac",
      zipName: "chrome-mac.zip",
      unzippedDir: "chrome-mac",
      binaryRelPath: ["Chromium.app", "Contents", "MacOS", "Chromium"],
      needsQuarantineClear: true,
    };
  }
  if (platform === "linux") {
    return {
      dirSegment: "Linux_x64",
      zipName: "chrome-linux.zip",
      unzippedDir: "chrome-linux",
      binaryRelPath: ["chrome"],
      needsQuarantineClear: false,
    };
  }
  throw new Error(
    `No pinned Chromium ${CHROMIUM_REVISION} snapshot layout known for process.platform="${platform}" (only darwin and linux are wired up).`,
  );
}

const SNAPSHOT_INFO = platformSnapshotInfo();
const CHROMIUM_SNAPSHOT_URL = `https://commondatastorage.googleapis.com/chromium-browser-snapshots/${SNAPSHOT_INFO.dirSegment}/${CHROMIUM_REVISION}/${SNAPSHOT_INFO.zipName}`;

/** Outside the repo entirely (OS temp dir) — never committed, no .gitignore entry needed. */
const DEFAULT_CACHE_DIR = join(tmpdir(), "boraoke-tv-runtime-check-chromium");
const CDP_PORT = Number(process.env.TV_RUNTIME_CDP_PORT ?? 9333);
const OVERALL_TIMEOUT_MS = Number(process.env.TV_RUNTIME_TIMEOUT_MS ?? 120_000);
const LAUNCH_TIMEOUT_MS = Number(process.env.TV_RUNTIME_LAUNCH_TIMEOUT_MS ?? 60_000);
/** Max time to poll the DOM waiting for hydration + the QR to resolve (D-022 F8: was a flat sleep). */
const SETTLE_DEADLINE_MS = Number(process.env.TV_RUNTIME_SETTLE_MS ?? 8_000);
const POLL_INTERVAL_MS = 250;

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
 * The binary itself is NEVER committed — the cache dir lives outside the repo
 * under the OS temp dir, and if absent this fetches the pinned snapshot fresh
 * (~80-90MB depending on platform) and, on macOS, quarantine-clears it
 * (Gatekeeper otherwise blocks an unsigned x86_64 binary).
 */
async function resolveChromium(explicitPath) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`--chromium-path given but not found: ${explicitPath}`);
    }
    return explicitPath;
  }

  const cachedBinary = join(DEFAULT_CACHE_DIR, SNAPSHOT_INFO.unzippedDir, ...SNAPSHOT_INFO.binaryRelPath);
  if (existsSync(cachedBinary)) {
    log(`using cached Chromium ${CHROMIUM_REVISION} at ${cachedBinary}`);
    return cachedBinary;
  }

  log(`no cached Chromium found — fetching pinned revision ${CHROMIUM_REVISION} for ${process.platform} (one-time)`);
  mkdirSync(DEFAULT_CACHE_DIR, { recursive: true });
  const zipPath = join(DEFAULT_CACHE_DIR, SNAPSHOT_INFO.zipName);

  const res = await fetchWithTimeout(CHROMIUM_SNAPSHOT_URL, 60_000);
  if (!res.ok) {
    throw new Error(`Chromium snapshot fetch failed: HTTP ${res.status} from ${CHROMIUM_SNAPSHOT_URL}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(zipPath, buf);

  await run("unzip", ["-q", zipPath, "-d", DEFAULT_CACHE_DIR]);
  if (SNAPSHOT_INFO.needsQuarantineClear) {
    await run("xattr", ["-cr", join(DEFAULT_CACHE_DIR, SNAPSHOT_INFO.unzippedDir)]);
  }

  if (!existsSync(cachedBinary)) {
    throw new Error(`Chromium fetched+unzipped but binary not found at expected path: ${cachedBinary}`);
  }
  try {
    chmodSync(cachedBinary, 0o755);
  } catch {
    /* best-effort — the archive usually preserves the executable bit already */
  }
  log(`fetched and prepared Chromium ${CHROMIUM_REVISION}`);
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

/**
 * Minimal raw-CDP client over the global WebSocket.
 *
 * D-022 review B1 fix: the websocket going away (Chromium killed, crashed, or
 * wedged mid-request) used to leave any in-flight `send()` promise dangling
 * forever, with nothing to reject it — which is exactly how the process could
 * fall through to Node's default (green) exit code with zero verdict printed.
 * Both "close" and "error" now reject every pending request so the caller's
 * `await cdp.send(...)` always settles one way or the other.
 */
function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const eventHandlers = [];

  function rejectAllPending(err) {
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  }

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

  ws.addEventListener("close", () => {
    rejectAllPending(new Error("CDP websocket closed unexpectedly (browser exited or connection dropped)"));
  });
  ws.addEventListener("error", (e) => {
    rejectAllPending(new Error(`CDP websocket error: ${e.message ?? e}`));
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (e) => reject(new Error(`CDP websocket error: ${e.message ?? e}`)));
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
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

/**
 * DOM selectors, and WHY each one is or isn't proof of JS execution.
 *
 * IMPORTANT: `tv-root`, `tv-chrome`, `tv-idle`/`tv-hero`, and `qr-placeholder`
 * are all present in the raw SERVER-RENDERED HTML — confirmed directly against
 * production (`curl https://boraoke.com/default/tv`). A browser that fetches
 * the page and renders static HTML with ZERO JS execution — e.g. Chrome 68
 * hitting the known-bad pre-fix bundle, which fails to parse and never boots —
 * still satisfies every one of those selectors. Asserting only on them proves
 * "the server responded and the shell rendered", NOT that the app booted.
 *
 * So there are two tiers below:
 *  - SHELL_SELECTORS: SSR-only proof, kept because they're still worth having,
 *    but labeled honestly — never treated as boot proof.
 *  - The hydration marker and the QR-image selector are the actual boot proof:
 *    both can only become true by client JS actually executing. These are the
 *    only two DOM-derived load-bearing assertions (plus `Runtime.exceptionThrown`
 *    — see below for why the console/log-error assertion that used to sit
 *    alongside them was removed).
 */
const SHELL_SELECTORS = ['[data-testid="tv-root"]', '[data-testid="tv-chrome"]'];
const MEANINGFUL_CONTENT_SELECTORS = ['[data-testid="tv-idle"]', '[data-testid="tv-hero"]'];

/**
 * React attaches an internal instance key directly onto the DOM node as an
 * own property once it hydrates — `__reactFiber$<id>` (and `__reactProps$<id>`)
 * — never present in the raw SSR HTML the browser initially receives, and
 * never something server-rendered markup can fake. CONFIRMED LIVE (D-022
 * review + this ticket's own reverse-check) against this project's actual
 * `react@^19.0.0` client output: `hydrated: true` on a genuinely hydrated
 * build, `hydrated: false` on a build whose client JS never ran. Checking all
 * three prefixes (`__reactFiber$`, `__reactProps$`, `__reactContainer$`)
 * remains a harmless hedge, not an unresolved guess.
 */
const HYDRATION_ROOT_SELECTOR = '[data-testid="tv-root"]';

/**
 * The QR itself (TICKET-99's actual reported symptom — "the QR didn't show" on
 * the Tech Lead's TV). `components/QrCode.tsx` SSRs a `qr-placeholder` div and
 * ONLY replaces it with `<img data-testid="qr-img">` from a `useEffect` that
 * calls `QRCode.toDataURL()` client-side. The idle state (`tv-idle`, the state
 * a fresh `default` room renders) always mounts a `<QrCode value={joinUrl} .../>`.
 * So "qr-img present, qr-placeholder gone" is both a genuine JS-executed
 * signal AND the literal user-visible symptom.
 */
const QR_IMG_SELECTOR = '[data-testid="qr-img"]';
const QR_PLACEHOLDER_SELECTOR = '[data-testid="qr-placeholder"]';

/**
 * D-022 review finding F4: the console/log error-level assertion that used to
 * live here was measured, on real runs against both a fatal-ReferenceError
 * build and a healthy build, to be ZERO entries in BOTH cases — it never once
 * discriminated. Worse, it is actively dangerous to keep as a failure
 * condition: the CDP `Log` domain reports network/rendering entries at
 * "error" level too (a 404 on a font or a third-party asset), so it could
 * fail this TV gate for a reason with no bearing on old-Chromium
 * compatibility. Removed. The three assertions below are the only
 * load-bearing ones, each independently confirmed (via this ticket's
 * reverse-check) to flip in both directions between the known-bad and
 * post-fix builds: `Runtime.exceptionThrown` count, the hydration marker, and
 * the QR image flip.
 */

const domCheckExpression = `
  (function() {
    const shell = ${JSON.stringify(SHELL_SELECTORS)};
    const meaningful = ${JSON.stringify(MEANINGFUL_CONTENT_SELECTORS)};
    const shellFound = shell.map(function(s) { return { selector: s, found: !!document.querySelector(s) }; });
    const meaningfulFound = meaningful.map(function(s) { return { selector: s, found: !!document.querySelector(s) }; });

    const rootEl = document.querySelector(${JSON.stringify(HYDRATION_ROOT_SELECTOR)});
    var hydrated = false;
    if (rootEl) {
      hydrated = Object.keys(rootEl).some(function(k) {
        return k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactProps$") === 0 || k.indexOf("__reactContainer$") === 0;
      });
    }

    const qrImg = !!document.querySelector(${JSON.stringify(QR_IMG_SELECTOR)});
    const qrPlaceholder = !!document.querySelector(${JSON.stringify(QR_PLACEHOLDER_SELECTOR)});

    return {
      shellFound: shellFound,
      meaningfulFound: meaningfulFound,
      hydrationRootPresent: !!rootEl,
      hydrated: hydrated,
      qrImg: qrImg,
      qrPlaceholder: qrPlaceholder,
      bodyChildCount: document.body ? document.body.children.length : -1,
      readyState: document.readyState
    };
  })()
`;

async function evaluateDom(cdp) {
  const domCheck = await cdp.send("Runtime.evaluate", {
    expression: domCheckExpression,
    returnByValue: true,
  });
  if (domCheck.exceptionDetails) {
    throw new Error(`Runtime.evaluate for DOM check threw: ${JSON.stringify(domCheck.exceptionDetails)}`);
  }
  return domCheck.result.value;
}

/**
 * D-022 review F8: this used to be a single flat sleep before one DOM read.
 * The QR draw is async (`QRCode.toDataURL()` inside a `useEffect`), so a flat
 * sleep is a guess that produces false REDs under load, not false greens —
 * still worth fixing, since a gate that cries wolf gets disabled. Poll until
 * hydration + the QR both converge, or the deadline expires; return whatever
 * was last observed either way so the caller always has a result to report.
 */
async function pollDomUntilConverged(cdp, deadlineMs) {
  const start = Date.now();
  let last = await evaluateDom(cdp);
  while (Date.now() - start < deadlineMs) {
    if (last.hydrated && last.qrImg && !last.qrPlaceholder) return last;
    await sleep(POLL_INTERVAL_MS);
    last = await evaluateDom(cdp);
  }
  return last;
}

async function main() {
  const { url, chromiumPath } = parseArgs(process.argv.slice(2));

  // D-022 review B1, layer 3 (structural backstop): a verdict has been
  // reached only at the two places below that set this true right before
  // printing PASS or FAIL. If the process is about to exit for ANY other
  // reason — an unhandled rejection, an exotic fall-through, a future bug —
  // this forces exitCode 1 rather than trusting Node's default of 0.
  let verdictReached = false;
  process.on("exit", () => {
    if (!verdictReached) {
      process.exitCode = 1;
      // console, not errlog/log helpers — those may already be torn down by exit time.
      console.error("[tv-runtime-check] FAIL — process exiting without a printed verdict. Defaulting to exit 1 (default-deny).");
    }
  });

  if (!url) {
    errlog("FAIL — no --url given. Usage: tv-runtime-check.mjs --url http://localhost:3099/default/tv");
    verdictReached = true;
    process.exit(1);
  }

  const loadAvg1 = loadavg()[0];
  log(`starting — target url: ${url}, host 1-min load average: ${loadAvg1.toFixed(2)}, platform: ${process.platform}`);

  const binaryPath = await resolveChromium(chromiumPath);
  const userDataDir = mkdtempSync(join(tmpdir(), "boraoke-tv-runtime-udata-"));
  const logPath = join(userDataDir, "chromium-stderr.log");

  let child = null;
  let cdp = null;

  // D-022 review B1, layer 1: NOT unref'd. An unref'd timer cannot keep the
  // event loop alive, so once every other handle drops (e.g. Chromium is
  // killed and the websocket closes) this timer would never fire and the
  // process would idle out to Node's default exit code, 0. This must be the
  // one timer in the whole script guaranteed to run to completion.
  const overallTimer = setTimeout(() => {
    errlog(`FAIL — hard overall timeout (${OVERALL_TIMEOUT_MS}ms) exceeded. Forcing exit.`);
    verdictReached = true;
    cleanup();
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);

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
      }
    });

    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    // D-022 review NIT-2: register the load-event listener BEFORE navigating,
    // not after `Page.navigate` resolves — a fast load could otherwise fire
    // before anyone is listening, wasting the full 30s fallback for nothing.
    let loadEventFired = false;
    const loadEventPromise = new Promise((resolve) => {
      cdp.onEvent((method) => {
        if (method === "Page.loadEventFired") {
          loadEventFired = true;
          resolve();
        }
      });
    });

    log(`navigating to ${url}`);
    const navResult = await cdp.send("Page.navigate", { url });
    if (navResult.errorText) {
      throw new Error(`Page.navigate failed: ${navResult.errorText}`);
    }

    // Wait for load, bounded — old Chromium can be slow, but never unbounded.
    await Promise.race([loadEventPromise, sleep(30_000)]);
    if (!loadEventFired) {
      log(`Page.loadEventFired never observed within 30s fallback — proceeding to DOM check anyway (hard overall timeout still governs).`);
    }

    const domResult = await pollDomUntilConverged(cdp, SETTLE_DEADLINE_MS);

    clearTimeout(overallTimer);

    // ---- Report + verdict ----
    log(`document.readyState: ${domResult.readyState}, body children: ${domResult.bodyChildCount}`);
    for (const { selector, found } of domResult.shellFound) {
      log(`  SSR-shell selector ${selector}: ${found ? "FOUND" : "MISSING"} (proves the server responded and the shell rendered — NOT that JS executed)`);
    }
    for (const { selector, found } of domResult.meaningfulFound) {
      log(`  SSR-content selector ${selector}: ${found ? "FOUND" : "MISSING"} (also SSR — see above)`);
    }
    log(`  hydration marker on ${HYDRATION_ROOT_SELECTOR}: root-present=${domResult.hydrationRootPresent}, hydrated=${domResult.hydrated} (React fiber/props key attached only post-hydration — this is real JS-executed proof)`);
    log(`  QR liveness: qr-img=${domResult.qrImg}, qr-placeholder=${domResult.qrPlaceholder} (qr-img only exists once client JS draws the real QR — this is the Tech Lead's reported symptom)`);
    log(`Runtime.exceptionThrown count: ${runtimeExceptions.length}`);
    for (const exc of runtimeExceptions) {
      errlog(`  exception: ${exc.exceptionDetails?.text ?? "?"} — ${exc.exceptionDetails?.exception?.description ?? ""}`);
    }

    const failures = [];
    if (runtimeExceptions.length > 0) failures.push(`${runtimeExceptions.length} Runtime.exceptionThrown event(s)`);
    for (const { selector, found } of domResult.shellFound) {
      if (!found) failures.push(`SSR-shell selector missing: ${selector} (server did not even respond correctly)`);
    }
    const anyMeaningful = domResult.meaningfulFound.some((m) => m.found);
    if (!anyMeaningful) {
      failures.push(`neither SSR-content selector present: ${MEANINGFUL_CONTENT_SELECTORS.join(" or ")}`);
    }
    // The actual boot proof — these can only be true if client JS executed.
    if (!domResult.hydrated) {
      failures.push(`no React hydration marker found on ${HYDRATION_ROOT_SELECTOR} — the shell rendered (SSR) but client JS never hydrated it`);
    }
    if (!domResult.qrImg || domResult.qrPlaceholder) {
      failures.push(`QR never rendered client-side (qr-img found=${domResult.qrImg}, qr-placeholder still present=${domResult.qrPlaceholder}) — this is the exact symptom reported on the Tech Lead's TV`);
    }

    cleanup();

    if (failures.length > 0) {
      errlog(`\ntv-runtime-check: FAIL (Chromium ${CHROMIUM_REVISION}, url=${url})\n`);
      for (const f of failures) errlog(`  - ${f}`);
      errlog(`\nChromium stderr log: ${logPath} (see it before it's deleted — it isn't, it's under the temp user-data-dir)`);
      errlog(`Host 1-min load average at run time was ${loadAvg1.toFixed(2)}; if this failure looks like a hard`);
      errlog(`incompatibility, re-check under a quiet host before concluding — a heavily loaded host can produce`);
      errlog(`misleading timing/liveness results, not just slow ones.`);
      verdictReached = true;
      process.exit(1);
    }

    log(`\ntv-runtime-check: OK — app booted, hydrated, and rendered the real QR on Chromium ${CHROMIUM_REVISION} (${url}).\n`);
    verdictReached = true;
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
    verdictReached = true;
    process.exit(1);
  }
}

main();
