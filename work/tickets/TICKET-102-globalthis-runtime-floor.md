# TICKET-102 — `globalThis` ReferenceError: the app still does not boot on Chrome 68-70 (webOS 4.5/5.0)

Status: OPEN
Priority: HIGH
Filed: 2026-09-01
Found by: the TICKET-99 runtime harness, on its first real run against production

## Summary

Production boraoke **still does not boot on Chrome 68**, after PR #76 (parse floor) and PR #77 (TV CSS floor). Executing the live site in a pinned Chromium 68.0.3440.0 over CDP produces:

```
Uncaught — ReferenceError: globalThis is not defined
  at Object.7297 (/_next/static/chunks/255-3981a3d1f3561bd8.js:1:106560)
```

One root cause, three symptoms: the error throws during module init before React attaches, so hydration never happens and the QR never renders — the exact symptom the Tech Lead reported on 2026-08-27 ("the QR didn't show").

## Root cause, verified independently

`globalThis` landed in **Chrome 71** / V8 7.1. The target engine is Chrome 68 (V8 6.8).

Not every use is a problem, and the distinction determines the fix:

- `webpack-<hash>.js` (x2) — **guarded**: `if("object"==typeof globalThis)return globalThis; try{return this||Function("return this")()}`. `typeof` on an undeclared identifier does not throw. Safe, and it deliberately falls back.
- `polyfills-<hash>.js` (x4) — **guarded**: `o("object"==typeof globalThis&&globalThis)||o("object"==typeof window&&window)`. Safe.
- **`255-<hash>.js` (x4) — UNGUARDED**: `globalThis.crypto.subtle.digest(...)`, `globalThis.crypto`, `globalThis.console.error(e)`. Bare property access on an undeclared identifier → **ReferenceError**. This is the killer, and it matches the stack trace.

**Script order makes it unfixable by Next.js itself.** From the served `/default/tv` HTML:

```
4bd1b696….js, 255….js, main-app….js, 955….js, 769….js, page….js, layout….js, polyfills….js
```

`255` loads **second**; Next's own polyfills chunk loads **last**. Next.js ships its polyfills after the runtime chunk that needs the global, so no Next-side configuration resolves this.

## Why no existing gate caught it — this is a THIRD failure class

`check-bundle-es-target.mjs` parses every chunk at ES2019 and passes: **`globalThis` is valid ES2019 syntax**. Acorn parses it happily. This is not a syntax floor, it is a **missing runtime global** — invisible to any static parse-level check, and equally invisible to `check-css-target.mjs`.

Three distinct classes have now been hit from one declaration of `browserslist: chrome >= 68`, none of which that declaration actually enforced:

1. **Parse floor** — `static {}` from next-intl (fixed, PR #76, gated).
2. **CSS feature floor** — flex `gap` / `inset` (fixed for `/tv`, PR #77, gated; landing surfaces held in PR #79).
3. **Runtime global floor** — this ticket. **No gate exists.**

## Scope — narrower than it sounds, state it accurately

`globalThis` is available from **Chrome 71**. Affected range is **Chrome 68/69/70**, i.e. **webOS 4.5 and 5.0 only**. webOS 6.0 (Chrome 79), 22 (87), 23 (94) and newer are **unaffected**.

So this is a real breach of the floor declared in #76, but it **does not explain a failure on a webOS 6+ television**. The Tech Lead's LG model / webOS version remains the deciding fact for his 2026-08-27 night.

## Fix

A minimal `globalThis` shim as an **inline `<script>` in the document head** of the root layout, so it executes before any async/deferred chunk script. Must be tiny, must not throw on modern browsers, and must carry a comment explaining why it cannot live in a normal polyfill (Next loads its polyfills chunk after the chunk that needs the global).

## Follow-up: a gate for the class (proposed, not yet built)

A sibling to the two existing gates that scans emitted chunks for **unguarded** references to globals unavailable at the declared floor — `globalThis` (71), `structuredClone` (98), `Promise.allSettled` (76), `String.prototype.replaceAll` (85), `Array.prototype.at` (92), and similar.

**The hard part is "unguarded."** A naive substring scan reports the webpack and polyfills cases above as failures when they are correct, defensive code. Any such gate must distinguish a `typeof X` guard (and `X in window` / `try/catch` forms) from a bare property access, or it will be turned off within a week for crying wolf — which is worse than not having it.

## Acceptance criteria

- The pinned-Chromium-68 harness (`scripts/tv-runtime-check.mjs`) **PASSES** against a local build with the shim.
- The same harness **FAILS** against the pre-#76 base `58b44f8` (discriminating control).
- The same harness **FAILS** against a post-fix build **without** the shim, on this `globalThis` error specifically — proving it catches a class the ES-parse gate structurally cannot.
- The scope statement above (webOS 4.5/5.0 only) is reflected in the board, so nobody reads this as an explanation of a webOS 6+ failure.
