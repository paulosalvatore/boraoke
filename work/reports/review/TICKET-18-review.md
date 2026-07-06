# TICKET-18 — Reviewer Gate Report: TV mode — bigger type + fullscreen

- **Date:** 2026-07-06 · **Role:** Reviewer (sonnet first-pass / D-022) · **Branch:** `ticket/18-tv-fullscreen` · **PR:** #9
- **Worktree reviewed:** `/Users/paulosalvatore/Documents/GitHub/cantai/.worktrees/ticket-18`
- **Diff base:** `6aafe485` (origin/main) → `origin/ticket/18-tv-fullscreen`
- **Verdict:** APPROVE

---

## D-011 Verdict

**[reviewer] APPROVE** — all 6 ACs pass, 42/42 unit, 5/5 e2e verified independently by this reviewer, build confirms `/tv` is Dynamic, architecture is correct, scope discipline is clean, security waiver is sound. No blocking items.

---

## Preconditions verified

| Gate | Status | Evidence |
|------|--------|----------|
| App Tester | PASS | `work/reports/testing/TICKET-18-app-test.md`; 7 screenshots in `work/evidence/ticket-18/apptester-*.png`; all 6 ACs verified |
| Cyber Security | TM-waived (N/A-by-content) | Waiver sound — see §Security waiver below |
| CI | PASS | `gh pr checks 9`: `Vercel pass`, `Vercel Preview Comments pass`; GitHub Actions billing-broken house-wide (pre-existing, S1 contract via local verification) |
| Evidence | Present | `work/evidence/ticket-18/` — before/after at 1080p, footer-off, chrome-hidden states; 7 App Tester screenshots |

---

## Reviewer test run (independent verification)

All commands run from `.worktrees/ticket-18` against `origin/ticket/18-tv-fullscreen` tip:

```
npm ci                    ✓
npm test                  42/42 PASS (4 suites: api-queue, queue, youtube, tv-config)
npm run build             ✓ compiled; /tv → ƒ (Dynamic) as intended
PORT=3018 npm run test:e2e  5/5 PASS (12.9s)
  ✓ submit-song.spec.ts:10 › patron submits a song (1.6s)
  ✓ tv.spec.ts:46         › idle state renders (AC3, AC6) (2.5s)
  ✓ tv.spec.ts:64         › playing state: hero scale, max-3 rail, ≥28px (AC1) (662ms)
  ✓ tv.spec.ts:116        › fullscreen affordance enters and hides (AC2) (572ms)
  ✓ tv.spec.ts:169        › chrome auto-hides and cursor goes with it (5.1s)
```

These match the dev report and App Tester verbatim.

---

## Acceptance criteria — reviewer assessment

### AC1 — Type scale ≥28px @1080p; hero ≥80px/800 — PASS

Machine-verified in e2e (AC1 DOM sweep) and App Tester (`tv-hero` 84.5px/800, floor 28.8px). CSS minimum is 1.5vw = 28.8px @1920px — satisfies the floor.

Design-vs-implementation note: `tv.html` mockup specifies `1.4vw` for `.tv-label` / `.next-card .what` and `1.3vw` for `.next-card .mesa`. At 1920px those are 26.9px and 25.0px — below the AC1 floor. The implementation correctly bumped all sub-floor values to 1.5vw, resolving the mockup/AC1 conflict in the right direction. This is a correct design decision.

### AC2 — Fullscreen affordance, F key, Esc, auto-hiding chrome — PASS (stub disclosed)

