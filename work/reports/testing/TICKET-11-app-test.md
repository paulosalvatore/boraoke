# App Test Report — TICKET-11: In-app Feedback Widget

- **Verdict:** PASS
- **Date:** 2026-07-06
- **Tester:** App Tester agent
- **Branch:** `ticket/11-feedback-widget`
- **Worktree:** `.worktrees/ticket-11`
- **Port:** 3011 (`FEEDBACK_ADMIN_TOKEN=dev-apptester-token-x9z npx next dev -p 3011`)
- **PR:** #11

---

## Summary

All acceptance criteria from the spec and handoff pass. The 2-tap submit flow is confirmed live. API validation, rate limiting, admin token guard, and watermark cursor all work correctly. /tv shows no widget. Unit suite is 105/105. The one e2e test failure is a test infra issue (port misconfiguration in `playwright.config.ts`), not an app defect — confirmed by running against the correct port.

---

## Test Environment

- Server: port 3011 (ticket-11 worktree), `FEEDBACK_ADMIN_TOKEN` injected at startup
- A second server on port 3040 (ticket-7 worktree) was running in parallel — this caused the playwright port-mismatch issue described below
- Node/Next.js dev mode; in-memory store (no Upstash provisioned; expected per dev report)

---

## Per-item Results

### 1. Widget presence

**PASS.**

- Patron page (`/`): FAB pill "💬 Feedback" renders in bottom-right corner. Confirmed via HTML (aria-label="Enviar feedback"), live screenshot, and accessibility snapshot.
- `/tv` route: DOM query for aria-label containing "feedback" returns NOT FOUND. Screenshot `apptester-04-tv-no-widget-desktop.png` shows the clean venue screen with no FAB. AC7 satisfied.

Evidence: `apptester-01-widget-closed-desktop.png`, `apptester-04-tv-no-widget-desktop.png`

---

### 2. ≤2-tap contract

**PASS — 2 taps confirmed.**

- Tap 1: click FAB → sheet opens with sentiment row (Amei/Curti/Meh/Odiei), optional textarea, optional category chips.
- Tap 2: click any sentiment button → POST fires immediately → confirmation "Valeu!" screen appears.
- No third tap required. Optional text and category chips are present and skippable.
- All UI copy is pt-BR: "Como tá sendo?", "Toca numa carinha pra mandar — rapidão, sem login.", "É só tocar numa carinha pra enviar.", "Sobre o quê? (opcional)".
- Confirmation copy matches spec: "Um robô supervisionado por humanos lê cada um desses. Fica de olho no changelog. 🚀"
- "Fechar" button to dismiss. Backdrop and Escape-to-close also wired (verified in FeedbackWidget source).

Evidence: `apptester-02-widget-open-desktop.png`, `apptester-03-widget-submitted-desktop.png`

---

### 3. Context auto-attach

**PASS.**

Intercepted the live POST payload from the browser:
```json
{
  "sentiment": "happy",
  "context": {
    "uuid": "5f4e6b88-03e5-4e7c-82d4-e77194ff5298",
    "route": "/",
    "role": "patron",
    "locale": "en-US"
  }
}
```

Server augmentation confirmed via admin GET:
- `context.createdAt`: server ISO 8601 timestamp (e.g. `2026-07-06T01:17:27.116Z`)
- `context.appVersion`: `"dev"` (env fallback, correct for local dev)
- `context.userAgent`: server-side header, truncated to 180 chars

The server never trusts client-supplied appVersion/userAgent/createdAt — all confirmed server-filled.

---

### 4. API behaviors

#### 4a. POST validation matrix — PASS

| Input | Expected | Actual |
|---|---|---|
| Missing sentiment | 400 | 400 `"A valid sentiment is required"` |
| Invalid sentiment ("bad") | 400 | 400 `"A valid sentiment is required"` |
| Missing context | 400 | 400 `"context is required"` |
| Invalid uuid format | 400 | 400 `"A valid context.uuid is required"` |
| Valid (sentiment="love", proper uuid) | 201 | 201 `{ok: true, id: "..."}` |

Note: sentiments are tokens ("love"/"happy"/"meh"/"angry"), not emoji. The widget maps emoji labels to tokens before sending — verified in the POST payload.

#### 4b. Rate limit 5/uuid/hour → 6th → 429 — PASS

Submitted 5 items for uuid `11111111-2222-3333-4444-555555555555` → all 201. 6th submission → 429 with pt-BR message: "Você já mandou 5 feedbacks nesta última hora — valeu demais! 🙏 Tenta de novo mais tarde."

#### 4c. GET without FEEDBACK_ADMIN_TOKEN → 401/fail-closed — PASS

Without token: `{"error":"Unauthorized"}` HTTP 401.
Wrong token: `{"error":"Unauthorized"}` HTTP 401.
When env var is not set: isAdmin() returns false — fail-closed confirmed.

#### 4d. GET with dev token — watermark cursor — PASS

Submitted two items (IDs: `0mr8j5tqk-e4beb12775da`, `0mr8j5tsg-6859a10840fe`).

