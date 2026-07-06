# TICKET-18 — Plan: TV mode, bigger type + fullscreen

- **Date:** 2026-07-05 · **Author:** Dev (fable-tier) · **Branch:** `ticket/18-tv-fullscreen` · **Worktree:** `.worktrees/ticket-18` · **Port:** 3018
- **Status:** Executing under the TM launch mandate (wave-1 parallel fan-out; scope pre-approved per the ticket file — recorded here for the plan-gate record).

## Approach

Rebuild `/tv` to the ratified design system (`work/design/mockups/tv.html` is the reference), splitting the page into a thin server component (reads the footer flag from env at request time — "no rebuild" requirement from the monetization spec) and a client `TvScreen` that keeps the existing player/poll/auto-advance logic byte-compatible in behavior.

1. **`app/tv/page.tsx`** → server component, `force-dynamic`, reads `POWERED_BY_FOOTER` via a pure resolver and passes `poweredByFooter` to the client screen.
2. **`components/tv/TvScreen.tsx`** (new, client) — all existing YT IFrame / polling / advance logic ported unchanged; new layout per mockup: top bar (gradient wordmark + "noite de karaokê") · main row (video 1.5fr : meta 1fr — amber "TOCANDO AGORA", `tv-hero` 4.4vw/800 title, 2.9vw singer + mesa) · bottom rail ("A SEGUIR" + max 3 next-cards + join/QR card). Idle state = recruitment poster (wordmark, huge "Escaneia e canta! 🎤", QR placeholder, join URL). Progress bar omitted (progress sync explicitly deferred by mvp-scope; no fake data).
3. **`components/tv/tv.module.css`** (new) — all TV styles, `vw`-scaled, with the design tokens (`--c-*`, `--g-stage`) declared **scoped on the TV root class** so nothing leaks into the shared `app/globals.css` (zero collision surface with wave-1 parallel tickets). Nothing under ~28px @1080p (min font 1.46vw).
4. **Fullscreen** — a subtle "Tela cheia (F)" affordance in an auto-hiding chrome bar + `F` keypress; `requestFullscreen` on the document element (webkit fallback; affordance not rendered where the API is missing). Hidden once fullscreen; `Esc` exits natively; affordance re-shows after reload (platform limit, accepted by the ticket).
5. **Auto-hide chrome + cursor** — chrome (fullscreen + skip buttons) visible on load and on mouse movement, hides after ~4s idle; cursor hidden whenever chrome is hidden. Design call: the mockup says "zero interactivity", but the current TV carries the venue's only skip control until TICKET-7 (host controls) ships — so skip survives *inside* the auto-hiding chrome (passive screen when untouched, operational when the host walks up). AC4 (skip behavior unchanged) satisfied.
6. **Wake lock** — `navigator.wakeLock.request("screen")` on mount, re-acquire on `visibilitychange`, release on unmount; everything try/caught (AC6 graceful degradation).
7. **`components/tv/config.ts`** — `resolvePoweredByFooter(raw)`: default **on**; only explicit `0/false/off/no` disables. Flag off hides the join/QR "powered by cantai" footer card in the playing rail and the powered-by byline on the idle poster (the idle join CTA itself stays — it's the venue's recruitment poster, core product, not branding).

## Files touched (ownership check — all inside TICKET-18's lane)

- `app/tv/page.tsx` (rewrite), `components/tv/TvScreen.tsx` + `components/tv/config.ts` + `components/tv/tv.module.css` (new)
- `__tests__/tv-config.test.ts` (new unit), `e2e/tv.spec.ts` (new e2e)
- `playwright.config.ts` — minimal additive change: honor `PORT` env (default 3040 unchanged) so parallel wave-1 agents can run e2e without port clashes. Not on the must-not-touch list; flagged here for the reviewer.
- `work/evidence/ticket-18/**`, `work/plans/TICKET-18-plan.md`, `work/reports/dev/TICKET-18-dev-report.md`
- NOT touched: `app/page.tsx`, `app/api/**`, `lib/**`, `packages/**`, `app/layout.tsx`, `app/globals.css`

## Risks

- YT IFrame API in e2e/headless: keep e2e assertions on layout/DOM, never on playback (same posture as the existing suite).
- Fullscreen in headless Chromium is flaky → e2e stubs `requestFullscreen`/`fullscreenElement` via init script and asserts the call + hide-after-enter behavior.
- Shared `playwright.config.ts` edit could collide with TICKET-8 — change is 3 lines, additive, default-preserving.

## Test strategy

- Unit: flag resolver truth table (default on, off variants, whitespace).
- e2e (`e2e/tv.spec.ts`, 1920×1080 viewport): idle poster renders (+ no page errors → AC6); playing layout: hero title at hero scale (≥80px @1920), rail caps at 3, powered-by footer visible by default; a font-size sweep asserting no rendered text on `/tv` under 28px (AC1); fullscreen affordance calls the API on click and on `F`, hides after entering (AC2).
- Existing `submit-song.spec.ts` must stay green (AC4 regression).
- Local verification on PORT=3018; build + jest + playwright. CI is billing-broken (known) — local verbatim output recorded in the dev report per the S1 contract.

## Evidence

Before (origin/main state) + after screenshots at 1920×1080 into `work/evidence/ticket-18/` via plain-Playwright script (capture-screenshots conventions; MCP profile may be locked by parallel agents).
