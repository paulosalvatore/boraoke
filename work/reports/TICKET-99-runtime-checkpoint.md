# TICKET-99 — Old-Chromium runtime harness: completion report

**Status: DONE.** `scripts/tv-runtime-check.mjs` exists, is committed, is wired into `npm run check:tv-runtime` and into CI (`.github/workflows/ci.yml`), and has cleared an opus (D-022) review round (initial verdict REQUEST-CHANGES on three blocking findings, all closed below). PR #80.

This file used to be a mid-task checkpoint (title: "RUNTIME half checkpoint (fleet throttle stop)") written while the fleet was throttled and before the script existed. That checkpoint is superseded — it is rewritten here to the current, actual state, per the opus review's B3 finding: a stale checkpoint claiming "not written yet" / "no PR opened" while committed as part of this exact PR was an actively misleading durable record, and the reverse-check evidence needed to live here, not only in chat.

## What exists

- `scripts/tv-runtime-check.mjs` — launches the pinned Chromium 68.0.3440.0 (revision 561733, ~ webOS 4.5/5.0) headless, drives it over raw CDP (no Playwright/Puppeteer/WebKit), asserts the app genuinely boots, hydrates, and renders — not just that bytes parsed.
- A globalThis shim in `app/layout.tsx` (`next/script strategy="beforeInteractive"`), fixing a real runtime defect this harness found: Next.js's own emitted client runtime makes unguarded `globalThis.crypto`/`globalThis.console` references, which throw a `ReferenceError` on Chrome 68-70 (`globalThis` landed in Chrome 71). webOS 4.5/5.0 only; webOS 6.0+ (Chrome 79+) is unaffected. This is a defect class the ES-parse gate (`check-bundle-es-target.mjs`) structurally cannot see — `globalThis` is valid ES2019+ syntax, just a missing runtime global.
- `npm run check:tv-runtime` (package.json) and a CI step (`.github/workflows/ci.yml`, "Old-Chromium runtime gate (TICKET-99)") that builds, serves on :3100, runs the check, and fails the job on a non-zero exit. A `Linux_x64` snapshot branch in the script (vs. the `Mac` branch a Dev runs locally) is exercised there, plus an `actions/cache` step keyed on the pinned revision so CI does not refetch ~80MB every run.

## Selectors used, and why two tiers

