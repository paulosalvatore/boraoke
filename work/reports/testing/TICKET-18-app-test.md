# TICKET-18 — App Tester Gate Report: TV mode — bigger type + fullscreen

- **Date:** 2026-07-06 · **Role:** App Tester · **Branch:** `ticket/18-tv-fullscreen` · **PR:** #9 · **Worktree:** `.worktrees/ticket-18`
- **Server port:** 3018 (default; 3019 for footer-off env test)
- **Viewport:** 1920×1080 (TV target)
- **Verdict:** PASS

## D-011 Verdict

**[app-tester] PASS** — all 6 acceptance criteria verified; e2e 5/5 green; unit 42/42 green; CI green (Vercel pass); no regressions on patron page or mobile crash check. One minor UX note logged below.

---

## Test scope

Tested against the Testing Handoff in the dev report and the acceptance criteria in TICKET-18:

1. Idle state at 1080p — join CTA/QR poster, 10-foot readability, palette
2. Playing state — hero scale, up-next rail, singer/table, powered-by footer
3. Fullscreen — stubbed contract (headless limitation, honestly disclosed); chrome/cursor auto-hide; F-key shortcut; Pular reachable inside auto-hiding chrome
4. POWERED_BY_FOOTER env flag — default ON; POWERED_BY_FOOTER=0 hides byline without rebuild
5. Regression: patron page smoke, existing e2e 5/5
6. Mobile 390px — confirm no crash

---

## Results per acceptance criterion

### AC1 — Type scale ≥28px at 1080p; hero ≥80px/800 weight — PASS

Machine-verified via DOM font-size sweep and targeted hero measurement:

- `tv-root` minimum rendered font: **28.8px** (1.5vw at 1920px — floor is exactly the CSS minimum) — meets ≥28px requirement
- `tv-hero` computed: **84.5px / weight 800** — meets ≥80px/800 claim
- Idle wordmark: 96.0px; idle CTA "Escaneia e canta!": 84.5px
- Also validated by e2e test 3 (AC1 sweep) which independently asserts the same DOM walk

Evidence: `apptester-01-idle-1080p.png`, `apptester-02-playing-1080p.png`

### AC2 — Fullscreen affordance, F key, Esc exit, auto-hide chrome — PASS (with honest disclosure)

**Fullscreen API contract** (stubbed — headless chromium limitation):
Fullscreen in headless Chromium cannot be exercised natively — no user-gesture context. The dev used a `requestFullscreen` prototype stub (same as the Playwright e2e). The App Tester independently replicated the stub contract:

- `requestFullscreen` called exactly once on button click: PASS
- Affordance hides after entering fullscreen: PASS
- "Esc para sair" hint appears: PASS
- F key no-op while already fullscreen: PASS
- Affordance returns after simulated Esc exit: PASS
- F key re-enters fullscreen (call count 2): PASS

**Auto-hide chrome + cursor**:
- Chrome visible on load/activity: PASS
- `chromeHidden` CSS class applied after 4.6s idle: PASS (class: `tv_chrome__QCEHp tv_chromeHidden__hKPzw`)
- `cursor: none` on tv-root when chrome hidden: PASS
- Chrome revives on mouse move (800ms wait): PASS — initial test script used 200ms wait and reported FAIL; the revive does work, Playwright's retry in the e2e correctly masks the sub-500ms delay; this is not a defect

**Pular (skip) reachable inside auto-hiding chrome**: PASS — `tv-skip` button is part of the `tv-chrome` container and inherits the hide/show cycle; confirmed visible before hide.

Evidence: `apptester-03-fullscreen-stub.png`, `apptester-04-chrome-autohide.png`

### AC3 — Idle state matches mockup — PASS

- `data-testid="tv-idle"` visible: PASS
- "Escaneia e canta! 🎤" CTA: PASS
- No dead video panel (`#yt-player` count = 0): PASS
- Powered-by footer present in idle (default ON): PASS
- QR placeholder rendered (aria-label="QR code (placeholder)"): verified via snapshot

Evidence: `apptester-01-idle-1080p.png`

### AC4 — Auto-advance and skip behavior unchanged — PASS

- Regression e2e test 1 (submit-song.spec.ts) passes: PASS
- Pular button wired to `advance()` via `onClick`: confirmed in code; API chain unchanged from main (dev notes: YT IFrame / 3s-poll / auto-advance logic ported behavior-identically)

### AC5 — POWERED_BY_FOOTER flag — PASS

- Default server (PORT 3018, no env override): powered-by present — PASS
- Second server started with `POWERED_BY_FOOTER=0` (PORT 3019, same worktree): `data-testid="tv-powered-by"` count = **0** — PASS
- No rebuild required: the second server was started from the same built code; env is read per-request via `force-dynamic` — the claim holds

Evidence: `apptester-06-footer-off.png`

### AC6 — Wake lock: no error thrown — PASS

