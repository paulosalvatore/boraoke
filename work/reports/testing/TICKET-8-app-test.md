# TICKET-8 — App Test Report: In-app YouTube Search

- **Product:** cantai · **Ticket:** TICKET-8 · **Role:** App Tester
- **Branch:** `ticket/8-youtube-search` · **Worktree:** `.worktrees/ticket-8`
- **Date:** 2026-07-06
- **Verdict:** PASS

---

## Environment

- App port: 3040 (dev server, `npm run dev`)
- No `YOUTUBE_API_KEY` provisioned — degraded mode is the primary test path
- CI: Vercel pass (deployment completed)
- Unit tests: 71/71 passed (`npm test`)
- E2E tests: 3/3 passed (`npx playwright test`)

---

## What Was Tested

All items from the Testing Handoff were exercised:

### 1. Patron Page — Unified Song Input

**Tested:** Joined as "TestUser", verified the new `SongSearch` dual-behavior input appears (label: "Buscar música ou colar link do YouTube").

- Table number field present and functional (filled "7", appeared in queue as "Table 7") ✅
- Sing/Listen toggle (Mode combobox: "🎤 Sing" / "💃 Listen / Dance") present and selectable ✅
- Live queue list renders correctly ✅

### 2. Degraded Mode — Free-text → Fallback Notice

**Tested:** Typed "evidencias karaoke" into the unified input, waited 2s for debounce to fire.

**Result:** Status element appeared with exactly the required copy: `Busca indisponível — cola o link do YouTube`. No crash. "Add to queue" button remained disabled. ✅

**Evidence:** `02-degraded-notice-free-text.png`

### 3. Degraded Mode — Paste Link Resolves Locally

**Tested:** With free text already showing the degraded notice, cleared and pasted `https://youtu.be/dQw4w9WgXcQ`.

**Result:** The UI showed "Selected: dQw4w9WgXcQ" immediately (no API call, resolved via `parseYouTubeVideoId`). "Add to queue" button became enabled. ✅

**Evidence:** `03-paste-url-resolved.png`

### 4. Submit → Appears in Queue

**Tested:** Clicked "Add to queue" after paste-resolve. Waited for success confirmation.

**Result:** "song added to the queue" toast appeared. Song (table 7, TestUser, Sing mode) showed in the live queue list. ✅

**Evidence:** `04-queue-after-submit.png`

### 5. API — Degraded Mode Contract

**Tested:** `GET /api/search?q=test&uuid=test-uuid-1`

**Result:** `200 { "degraded": true, "reason": "no-api-key", "results": [] }` — exact contract per spec. ✅

### 6. API — Rate Limiting (6th rapid request → 429)

**Tested:** 7 rapid requests from the same `uuid=rate-limit-test-uuid`.

**Result:**
- Requests 1–5: HTTP 200
- Request 6: HTTP 429
- Request 7: HTTP 429

Rate limit fires exactly on the 6th request. Response body: `{ "error": "Muitas buscas — aguarde um instante e tente de novo." }` — pt-BR, polite. ✅

### 7. Unit Tests — 71/71

```
Test Suites: 5 passed, 5 total
Tests:       71 passed, 71 total
Time:        0.343 s
```

Includes 30 new tests for TICKET-8 (24 youtube-search core, 6 api-search) plus the pre-existing 41. ✅

### 8. Playwright E2E — 3/3

```
[1/3] e2e/submit-song.spec.ts › patron submits a song and it appears in the queue — pass
[2/3] e2e/search.spec.ts › search → select a result → submit queues the picked video — pass
[3/3] e2e/search.spec.ts › degraded search shows fallback copy but paste-link still works — pass
```

Mocked search flow exercises the full search → select → submit path. Degraded e2e confirms paste-link fallback after quota-simulated response. ✅

### 9. Regression — /tv Unaffected

**Tested:** Navigated to `http://localhost:3040/tv` after submitting a song.

**Result:** /tv loaded correctly, YouTube iframe present, "Now playing" panel shows the submitted entry ("youtu.be/dQw4w9WgXcQ · TestUser · Table 7 · 🎤 Singing"). Skip button present and functional. No crashes. ✅

**Evidence:** `05-tv-page-playing.png`

### 10. Mobile Layout — 390px Width

**Tested:** Resized viewport to 390×844 (iPhone 14 dimensions). Navigated to patron page, typed free text.

**Result:** Unified input renders correctly within mobile viewport, degraded notice visible. No overflow or layout breakage observed. ✅

**Evidence:** `06-mobile-390px-patron-page.png`, `07-mobile-390px-degraded-notice.png`

### 11. Keyed Path (Mock/Unit)

No `YOUTUBE_API_KEY` provisioned — per the ticket, this is expected. The mock-based e2e test (`e2e/search.spec.ts`) exercised the full keyed path via mocked `/api/search` responses. Unit tests cover response mapping, quota error handling, and the LRU cache. No real key acquisition attempted. ✅

---

## Evidence Index

All screenshots saved to `work/evidence/ticket-8/` in the framework repo:

| File | What It Proves |
|------|----------------|
| `01-patron-page-after-join.png` | Full patron page with unified input, table/mode fields, live queue list |
| `02-degraded-notice-free-text.png` | "Busca indisponível — cola o link do YouTube" appears for free-text search without API key |
| `03-paste-url-resolved.png` | Pasted YouTube URL resolves locally to "Selected: dQw4w9WgXcQ", CTA enabled |
| `04-queue-after-submit.png` | Song appears in queue after paste-resolve submit (table, mode, nickname all correct) |
| `05-tv-page-playing.png` | /tv page loads, YouTube iframe + now-playing panel intact, no regression |
| `06-mobile-390px-patron-page.png` | Full patron page at 390px width — no layout breakage |
| `07-mobile-390px-degraded-notice.png` | Degraded notice visible at 390px mobile viewport |

---

## Defects

None. All handoff flows pass.

---

## Honest Notes (Non-blocking)

1. **Queue title fallback:** When a song is submitted via paste-link without filling in the optional title field, the queue displays the raw video ID path (e.g., "youtu.be/dQw4w9WgXcQ") as the title. This is pre-existing behavior (title is optional by design) and not a TICKET-8 regression. Consider auto-filling from the resolved video metadata as a follow-up.

2. **Console error (benign):** Every page load logs a 404 for `/favicon.ico`. Pre-existing, no action needed.

3. **pt-BR string consistency:** All user-facing strings in the search flow are in pt-BR ("Buscar música ou colar link do YouTube", "Busca indisponível — cola o link do YouTube", "Muitas buscas — aguarde um instante e tente de novo."). Consistent and correct. The queue displays "Sing" and "Listen / Dance" in English (mode labels) — these are pre-existing, outside TICKET-8 scope.

4. **Mobile layout:** Layout is functional at 390px. The unified input and degraded notice fit cleanly. No specific mobile optimizations were added in this ticket (e.g., font size, tap target padding for result rows) — acceptable for this ticket scope; note for design polish in a later wave.

---

## CI Status

```
Vercel              pass    Deployment has completed
Vercel Preview      pass
```

No required CI checks pending. Gate is clear. ✅

---

## Verdict

**PASS** — All acceptance criteria met. Degraded mode works exactly as specified (fallback copy, paste-link functional, no crash). Rate limiting fires at request 6 with pt-BR message. All 71 unit tests and 3 e2e specs pass. /tv unaffected. CI green.