`curl`-ing production showed `tv-root`, `tv-chrome`, `tv-idle`, and `qr-placeholder` are ALL present in the raw server-rendered HTML, before any JS executes — confirmed directly, not assumed. A harness that only asserted those would pass even on a build that never boots (the known-bad pre-#76 commit's server still returns the same SSR shell). So the harness's assertions are two-tier:

- **SSR-shell** (`tv-root`, `tv-chrome`, `tv-idle`/`tv-hero`) — kept, labeled honestly as "server responded, shell rendered", never treated as boot proof.
- **Real boot proof, and the only three load-bearing assertions**: `Runtime.exceptionThrown` count == 0, a React hydration marker (`__reactFiber$`/`__reactProps$`/`__reactContainer$` own-property key on `tv-root`, only present post-hydration), and the QR flip (`components/QrCode.tsx` SSRs `qr-placeholder` and only client-JS replaces it with `<img data-testid="qr-img">` — this is also the literal symptom originally reported: "the QR didn't show").

A console/log error-level assertion originally sat alongside these three. The opus review measured it directly (both on a fatal-`ReferenceError` run and a healthy run) and found **zero discriminating power in both directions** — it never went non-zero on the broken run and stayed zero on the healthy run — while also being a live flakiness landmine (CDP's `Log` domain reports network 404s at error level, unrelated to old-Chromium compatibility). Removed.

## Reverse-check evidence (prove-your-test-can-fail), verbatim

All four runs below used Chromium `HeadlessChrome/68.0.3440.0`, Protocol-Version 1.3, V8-Version 6.8.275, on the fully revised harness (post opus-review fixes: default-deny exit handling, polling settle, three load-bearing assertions only).

### Step 0 — positive control against production, BEFORE the shim shipped: FAIL (correctly — a genuine defect, not a harness bug)

```
[tv-runtime-check] CDP bound. Browser: HeadlessChrome/68.0.3440.0, Protocol-Version: 1.3, V8-Version: 6.8.275
[tv-runtime-check] navigating to https://boraoke.com/default/tv
[tv-runtime-check]   hydration marker on [data-testid="tv-root"]: root-present=true, hydrated=false
[tv-runtime-check]   QR liveness: qr-img=false, qr-placeholder=true
[tv-runtime-check] Runtime.exceptionThrown count: 1
[tv-runtime-check]   exception: Uncaught — ReferenceError: globalThis is not defined
    at Object.7297 (https://boraoke.com/_next/static/chunks/255-3981a3d1f3561bd8.js:1:106560)
tv-runtime-check: FAIL (Chromium 561733, url=https://boraoke.com/default/tv)
  - 1 Runtime.exceptionThrown event(s)
  - no React hydration marker found on [data-testid="tv-root"]
  - QR never rendered client-side
EXIT:1
```

Diagnosed by fetching the actual chunk (`curl https://boraoke.com/_next/static/chunks/255-3981a3d1f3561bd8.js`): 4 unguarded `globalThis` references (crypto hashing, error-reporting fallback, CSS chunk registration) in Next's own client runtime — not our app code. Chrome 71+ has `globalThis`; the pinned floor is Chrome 68.

### Step 1 — post-fix WITH the shim, local build, served on :3099: PASS

```
[tv-runtime-check]   hydration marker on [data-testid="tv-root"]: root-present=true, hydrated=true
[tv-runtime-check]   QR liveness: qr-img=true, qr-placeholder=false
[tv-runtime-check] Runtime.exceptionThrown count: 0
tv-runtime-check: OK — app booted, hydrated, and rendered the real QR on Chromium 561733 (http://localhost:3099/default/tv).
EXIT:0
```

### Bonus control — post-fix code WITHOUT the shim (temporarily reverted `app/layout.tsx`, rebuilt, ran, then restored the shim before committing): FAIL, same signature as Step 0

Confirms the shim specifically — not incidental drift — is what carries the fix, and that the harness detects this defect class independent of which commit is under test.

### Step 2 — the reverse-check that matters: known-bad commit `58b44f8` (parent of PR #76, unparseable ES2022 syntax pre-downlevel): FAIL, as required

```
[tv-runtime-check] navigating to http://localhost:3099/default/tv
[tv-runtime-check]   hydration marker on [data-testid="tv-root"]: root-present=true, hydrated=false
[tv-runtime-check]   QR liveness: qr-img=false, qr-placeholder=true
[tv-runtime-check] Runtime.exceptionThrown count: 2
[tv-runtime-check]   exception: Uncaught — SyntaxError: Unexpected token ?
[tv-runtime-check]   exception: Uncaught — ReferenceError: globalThis is not defined
    at Object.7297 (http://localhost:3099/_next/static/chunks/255-3981a3d1f3561bd8.js:1:106560)
tv-runtime-check: FAIL (Chromium 561733, url=http://localhost:3099/default/tv)
  - 2 Runtime.exceptionThrown event(s)
  - no React hydration marker found on [data-testid="tv-root"] — the shell rendered (SSR) but client JS never hydrated it
  - QR never rendered client-side (qr-img found=false, qr-placeholder still present=true) — this is the exact symptom reported on the Tech Lead's TV
EXIT:1
```

**Which assertion caught it:** the DOM-level hydration marker and QR-liveness checks, not merely the console-error path (which no longer exists in the harness, and was measured to have zero discriminating power even when it did — see above). This is the evidence that the SSR-false-green fix is carrying real weight.

### B1 mid-run false-green reproduction (opus review D-022), verbatim

The opus reviewer proved a false green: killing the Chromium process mid-navigate (after CDP binds, before the DOM check runs) made the pre-review-fix harness print no verdict and exit 0. Root cause: an `.unref()`'d hard timeout that could never fire once it was the last event-loop handle, plus a CDP client that never rejected in-flight promises on socket close — together let the event loop empty out to Node's own default (green) exit code.

Fixed with three layers: dropped `.unref()`, added `ws.addEventListener("close"/"error", ...)` rejecting all pending CDP requests, and a structural `verdictReached` flag + `process.on("exit", ...)` default-deny (any exit without a printed verdict forces `exitCode = 1`).

Reproduced against the fixed harness, mid-navigate (killed the Chromium child right after the `navigating to ...` log line, confirmed via the harness's own log timing):

```
[tv-runtime-check] CDP bound. Browser: HeadlessChrome/68.0.3440.0, Protocol-Version: 1.3, V8-Version: 6.8.275
[tv-runtime-check] navigating to http://localhost:3099/default/tv
[tv-runtime-check] FAIL — CDP websocket error:
[tv-runtime-check] Host 1-min load average at run time was 16.09.
[tv-runtime-check] Chromium stderr log at .../chromium-stderr.log (captured via --enable-logging=stderr --v=1): ...
HARNESS_EXIT_CODE:1
```

Exit 1, verdict printed, no false green.

## Gate results

- `npx jest`: `Test Suites: 52 passed, 52 total` / `Tests: 5 skipped, 918 passed, 923 total`, exit 0.
- `npm run build`: `bundle-es-target: OK — all 47 chunk(s) parse at ES2019.` / `css-target: OK — the TV surface uses nothing newer than Chrome 68 (13 stylesheet(s) scanned).`, exit 0.

## Known follow-up (not built here, described only)

The `globalThis` class of defect — valid syntax, missing runtime global — is structurally invisible to the ES-parse gate. A sibling static gate scanning emitted chunks for **unguarded** references to globals unavailable at the Chrome-68 floor (`globalThis`, `structuredClone`, `Promise.allSettled`, `String.prototype.replaceAll`, …) would close this class cheaply and statically, ahead of ever needing to boot a real browser for it. The hard part is "unguarded": a naive grep would false-positive on Next's own `typeof globalThis === "object"` guarded usages in its webpack runtime and polyfills chunk, which are legitimate and harmless. Worth its own ticket.

## Historical note (Phase 1 feasibility record, kept for provenance)

The original feasibility question — can Chromium 68.0.3440.0 even launch and bind CDP on this Mac under Rosetta — was answered yes early in this ticket: on a quiet host it bound CDP in ~3 seconds, forked 2 children, and reported `HeadlessChrome/68.0.3440.0`, V8 `6.8.275`, DevTools protocol `1.3`. An earlier "inconclusive wedge" observation (no port bind, no child processes, 2+ minutes) was host starvation (fleet load ~166/16 cores at the time), not an incompatibility — confirmed by every run recorded above, all of which bound CDP within seconds.
