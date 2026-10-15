# TICKET-99 — Reviewer report (D-022 opus review), PR #80

**Branch:** `ticket/99-runtime-check` · **Base:** `origin/main` · **Reviewed:** 2026-09-01
**Scope reviewed:** `app/layout.tsx` (globalThis shim), `scripts/tv-runtime-check.mjs` (runtime gate), `work/reports/TICKET-99-runtime-checkpoint.md`, event log.

**Verdict: REQUEST-CHANGES.**

The diagnosis is correct, the shim works, and the harness genuinely discriminates the defect — I reproduced all of that first-hand on Chromium 68.0.3440.0. But the harness is presented as a **gate**, and I proved it exits **0 with zero assertions performed** when the browser dies mid-run. For a gate, a demonstrated false green is blocking. Two further blocking items: the harness is wired into nothing, and the only committed report in the PR actively contradicts the PR.

Everything below was re-derived from source or from runs I performed myself.

---

## What I verified first-hand (positive findings)

**The defect is real and exactly as diagnosed.** Harness run against live production (which does not yet carry the shim):

```
[tv-runtime-check] CDP bound. Browser: HeadlessChrome/68.0.3440.0, Protocol-Version: 1.3, V8-Version: 6.8.275
[tv-runtime-check]   hydration marker on [data-testid="tv-root"]: root-present=true, hydrated=false
[tv-runtime-check]   QR liveness: qr-img=false, qr-placeholder=true
[tv-runtime-check] Runtime.exceptionThrown count: 1
[tv-runtime-check]   exception: Uncaught — ReferenceError: globalThis is not defined
    at Object.7297 (https://boraoke.com/_next/static/chunks/255-3981a3d1f3561bd8.js:1:106560)
    at r (https://boraoke.com/_next/static/chunks/webpack-cf65fde047d5dfd4.js:1:127)
[tv-runtime-check] error-level console/log entries: 0
tv-runtime-check: FAIL (Chromium 561733, url=https://boraoke.com/default/tv)
```

Exit code 1. Chunk `255`, `ReferenceError: globalThis is not defined`, thrown during webpack module init before React attaches. Matches the brief exactly.

**The shim fixes it.** Same harness against the branch's own build (`.next` from this worktree, served on :3099):

```
[tv-runtime-check]   hydration marker on [data-testid="tv-root"]: root-present=true, hydrated=true
[tv-runtime-check]   QR liveness: qr-img=true, qr-placeholder=false
[tv-runtime-check] Runtime.exceptionThrown count: 0
tv-runtime-check: OK — app booted, hydrated, and rendered the real QR on Chromium 561733
```

Exit code 0. This is an **independent reproduction of the reverse-check**: without the shim FAIL, with the shim PASS, on the pinned engine, with both load-bearing assertions flipping in both directions.

**The shim leaves no residue on the happy path.** I drove Chrome 68 against the branch build over CDP and inspected the global:

```json
{ "hasGT": "object", "gtIsWindow": true,
  "protoResidue": false, "gt99Reachable": false,
  "gtOwnDesc": { "enumerable": true, "writable": true, "configurable": true },
  "forInSeesGlobalThis": 1 }
```

`Object.prototype.__gt99__` is gone, `globalThis === window`. The technique works as claimed.

**Scope discipline is clean.** The diff is 4 files, all in scope. No unrelated changes, no debug code (`grep` for `debugger|TODO|FIXME|console.debug` over both source files: no hits), no secret material in the diff (`api_key|secret|token|password|AKIA|-----BEGIN|sk-…`: no hits), and **no AI-attribution trailers** in any of the eight commits — all authored `Paulo Salvatore <salvatoregames@gmail.com>` with clean bodies.

**No CSP exists in this repo.** `grep -rniE "content-security-policy|contentSecurityPolicy|script-src|nonce"` across all `.ts/.tsx/.js/.mjs/.json` (excluding `node_modules`) returns nothing, and `next.config.ts` sets no `headers()`. So the inline script is not blocked today. (See NIT-4 for the forward risk and a dangling comment.)

---

## Blocking findings

### B1 — HIGH: the harness exits 0, having asserted nothing, when the browser dies mid-run (proven false green)

This is the exact failure class the ticket exists to prevent, and it is not hypothetical — I reproduced it.

I ran the harness against the (good) local build, waited for navigation, then `kill -9`'d the Chromium process it owns:

```
[tv-runtime-check] CDP bound. Browser: HeadlessChrome/68.0.3440.0 ...
[tv-runtime-check] navigating to http://127.0.0.1:3099/default/tv
[tv-runtime-check] chromium process killed by signal: SIGKILL
HARNESS_EXIT=0
```