- Zero page errors on `/tv` load (idle state) including wake lock acquisition path: PASS
- Wake lock is a progressive enhancement; headless Chromium does not expose the API — the try/catch swallows gracefully without throwing, consistent with the code's `if (!wakeLock?.request) return` guard
- E2e test 2 (idle state/AC6) also asserts zero page errors

---

## Regression checks

### Patron page (`/`) smoke — PASS

- Title: "Cantai — Karaoke Queue": PASS
- No crash: PASS
- No page errors: PASS
- Content >50 chars: PASS

Evidence: `apptester-05-patron-page-smoke.png`

### E2E suite 5/5 — PASS

```
✓ e2e/submit-song.spec.ts:10:5 › patron submits a song and it appears in the queue (1.5s)
✓ e2e/tv.spec.ts:46:7 › /tv › idle state renders the recruitment poster without errors (AC3, AC6) (2.4s)
✓ e2e/tv.spec.ts:64:7 › /tv › playing state: hero scale, max-3 rail, nothing under 28px (AC1) (609ms)
✓ e2e/tv.spec.ts:116:7 › /tv › fullscreen affordance enters fullscreen and hides after (AC2) (556ms)
✓ e2e/tv.spec.ts:169:7 › /tv › chrome auto-hides and the cursor goes with it (5.1s)
5 passed (13.1s)
```

### Unit tests 42/42 — PASS

```
PASS __tests__/api-queue.test.ts
PASS __tests__/youtube.test.ts
PASS __tests__/queue.test.ts
PASS __tests__/tv-config.test.ts
Test Suites: 4 passed, 4 total / Tests: 42 passed, 42 total
```

### Mobile 390px no-crash — PASS

- `/tv` loads at 390px: PASS
- No page errors: PASS
- Font sizes at 390px are small (min ~5.8px) — expected and noted: the page is vw-scaled and explicitly TV-only (390px is not a supported viewport per the ticket). This is a documentation note, not a defect.

Evidence: `apptester-07-mobile-390px.png`

---

## CI

```
Vercel          pass   https://vercel.com/paulosalvatores-projects/cantai/5P1bQswtUVFaQMQvBbiTZDqHc2p8   Deployment has completed
Vercel Preview Comments   pass   https://vercel.com/github
```

GitHub Actions CI is billing-broken house-wide (pre-existing, known). Required checks are the Vercel deploys — both pass.

---

## Design vs mockup — honest notes

1. **Progress bar absent** — the mockup (`work/design/mockups/tv.html`) shows a thin progress bar under the playing panel. The dev intentionally omitted it (design decision #3 in the dev report: "progress sync is explicitly deferred by mvp-scope; a fake static bar would lie to the room"). This is an accepted deviation, not a defect.
2. **"Vídeo indisponível" in the player panel** — the seeded test video (`dQw4w9WgXcQ`) refuses embedding in the dev environment. This is environmental; the layout panel renders correctly and the iframe occupies the correct 1.5fr slot. Not a layout defect.
3. **pt-BR consistency** — all visible text checked: "Tocando agora", "A SEGUIR", "Escaneia e canta!", "Tela cheia (F)", "Esc para sair", "Pular ⏭", "Mesa N", "powered by cantai", "noite de karaokê" — all pt-BR or Portuguese, consistent and correct.
4. **Palco-de-bar palette** — dark bg (#0d0a14), pink/amber gradient wordmark, amber label, muted purple text — matches the design system tokens verbatim (dev scoped in CSS module using TICKET-4 token values). Verified visually in screenshots.

---

## Evidence index

| File | What it proves |
|------|----------------|
| `apptester-01-idle-1080p.png` | Idle recruitment poster at 1080p: wordmark, CTA, QR placeholder, powered-by, fullscreen affordance, no video panel |
| `apptester-02-playing-1080p.png` | Playing state: hero "Garota de Ipanema" at 84.5px, singer+table, up-next rail (3 cards), chrome visible |
| `apptester-03-fullscreen-stub.png` | Fullscreen state: affordance hidden, "Esc para sair" hint visible |
| `apptester-04-chrome-autohide.png` | Chrome in hidden state: chromeHidden class applied, cursor none |
| `apptester-05-patron-page-smoke.png` | Patron page `/` untouched, no regressions |
| `apptester-06-footer-off.png` | POWERED_BY_FOOTER=0: idle poster renders with no powered-by element |
| `apptester-07-mobile-390px.png` | /tv at 390px — no crash, page loads |

---

## Friction

- Playwright MCP browser cannot write screenshots outside the framework repo root (`/agentic-software-house`) — used plain Playwright Node.js script in the product worktree instead. Consistent with the `capture.mjs` pattern the dev established.
- Chrome-revive check requires ≥500ms wait after `page.mouse.move()` for the state update to propagate; the Playwright e2e uses the retry-aware `expect().not.toHaveClass()` which masks this; bare `.getAttribute()` calls need explicit waits.