`GET /api/feedback` with Bearer token → returns both items, watermark = last id.

`GET /api/feedback?since=<id1>` → returns only id2. Watermark cursor works correctly.

Time-sortable base36 ids ensure lexicographic ordering is robust.

---

### 5. Regression smoke

#### 5a. Unit suite — PASS

```
Test Suites: 5 passed, 5 total
Tests:       105 passed, 105 total
Time:        0.377s
```

All 5 suites green including the 2 new feedback suites (`feedback-store.test.ts`, `api-feedback.test.ts`).

#### 5b. E2E tests — PASS (with infra note)

Running against the correct port (3011):
```
✓ [chromium] › e2e/feedback.spec.ts:10:5 — feedback button present, submits in 2 taps (1.9s)
✓ [chromium] › e2e/submit-song.spec.ts:10:5 — patron submits song and it appears in queue (1.9s)
✓ [chromium] › e2e/feedback.spec.ts:29:5 — feedback button does NOT render on /tv (1.2s)
3 passed (3.9s)
```

**Infra issue (not an app defect):** `playwright.config.ts` hardcodes `baseURL: "http://127.0.0.1:3040"` and uses `reuseExistingServer: true`. With a ticket-7 server already running on 3040, playwright connected to the wrong branch — the test "button present" fails because ticket-7 has no feedback widget. Running with the correct base URL (3011) gives 3/3 green.

This is a dev-environment collision issue, not a code defect. Flagging for a follow-up: the playwright config should use a ticket-specific port (e.g. read from an env var like `PLAYWRIGHT_BASE_URL`).

#### 5c. Patron submit-song regression — PASS

The submit-song e2e passes. Additionally verified manually: the FAB at 390px is at bottom=828 (in a 844px viewport) while the "Join queue" button is at top=209. No overlap. The widget does not block any patron CTA.

---

### 6. Honest notes

**Widget position at 390px:** The FAB is 132px wide, fixed bottom-right. On a 390px screen this covers ~34% of the bottom bar width. It is well-clear of all patron CTAs (nickname input, Join queue button, song URL input once patron is in the flow). No functional overlap. Aesthetically the pill is prominent — acceptable for a feedback affordance.

**Focus/keyboard accessibility:** Escape-to-close is wired per dev report. The FAB has `aria-label="Enviar feedback"`. The dialog has `role="dialog"` with matching aria-label. Focus trap is not explicitly implemented — focus management on open/close is basic (not trapped inside the sheet). This is acceptable for MVP; a follow-up could add focus trap for better keyboard nav.

**No e-mail / no login / no captcha:** Confirmed. The sheet has no email field, no CAPTCHA, no auth gate.

**Confirmation does not auto-close:** The "Valeu!" screen persists until the user taps "Fechar". This is deliberate — lets the patron read the promise. No issue.

**Dev tooling noise:** Next.js DevTools "1 Issue" badge appears on mobile 390px in dev mode. Not a production concern.

**No CI:** CI billing is broken for this repo. All gates verified locally. The unit suite (105/105) and e2e suite (3/3) are the CI equivalents.

---

## Evidence Index

| File | What it shows | What it proves |
|---|---|---|
| `apptester-01-widget-closed-desktop.png` | Patron page at 1280px, FAB pill visible bottom-right | Widget mounts on patron page |
| `apptester-02-widget-open-desktop.png` | Sheet open: sentiment row, textarea, category chips, pt-BR copy | 2-tap contract, optional flows, pt-BR strings |
| `apptester-03-widget-submitted-desktop.png` | "Valeu!" confirmation with promise copy | Submission completes in 2 taps, correct pt-BR confirmation |
| `apptester-04-tv-no-widget-desktop.png` | `/tv` route — no FAB anywhere | AC7: /tv is widget-free |
| `apptester-05-widget-closed-mobile-390.png` | 390px patron page, FAB visible, no overlap with CTAs | Mobile UX, no blocking overlap |

---

## Defects

None blocking. One infra note (not an app defect):

**INFRA-1 (low):** `playwright.config.ts` hardcodes port 3040 with `reuseExistingServer: true`, causing the e2e feedback test to fail when a different-branch server occupies 3040. The ticket-11 e2e tests pass 3/3 when pointed at the correct port. Suggested fix: read `PLAYWRIGHT_BASE_URL` from env or use the ticket-specific port (3011) as the default.

---

## Friction

The Playwright MCP browser session had stale tab state during testing — after `wait_for` calls, the "Page URL" in results sometimes showed the port-3040 server instead of port-3011. This is a session isolation issue between concurrently running app servers. Screenshots were captured correctly (taken immediately after `navigate` before state drift), verified visually. A future improvement: the App Tester should close all tabs and open a fresh one for each test session.

---

## Verdict

**[app-tester] PASS** — All 5 acceptance criteria verified live. 105/105 unit tests green. 3/3 e2e tests green (against correct port). No app defects found. One low-severity playwright config infra issue noted (not blocking).