No DOM check ran. No verdict line printed. No `OK` line. **Exit code 0** — GREEN to any CI runner or `&&` chain that keys on exit status.

Root cause, from source:

- `scripts/tv-runtime-check.mjs:308` — `overallTimer.unref?.()`. The hard overall timeout is **unref'd**, so it cannot keep the event loop alive and cannot fire once it is the only handle left.
- `cdpClient()` (lines 188–232) registers no `close` handler, so the `pending` map is never rejected when the socket goes away. The in-flight `Runtime.evaluate` promise dangles forever.
- When the WebSocket and the child process handles both drop, the loop empties. Node exits with its default code — **0** — without ever entering either the success path (`process.exit(0)`) or the `catch` block (`process.exit(1)`).

Note this is not an exotic scenario for this build: the PR's own checkpoint report documents this Chromium 68 snapshot wedging and being killed on a loaded host, and the harness itself warns about host load.

Concrete fixes (any one closes it; I'd take all three):

1. Drop `.unref()` from `overallTimer` so the hard timeout is authoritative.
2. In `cdpClient`, add `ws.addEventListener("close", …)` that rejects every entry in `pending` with a "CDP disconnected" error, so the `catch` block runs.
3. Belt-and-braces default-deny: set a `verdictReached` flag only where a verdict is actually printed, and add
   `process.on("exit", () => { if (!verdictReached) process.exitCode = 1; });`
   so that *any* future path exiting without a verdict is RED by construction. This is the general fix; 1 and 2 close today's two known routes.

For completeness, the failure paths I probed that **do** behave correctly: no `--url` → exit 1; unreachable target → `FAIL — Page.navigate failed: net::ERR_CONNECTION_REFUSED`, exit 1; a throw inside `Runtime.evaluate` → caught, exit 1; missing `--chromium-path` → throws, exit 1.

### B2 — HIGH: the "gate" is wired into nothing, so nothing it proves is pinned

`package.json` `build` runs `next build && node scripts/check-bundle-es-target.mjs && node scripts/check-css-target.mjs`. `tv-runtime-check.mjs` appears in **no** npm script, and `.github/workflows/ci.yml` never invokes it. `grep -rn "tv-runtime-check"` across the repo returns only the script itself and a stale line in the checkpoint report. It is a manual script.

Two consequences, and the second is the one that matters:

- The PR's own header calls this "the one that actually launches the pinned old Chromium" alongside two gates that *are* wired into `build`. As shipped it is not a peer of those; it is a script someone must remember to run.
- **It is therefore not a pin on anything.** This directly answers the ordering question in F3 below: a future Next upgrade that moves the shim's `<script>` after the chunks *at execution time*, or a dependency that reintroduces an unguarded modern global, would ship with every gate green. The harness would have caught it — if anything ran it.

There is a real obstacle that needs a decision rather than a one-line fix: `CHROMIUM_SNAPSHOT_URL` hardcodes the **`/Mac/`** snapshot path (line 52), so the harness cannot run on `ubuntu-latest`. Options worth weighing: add a `Linux_x64` branch keyed on `process.platform` and add a CI step; or keep it local-only but add an `npm run check:tv-runtime` script plus an explicit line in the release/deploy checklist naming when it must be run. Either is fine — shipping it referenced by nothing is not.

### B3 — MEDIUM (blocking under `prove-your-test-can-fail`): the only committed report contradicts the PR, and the reverse-check evidence is not durable

`work/reports/TICKET-99-runtime-checkpoint.md` is committed **as part of this PR** and says, verbatim:

- line 6: *"No script has been committed yet (`scripts/tv-runtime-check.mjs` does not exist in this worktree)."*
- line 35: *"`scripts/tv-runtime-check.mjs` — **not written yet**. No code changes exist in this worktree."*
- line 38: *"Discriminating negative-control run (pre-fix commit must FAIL, post-fix must PASS): not started."*
- line 41: *"No PR opened."*

All four are now false. This is the PR's only durable narrative, and a reader six months from now gets an actively misleading one.

Per the house standard, the reverse-check evidence — (b), the verbatim failure output against the pre-fix implementation — must live in the PR, not in a chat report. For a fix whose entire purpose is preventing a recurrence, that is a blocking omission. Fix: rewrite the checkpoint into a completion report carrying the actual pre-fix-FAIL / post-fix-PASS output, or supersede it with a new report and say so. (This review file carries an independent copy of that evidence, which mitigates but does not substitute for the dev-side record.)

**Assertion audit — which assertions are actually load-bearing.** Derived from my two runs (bad build vs good build), not from the code comments:

| Assertion | bad build | good build | discriminating? |
|---|---|---|---|
| `Runtime.exceptionThrown` count == 0 | 1 | 0 | **yes** |
| React hydration marker on `tv-root` | false | true | **yes** |
| `qr-img` present / `qr-placeholder` gone | false / true | true / false | **yes** |
| `SHELL_SELECTORS` present | FOUND | FOUND | no (SSR-satisfiable — correctly labelled in-source) |
| `MEANINGFUL_CONTENT_SELECTORS` present | FOUND | FOUND | no (same) |
| error-level console/log entries == 0 | **0** | 0 | **no — see F4** |

The hydration-marker hedge in the source comment ("NOT yet confirmed live against React 19") is now resolved: it reads `true` on a hydrated React 19 build and `false` on a dead one. Worth updating that comment to record the confirmation, otherwise the next reader will distrust a true FAIL.

**Triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path.**

---

## Non-blocking findings

### F3 — MEDIUM: the ordering claim is factually wrong; the shim wins a race rather than being ordered first

Both the source comment (`app/layout.tsx:32`) and the commit body state: *"An inline head script runs before any async/deferred chunk script."* That is not what Next emits. I served the branch's own build and read the HTML it produced:

```
   447  <script src="/_next/static/chunks/87c73c54-….js" async="">
   529  <script src="/_next/static/chunks/18-….js" async="">
   605  <script src="/_next/static/chunks/main-app-….js" async="">
   687  <script src="/_next/static/chunks/66-….js" async="">
   763  <script src="/_next/static/chunks/532-….js" async="">
   840  <script src="/_next/static/chunks/app/(patron)/%5Broom%5D/tv/page-….js" async="">
   945  <script src="/_next/static/chunks/app/layout-….js" async="">
  1073  <script>   ← the shim
  1301  <script src="/_next/static/chunks/polyfills-….js" noModule="">
```

React 19 hoists Next's `bootstrapScripts` to the **top** of `<head>`; the root layout's own `<head>` children render after them. The shim's tag is at byte 1073, **after all seven chunk `<script async>` tags** — including the one that needs the global. (Production HTML shows the identical shape, chunk `255` at byte 529 and polyfills last at 2597, which independently confirms the "Next loads polyfills LAST" half of the diagnosis.)

Why it still works, and why that is not the same as being correct: `async` scripts cannot execute before their fetch completes, and the whole `<head>` is 1387 bytes — the parser reaches and synchronously executes the inline shim within the first network buffer, long before any 100KB+ chunk lands. The margin is enormous, which is why my run passed and why it will pass in practice. But it is a margin, not an ordering guarantee: `async` execution may interleave at a parser yield, so a warm memory cache, a service worker, or a slow-streaming head narrows it.

Recommend: (a) correct the comment and the commit narrative to say what is actually true — *"the shim is emitted after the chunk tags but executes first because async scripts must complete a fetch"* — since the current wording will mislead the next person who reasons about it; (b) evaluate `next/script` with `strategy="beforeInteractive"`, which Next documents for precisely this hoist-a-polyfill-ahead-of-the-bundle case; (c) most importantly, B2 — with the harness wired in, this ordering is *tested*, and the exact mechanism matters much less.

### F4 — MEDIUM: the console-error assertion is dead weight, and a live flakiness landmine

The brief's suspicion is confirmed in both directions. On the run where an uncaught `ReferenceError` killed the app, `Runtime.exceptionThrown count: 1` and `error-level console/log entries: 0`. On the healthy run, also `0`. The assertion has never been non-zero in either state, so it contributes **nothing** to this gate's discriminating power — `Runtime.exceptionThrown` is doing all the work.

That alone is only dead weight. The problem is that it is also a **failure condition** (line 451). The CDP `Log` domain reports network and rendering entries at `error` level — a 404 on a font, an image, or a third-party asset produces an `error`-level `Log.entryAdded` with no bearing on old-Chromium compatibility. So the assertion currently provides zero signal and a nonzero chance of failing the TV gate for an unrelated reason.

Recommend one of: drop it; or keep collecting the entries and **report** them without failing on them (useful diagnostics, honest about not being proof); or narrow it to `entry.source === "javascript"` so it means what a reader assumes it means. Whichever is chosen, the log line should stop implying coverage it does not have.

### F5 — LOW: the shim can leave a permanent `Object.prototype` property if the middle statement throws

```js
Object.defineProperty(Object.prototype,"__gt99__",{get:function(){return this},configurable:true});
__gt99__.globalThis=__gt99__;      // ← if this throws, the delete never runs
delete Object.prototype.__gt99__
```

I confirmed no residue on the happy path (`protoResidue: false` above), and the failure requires something unusual (a frozen global, a hostile `globalThis` setter). But the consequence is global and permanent for the page: every object in the document inherits a `__gt99__` accessor returning itself. A `try { … } finally { delete Object.prototype.__gt99__ }` costs ~25 bytes and removes the class entirely. The comment's claim that the shim "cannot throw" is only true of the guarded no-op path on modern browsers, not of the shim body itself.

### F6 — LOW: a simpler formulation is equally correct here and mutates nothing global

The `Object.prototype` accessor trick exists in core-js because core-js must obtain the global in *any* realm — browser, worker, Node — from one snippet. This script runs in exactly one place: an inline `<script>` in an HTML `<head>`, where `window` is guaranteed to exist and *is* the global object. So:

```js
(function(){if(typeof globalThis!=="object"){window.globalThis=window}})();
```

is equivalent for this deployment, half the size, and touches nothing but one property on `window`. It also makes F5 impossible. I verified the property the current shim produces is `globalThis === window` (`gtIsWindow: true`), i.e. exactly what the one-liner yields. Not blocking — the current version demonstrably works — but a reviewer should not let an `Object.prototype` mutation ship where an assignment does the job.

**On the cost/benefit of shipping this to every user at all:** it is fine. On Chrome 71+ the guard short-circuits and the block never executes, and the payload is ~180 uncompressed bytes in each HTML response. That is a reasonable price for webOS 4.5/5.0 coverage, and the TL's own TV is the reported symptom. The objection is to the *formulation*, not to the trade.

### F7 — LOW: the shimmed `globalThis` is enumerable; the native one is not

`gtOwnDesc: {enumerable: true, …}` versus the spec's `{writable:true, enumerable:false, configurable:true}`, and `for (var k in window)` now yields `globalThis` once (`forInSeesGlobalThis: 1`). Only matters to code that enumerates `window`, which is rare — but if the one-liner in F6 is adopted it is free to fix with `Object.defineProperty(window,"globalThis",{value:window,writable:true,configurable:true})`.

### F8 — LOW: a fixed `SETTLE_MS` sleep makes the gate timing-flaky on a loaded host

Line 386 sleeps a flat `SETTLE_MS` (5s default) and then asserts once. The QR assertion depends on `QRCode.toDataURL()` resolving inside a `useEffect` — on a box under the load this harness itself warns about, 5s is a guess. This direction produces false **RED**, not false green, so it is not blocking; but a gate that cries wolf gets disabled. Recommend polling the DOM check every ~250ms until all assertions pass or a deadline expires, then asserting on the final state. That is strictly more robust and usually much faster.

---

## Nits

- **NIT-1:** `scripts/tv-runtime-check.mjs:94` — *"the cache dir is gitignored"*. It is not; `DEFAULT_CACHE_DIR` is under `os.tmpdir()`, entirely outside the repo. The claim is harmless but wrong, and `.gitignore` contains no such entry. Say "outside the repo, under the OS temp dir".
- **NIT-2:** The `Page.loadEventFired` handler (line 376) is registered *after* `Page.navigate` resolves, so a fast load can fire before anyone is listening and the run falls through to the full `sleep(30_000)`. Costs 30s, never correctness. Register the listener before navigating.
- **NIT-3:** `cdp.onEvent` appends to `eventHandlers` and nothing ever removes them; the load-event handler stays live for the rest of the run. Harmless today, untidy.
- **NIT-4:** `next.config.ts` carries a dangling comment — *"Allow YouTube iframe embedding in CSP"* — above no CSP configuration at all. Separately, since this PR's fix depends on an inline script, it is worth a one-line note somewhere durable that **adding a CSP without a `nonce`/hash for this script will silently re-break webOS 4.5/5.0** with no failing test (until B2 is closed). Cheap insurance against a future security-hardening PR.

---

## What would clear the verdict

1. Close **B1** — the harness must never exit 0 without a printed verdict. (The `process.on("exit")` default-deny is the durable form.)
2. Close **B2** — wire it in, or give it an npm script plus a named place in a checklist that says when it runs. Resolve the macOS-only snapshot URL either way.
3. Close **B3** — make the committed report tell the truth and carry the verbatim reverse-check output.

F3's comment correction and F4's decision on the console assertion I'd take in the same round since both are a few lines; F5–F8 and the nits are fine as follow-ups if the TM prefers to ship.

The underlying engineering here is good: the diagnosis is exactly right, the reverse-check discipline caught a real SSR-satisfiable false green mid-PR (commit `74aca5c`), and the in-source honesty about which selectors prove what is better than most gates get. The blockers are about the gate being trustworthy and reachable, not about the fix being wrong.

---

*Reviewer: opus (D-022). Evidence in this report was re-derived independently — two full harness runs on Chromium 68.0.3440.0, a CDP residue probe, a served build of this branch inspected for script ordering, and a deliberate mid-run browser kill. No product code was modified.*
