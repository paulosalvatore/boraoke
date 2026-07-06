# TICKET-7 App Test Report — Host Controls

- **Verdict:** PASS
- **Date:** 2026-07-06
- **Branch:** ticket/7-host-controls
- **Worktree:** .worktrees/ticket-7
- **Server:** http://localhost:3040 (pre-existing next dev on ticket-7 worktree)
- **Unit tests:** 109/109 pass (`npm test`)
- **CI:** Vercel — pass (both checks green as of test time)
- **Tester:** App Tester (App Tester agent, agentic-software-house)

---

## Summary

All acceptance criteria tested and confirmed. Auth hardening, skip, remove, reorder, pause/resume, patron-submit-while-paused, 401 enforcement, and regression smoke (patron + TV) all PASS. One known deferred item (TV player-freeze) is explicitly out of scope per ticket and dev report. One usability note filed for mobile.

---

## Environment Notes

**Memory-driver caveat (documented, not a bug):** Under `next dev` the in-memory store singleton resets on first-compilation of each route. The e2e spec handles this via `warmUp()`. For manual live testing I reproduced the same caveat (first hit of `/api/host/skip` and `/tv` reset the store) and applied the same warmup pattern (hitting all routes before seeding) for subsequent tests. This is a dev/memory-driver-only issue; production uses Upstash (durable). The route-compilation order sensitivity is noted in `## Friction`.

---

## Test Items

### 1. Login Gate (`/admin`)

**Result: PASS**

- `/admin` without a cookie shows only the login gate form — confirmed.
- Wrong token `wrong-token-xyz` → POST `/api/host/login` returns HTTP 401; UI shows "Token inválido — tente de novo." — confirmed visually.
- Correct dev token `cantai-dev-host` → HTTP 200; httpOnly cookie `cantai_host` set (HMAC-derived session value, not the raw token). Cookie not visible in `document.cookie` (confirmed via browser JS eval). No token in `localStorage` — confirmed.
- Dashboard renders after correct login: queue panel, mode-switcher placeholder, stat cards, join-link card.

**Evidence:** `01-admin-login-gate.png`, `02-wrong-token-rejected.png`, `03-host-dashboard-with-queue.png`

---

### 2. Queue Seeding via Patron Page/API

**Result: PASS**

Seeded 4 entries via `POST /api/queue` with mixed modes (sing/listen) and tables:
- Alice / Rick Roll Alpha / Mesa 1 / sing (→ nowPlaying)
- Bob / Bohemian Rhapsody / Mesa 2 / sing
- Carol / Wonderwall / no table / listen
- Dave / Dancing Queen / Mesa 3 / sing

Admin dashboard displayed all 4 entries with position markers (▶ for nowPlaying, 2/3/4 for the rest), table badges, and correct UP/DOWN disabled states (Alice ▲ disabled, Dave ▼ disabled). Stats: 4 na fila, 4 cantores, 3 mesas ativas — correct.

**Evidence:** `04-host-view-4-entries.png`

---

### 3a. Remove (Bob) — Two-Step Confirm

**Result: PASS**

- Clicking "Remover Bob" replaces the remover button inline with Confirmar/Cancelar (per-row confirm, no other rows affected) — confirmed.
- Clicking Confirmar: Bob disappears from admin view within the next poll cycle.
- Verified via `GET /api/queue`: Bob absent, Alice/Carol/Dave intact.
- Stats updated: 3 na fila, 3 cantores, 2 mesas ativas.

**Evidence:** `05-remove-confirm-dialog.png`, `06-after-remove-bob.png`

---

### 3b. Reorder (Dave up)

**Result: PASS**

Remaining order after Bob removal: Alice (▶) → Carol → Dave.

