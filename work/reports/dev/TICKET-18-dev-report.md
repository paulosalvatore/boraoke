# TICKET-18 — Dev report: TV mode, bigger type + fullscreen

- **Date:** 2026-07-05 · **Role:** Dev (fable-tier) · **Branch:** `ticket/18-tv-fullscreen` · **Worktree:** `.worktrees/ticket-18` · **App port:** 3018
- **Status:** IMPLEMENTED + self-verified locally (build ✓, unit 42 ✓, e2e 5/5 ✓) — draft PR open, awaiting App Tester gate.

## Picking up from

Fresh start on the wave-1 fan-out (sole owner of `app/tv/**` per the ticket's file-ownership matrix; TICKET-6 owns `lib/store.ts` + `app/api/queue/**`, TICKET-8 owns patron search — neither touched). Executed under the TM launch mandate; plan at `work/plans/TICKET-18-plan.md`.

## What was built

- **`app/tv/page.tsx`** — rewritten as a thin server component (`force-dynamic`): resolves `POWERED_BY_FOOTER` from env at request time (monetization spec AC4: disable without rebuild) and renders the client screen.
- **`components/tv/TvScreen.tsx`** (new) — the venue screen per `work/design/mockups/tv.html`: gradient wordmark top bar, video 1.5fr : meta 1fr main row (amber "TOCANDO AGORA", 4.4vw/800 hero, 2.9vw singer + muted "· Mesa n", 🎶 marker on listen-dance), "A SEGUIR" rail capped at 3 cards, join/QR + "powered by cantai" footer card (flag-gated), idle recruitment poster (wordmark + "Escaneia e canta! 🎤" + QR placeholder + join host + flag-gated powered-by byline). Existing YT IFrame / 3s-poll / auto-advance logic ported behavior-identically.
- **Fullscreen (AC2):** "Tela cheia (F)" affordance + `F` key → `requestFullscreen` on the document element (webkit fallback; affordance not rendered if the API is missing). Hides once fullscreen (native `Esc` exits, hint shown); re-appears after reload (platform gesture limit, accepted by the ticket).
- **Auto-hide chrome + cursor:** chrome bar (skip + fullscreen) visible on load/activity, fades after 4s idle, cursor hidden with it. Design call: mockup says zero interactivity, but `/tv` carries the venue's only skip until TICKET-7 (host controls) ships — skip lives inside the auto-hiding chrome ("Pular ⏭"), so the passive screen stays clean and AC4 (skip behavior unchanged) holds.
- **Wake lock (AC6):** `navigator.wakeLock.request("screen")` on mount, re-acquired on `visibilitychange`, released on unmount, fully try/caught — no errors where unsupported (e2e asserts zero page errors).
- **`components/tv/config.ts`** — `resolvePoweredByFooter`: default ON; only explicit `0/false/off/no` disables (unknown values stay on — safe default for the growth loop).
- **`components/tv/tv.module.css`** — all TV styles; design tokens scoped on the TV root class (zero writes to shared `app/globals.css` → no wave-1 collisions). Everything vw-scaled; minimum font 1.5vw = 28.8px @1080p (AC1 floor).
- **`playwright.config.ts`** — additive `PORT` env override (default 3040 unchanged) so parallel worktrees can e2e without port clashes. Only shared file touched; flagged for the reviewer.
- **`.claude/skills/run-app/SKILL.md`** — PORT-override + `/tv` fullscreen/flag notes (run-app truthfulness rule).

## PR + commits

- **PR:** https://github.com/paulosalvatore/cantai/pull/9 (draft, base `main`)
- `3df17c7` — TICKET-18: TV mode — 10-foot restyle, fullscreen, wake lock, powered-by footer (full delivery: code + tests + evidence + plan + this report)
- CI: repo required checks are the Vercel deploys — `gh pr checks 9` verbatim:
  ```text
  Vercel	pass	0	https://vercel.com/paulosalvatores-projects/cantai/GncbkjDXDtvrimhTHciXWkT734Lg	Deployment has completed
  Vercel Preview Comments	pass	0	https://vercel.com/github
  ```
  (GitHub Actions CI is billing-broken house-wide — local verification below is the record per S1.)

## Self-verification (local; CI is billing-broken — known house issue)

- `npm run build` — ✓ compiled, `/tv` is ƒ (Dynamic) as intended:
  ```text
  └ ƒ /tv                                  2.56 kB         105 kB
  ```
- `npm test` — ✓ `Test Suites: 4 passed, 4 total / Tests: 42 passed, 42 total` (includes new `__tests__/tv-config.test.ts`, 3 tests / 12 assertions on the flag truth table).
- `PORT=3018 npm run test:e2e` — ✓ 5/5:
  ```text
  ✓  1 [chromium] › e2e/submit-song.spec.ts:10:5 › patron submits a song and it appears in the queue (2.1s)
  ✓  2 [chromium] › e2e/tv.spec.ts:46:7 › /tv › idle state renders the recruitment poster without errors (AC3, AC6) (3.0s)
  ✓  3 [chromium] › e2e/tv.spec.ts:64:7 › /tv › playing state: hero scale, max-3 rail, nothing under 28px (AC1) (744ms)
  ✓  4 [chromium] › e2e/tv.spec.ts:116:7 › /tv › fullscreen affordance enters fullscreen and hides after (AC2) (585ms)
  ✓  5 [chromium] › e2e/tv.spec.ts:169:7 › /tv › chrome auto-hides and the cursor goes with it (5.2s)
  ```
- AC1 is machine-checked in e2e: a DOM sweep asserts no rendered text node inside the TV root computes under 28px at 1920×1080, and the hero computes ≥80px/800.
- `npx tsc --noEmit` — pre-existing errors only (`__tests__/**` lacks jest types on main too); no new diagnostics in ticket files.

## Evidence (`work/evidence/ticket-18/`, 1920×1080)

- `before-tv-idle-1080p.png`, `before-tv-playing-1080p.png` — origin/main state (old English UI, small type).
- `after-tv-idle-1080p.png` — recruitment poster (AC3) + powered-by + fullscreen affordance.
- `after-tv-playing-1080p.png` — hero layout + rail + chrome visible; `after-tv-playing-chrome-hidden-1080p.png` — passive state, chrome/cursor gone.
- `after-tv-idle-footer-off-1080p.png`, `after-tv-playing-footer-off-1080p.png` — served with `POWERED_BY_FOOTER=0` (AC5).
- `capture.mjs` — the plain-Playwright capture script (capture-screenshots conventions; MCP not used — parallel-agent safety).
- Note: "Vídeo indisponível" inside the player panel is the seeded test video refusing embedding — environmental, not a layout defect; layout is identical with an embeddable video.

## Design decisions (for the record)

1. Tokens scoped in the CSS module instead of `app/globals.css` — parallel-safety beats token DRY-ness for one surface; TICKET-4's token names/values used verbatim so a later consolidation is mechanical.
2. Skip kept, but inside the auto-hiding chrome — reconciles the mockup's "zero interactivity" with the operational need for a kill switch pre-TICKET-7.
3. Progress bar omitted (mockup shows one) — progress sync is explicitly deferred by mvp-scope; a fake static bar would lie to the room.
4. Idle join info always shown; only the "powered by cantai" byline (and the playing-rail join card) is flag-gated — the idle poster is the venue's own recruitment tool, not vendor branding.
5. Footer flag read server-side per request (`force-dynamic`) — satisfies "disable without rebuild"; `NEXT_PUBLIC_*` would have baked it into the bundle.

## Friction

- YT IFrame swallows mouse events over the video area (cross-origin), so evidence-capture mouse pokes must land outside the player; noted in `capture.mjs`.
- Playwright `addInitScript` runs before `document.documentElement` exists — fullscreen stub must patch `Element.prototype.requestFullscreen`, not the instance (first e2e run failed on this; fixed).