Fullscreen API cannot be triggered natively in headless Chromium. The e2e stubs `Element.prototype.requestFullscreen` (not an instance, correctly patched on the prototype since `document.documentElement` doesn't exist at init-script time — a friction item the dev noted and solved). The stub contract tests our state machine, not the browser:
- Click → API called once ✓
- Affordance hides ✓
- "Esc para sair" hint appears ✓
- F key no-ops while fullscreen ✓
- Simulated Esc exit → affordance returns ✓
- F re-enters ✓

This is the correct posture for headless e2e. App Tester disclosed it honestly; the real Fullscreen API is standard and the path is exercised on actual hardware.

Auto-hide: 4.6s wait for 4000ms timer plus margin — appropriate. Playwright `expect().not.toHaveClass()` is retry-aware so the 800ms chrome-revive latency the App Tester noted is handled without flakiness.

### AC3 — Idle recruitment poster — PASS

`data-testid="tv-idle"` renders with wordmark, "Escaneia e canta! 🎤", QR placeholder, powered-by; no `#yt-player` in idle. Matches the mockup layout.

### AC4 — Auto-advance/skip unchanged — PASS

`submit-song.spec.ts` passes; `advance()` wiring in TvScreen is a behavior-identical port from the old `app/tv/page.tsx`. Code inspection confirms: same `fetchQueue` + 3s poll, same `advance()` → `api/queue/advance` POST chain.

### AC5 — POWERED_BY_FOOTER flag — PASS

`resolvePoweredByFooter` unit tests (12 assertions) pass. Resolver verified manually: `resolvePoweredByFooter(undefined)→true`, `resolvePoweredByFooter("0")→false`, `resolvePoweredByFooter("banana")→true`. Read via `process.env.POWERED_BY_FOOTER` in the server component — not `NEXT_PUBLIC_*`, so it's never baked into the bundle (correct). App Tester verified flag-off with a live server restart.

### AC6 — Wake lock, no error — PASS

Zero page errors on idle load. The `disposed` flag correctly handles the async race on unmount. `sentinel?.release()` called in cleanup. Graceful no-op where `navigator.wakeLock` is absent.

---

## Architecture: `force-dynamic` server component pattern

`app/tv/page.tsx` is a thin server component with `export const dynamic = "force-dynamic"` + `export const metadata`. This is the correct App Router pattern for reading a per-request env flag without exposing it as `NEXT_PUBLIC_`:
- The metadata export is static (title only); dynamic applies to the render. Valid combination in Next.js 15.
- Polling remains entirely in `TvScreen` ("use client") — no SSR queue fetching.
- Static rendering for `/tv` would have been meaningless (live queue changes every few seconds) so the dynamic-only trade-off is cost-free for this use case.

Build confirms: `ƒ /tv 2.58 kB 105 kB` — correct.

---

## Component quality: TvScreen state machine

**Timer cleanup:** `chromeTimerRef` cleared in both `pokeChrome` (on each call) and in the effect cleanup. No leak on unmount.

**Wake lock:** `disposed` guard handles async race if component unmounts during `wakeLock.request()`. Sentinel released in cleanup. Visibility re-acquire is correct.

**Fullscreen event listeners:** `fullscreenchange` + `webkitfullscreenchange` both registered and both removed in cleanup. F-key listener cleaned up separately.

**Mouse/pointer listeners:** `mousemove` + `pointerdown` cleaned up in effect return. Timer also cleared.

No state machine leaks found.

---

## `playwright.config.ts` — additive PORT override

Change: `const PORT = Number(process.env.PORT ?? 3040)` fed to `baseURL`, `webServer.command`, `webServer.url`, and `NODE_OPTIONS` localstorage path. Default 3040 is unchanged — running `npm run test:e2e` without a `PORT` env var is identical to the old behavior. Localstorage file is now port-scoped (`cantai-ls-${PORT}.json`) which prevents collision between parallel worktrees. This is a net improvement.

Minor: the command changed from `npm run dev` to `npx next dev -p ${PORT}`. The `npm run dev` script has `NODE_OPTIONS` baked in which is now handled by the config `env` field instead. Functionally equivalent. If `dev` ever gains additional setup steps, playwright would bypass them — noted as NIT for a future dev cycle.

---

## Security waiver assessment

TM-waived Cyber Security as N/A-by-content. **Waiver is sound.** Rationale verified:
- No new API routes (git diff confirms zero writes to `app/api/**`)
- No new user-input handling (only buttons calling existing `/api/queue/advance` POST — already covered by existing attack surface)
- `POWERED_BY_FOOTER` read server-side from env only; the client never sees the raw env value; it's a boolean prop passed to a client component
- `requestFullscreen` and `navigator.wakeLock` are browser-native APIs; no server-side attack surface
- No PII, no auth, no new secrets

**Disagreement with waiver:** None.

---

## Scope discipline

Verified via `git diff $BASE..origin/$BR --name-only` filtered against the must-not-touch list. Zero writes to:
- `app/page.tsx`
- `app/api/**`
- `lib/**`
- `packages/**`
- `app/layout.tsx`
- `app/globals.css`

All changes are inside `app/tv/`, `components/tv/`, `__tests__/tv-config.test.ts`, `e2e/tv.spec.ts`, `playwright.config.ts` (additive), `work/`, and `.claude/skills/run-app/SKILL.md` (docs). Clean.

---

## Design fidelity

| Element | Mockup (tv.html) | Implementation | Match |
|---------|-----------------|----------------|-------|
| Hero font | 4.4vw/800 | 4.4vw/800 | ✓ |
| Singer | 2.9vw/700 | 2.9vw/700 | ✓ |
| Wordmark top | 2.6vw | 2.6vw | ✓ |
| Rail number | 2.2vw/800 pink | 2.2vw/800 pink | ✓ |
| Rail who | 2vw/700 | 2vw/700 | ✓ |
| Rail what | 1.4vw muted | 1.5vw muted | Δ (AC1 floor — correct) |
| Rail mesa | 1.3vw amber | 1.5vw amber | Δ (AC1 floor — correct) |
| TOCANDO label | 1.4vw | 1.5vw | Δ (AC1 floor — correct) |
| Video:meta ratio | 1.5fr:1fr | 1.5fr:1fr | ✓ |
| Design tokens | cantai.css values | Verbatim (case-insensitive) | ✓ |
| Idle poster | Wordmark + CTA + QR + URL | ✓ | ✓ |
| Progress bar | Present in mockup | Absent (mvp-scope deferral) | Accepted |

All Δ entries are upward adjustments to honor AC1 — correct resolution.

---

## Findings

### Blocking
None.

### High
None.

### Medium
None.

### Nit

1. **Token duplication** — design tokens (`--c-*`, `--g-stage`) are declared verbatim inside `.tv {}` instead of centralized in `app/globals.css`. This is an intentional, documented parallel-safety decision (dev design decision #1). The values match `cantai.css` exactly, making a future mechanical consolidation trivial. Track as cleanup in TICKET-4 or a future polish pass. Not a blocker.

2. **`!important` in `pbMark`** — `font-size: 1.5vw !important` wins over `.idle .wordmark`'s 5vw. The comment explains the intent. Acceptable in a scoped CSS module; could be cleaner with a more specific selector (e.g. `.idle .poweredBy .pbMark`). Cosmetic.

3. **Dev report status line stale** — "awaiting App Tester gate" is no longer accurate now that the App Tester has passed. The implementation log and SHAs are current; the stale status line is a NIT per TICKET-F23 since the diff is self-explanatory.

4. **`playwright.config.ts` command change** — `npm run dev` → `npx next dev -p ${PORT}` means if the `dev` script gains additional setup steps in the future, playwright's webServer won't pick them up. At MVP stage this is negligible; noted for future awareness.

---

## Evidence relied upon

- `work/evidence/ticket-18/` — `after-tv-idle-1080p.png`, `after-tv-playing-1080p.png`, `after-tv-playing-chrome-hidden-1080p.png`, `after-tv-idle-footer-off-1080p.png`, `after-tv-playing-footer-off-1080p.png` plus all 7 `apptester-*.png` screenshots
- `work/reports/testing/TICKET-18-app-test.md` — App Tester gate report (PASS, 6/6 ACs)
- `work/reports/dev/TICKET-18-dev-report.md` — dev self-verification log
- `work/plans/TICKET-18-plan.md` — plan on branch
- Full git diff `6aafe485..origin/ticket/18-tv-fullscreen` read locally (git-local-first, TICKET-F18)
- Independent test run output (this session): 42/42 unit, 5/5 e2e, build clean

---

## Verdict

**[reviewer] APPROVE** — TICKET-18 implements all 6 ACs correctly and completely, the test suite is meaningful and passes, the architecture is idiomatic, scope discipline is clean, the security waiver is sound, and the evidence trail is complete with committed screenshots. The 4 nits are non-blocking. Ready for Tech Manager merge after this gate closes.