- Clicked "Subir Dave" (▲ button on Dave's row).
- `GET /api/queue` verified new order: Alice → Dave → Carol (Dave moved from index 2 to index 1).
- Admin UI refreshed and showed correct order after next poll.

**Evidence:** `07-after-reorder-dave-up.png`

---

### 3c. Skip

**Result: PASS**

Via `POST /api/host/skip` with the session cookie (route was already warm):
- Before: Alice is nowPlaying, queue = [Alice, Dave, Carol, Eve].
- After: Dave is nowPlaying, queue = [Dave, Carol, Eve]. Alice advanced out.
- `GET /api/queue` confirmed nowPlaying = Dancing Queen (Dave).

The skip button in the UI (⏭ Pular música) wires to the same `/api/host/skip` route and is present and enabled on the dashboard.

---

### 3d. Pause / Resume

**Result: PASS**

- Clicked ⏸ Pausar: header chip changed from "AO VIVO" to "⏸ Pausado". Button changed to "▶ Retomar".
- `GET /api/queue` returned `paused: true` immediately — public polling endpoint reflects paused flag.
- **Patron submit while paused:** `POST /api/queue` with a new entry ("Eve") returned HTTP 201 — accepted. Eve appeared as queue entry 4 in the admin view.
- Resume via `POST /api/host/pause {paused:false}`: `GET /api/queue` returned `paused: false`. Admin page polled and header chip reverted to "AO VIVO" within 3s.
- TV player-freeze deferred to post-#9 merge (explicitly out of scope per ticket and dev report — not a failure).

**Evidence:** `08-paused-state.png`

---

### 4. Auth Hardening

**Result: PASS**

**All 6 `/api/host/*` routes tested without cookie → HTTP 401:**
- `POST /api/host/skip` → 401
- `POST /api/host/remove` → 401
- `POST /api/host/reorder` → 401
- `POST /api/host/pause` → 401
- `GET /api/host/session` → 401
- `POST /api/host/login` (wrong token) → 401

**Unit suite (production-mode 503 when HOST_TOKEN unset):** `npm test` → 6 suites, **109/109 tests pass**. The `host-auth.test.ts` suite covers the 503/deny behavior when `HOST_TOKEN` is unset in production mode (unit-tested, verified via the suite result, not a live prod environment test as expected).

---

### 5. Patron Page + /tv Regression Smoke

**Result: PASS (with caveat noted)**

**Patron page (`/`):** Rendered correctly. Shows live queue (correct order/nowPlaying marker), song submit form functional, queue count header accurate.

**TV page (`/tv`):** Rendered correctly. Showed YouTube iframe player, "Now playing" block with correct entry (Final Test Song / TestUser / Table 5), "Up next" list. Console showed expected dev-mode noise only: favicon 404 (dev) and YouTube postMessage cross-origin warning (expected on HTTP localhost with HTTPS YouTube embed). No errors related to TICKET-7 changes.

Note: first visit to `/tv` triggered route compilation which reset the in-memory store (documented caveat). The page itself rendered without errors. For production (Upstash), this doesn't occur.

**Evidence:** `09-patron-page-regression.png`, `10-tv-page-regression.png`

---

### 6. Honest Notes

**Mobile (390px):** `11-admin-mobile-390px.png` — admin page loads and all controls are accessible at 390px. The queue panel, ▲▼ reorder buttons, Remover button, Pausar, and Pular all render and are clickable. The mode-switcher section stacks vertically and occupies significant vertical space. The ▲▼ buttons are small (single-char "▲"/"▼") which may be tight as touch targets on an actual phone; the aria-labels ("Subir Alice", "Descer Alice") are correct for accessibility but the tap area is ~24px. Not blocking — a usability improvement (wider touch target or explicit px width on the reorder buttons) could be filed as a follow-up.

**pt-BR consistency:** The admin page and all host controls are fully in pt-BR. The patron page (`/`) is in English — this is a pre-existing design choice (patron-facing is English) and is not a TICKET-7 regression.

**Reorder UX:** Button-based reorder (▲▼ per row) works correctly. The UX is functional but not as fluent as drag-and-drop for a host managing a long queue. This is by design (the ticket spec says "button reorder") — no issue.

**Playwright `button:has-text()` navigation interference:** During testing, Playwright's CSS `:has-text()` locator occasionally matched buttons on the secondary cantai instance (port 3011) and triggered a tab switch, requiring manual navigation back to port 3040. Workaround: use `[aria-label="…"]` selectors or `element.click()` via `browser_evaluate`. Filed as friction below.

---

## Evidence Index

| File | What It Shows |
|------|---------------|
| `01-admin-login-gate.png` | Login gate renders at /admin (no cookie) |
| `02-wrong-token-rejected.png` | "Token inválido" error on wrong token (no cookie set) |
| `03-host-dashboard-with-queue.png` | Dashboard after correct dev token login |
| `04-host-view-4-entries.png` | 4-entry queue: position markers, table badges, stat cards |
| `05-remove-confirm-dialog.png` | Inline two-step confirm for remove (Bob's row) |
| `06-after-remove-bob.png` | After confirm: Bob gone, Alice/Carol/Dave intact, stats updated |
| `07-after-reorder-dave-up.png` | Dave moved from position 3 → 2 (above Carol) |
| `08-paused-state.png` | Paused state: "⏸ Pausado" chip, ▶ Retomar button |
| `09-patron-page-regression.png` | Patron page showing live queue (correct order) |
| `10-tv-page-regression.png` | TV page with YouTube iframe + Now playing + Up next |
| `11-admin-mobile-390px.png` | Admin page at 390px mobile viewport |

---

## Friction

- **Memory-driver route-compilation reset:** Warmup step (hitting every route before seeding) is mandatory for live testing sessions and for e2e. The e2e spec already handles this (`warmUp()` helper). A shared test utility warming all routes (including `/tv` and `/`) would prevent accidental resets in future test suites.
- **Playwright `:has-text()` cross-tab interference:** Multiple cantai instances on adjacent ports (3040, 3011) caused Playwright text-based selectors to match buttons on the wrong tab. Using `aria-label` selectors or `evaluate().click()` was required throughout. The Playwright MCP also redirects all screenshots to the framework repo's `.playwright-mcp/` dir rather than the ticket worktree, requiring a post-session copy step (screenshots ended up in `_quarantine/` via the Stop hook). The `capture-screenshots` skill should be the canonical path for future runs.
