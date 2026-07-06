# TICKET-10 App Test Report — Rotation Modes UI (Engine Integration)

- **Date:** 2026-07-06
- **PR:** #14 (paulosalvatore/cantai, branch: ticket/10-rotation-modes)
- **CI:** All checks green (Vercel deploy + build-and-test)
- **App port:** 3040 (Next.js dev, memory driver)
- **Room under test:** `bar-test-night-warm-gxk8` (created fresh after full route warmup)

## Verdict: PASS

All 9 test items pass. Engine ordering, mode persistence, cap enforcement, grace/no-show, mode-switch mid-queue, TV sync, and all regressions are verified.

---

## Setup notes

Memory-store singleton pattern followed: all API and page routes warmed up (compiled) before creating the test room to ensure a single module-cache instance across all route handlers. This is the documented "warm up all routes BEFORE seeding" pattern.

---

## Test Results

### 1. Mode switcher UI — PASS

Admin page shows 3 mode cards:
- 🎤 Karaokê completo — "Todo mundo entra na fila, ordem de chegada."
- 🍻 2 por mesa — "No máximo 2 músicas na fila por mesa; a mesa volta quando tocar."
- 🙋 1 por pessoa — "Cada pessoa mantém 1 música na fila; rodízio justo por identidade."

Switching persists: switched to `per-table-2`, then to `per-person-1`, then reloaded the admin page — `per-person-1` with ATIVO chip still shown. `GET /api/rooms?id=...` confirms `settings.mode` is updated. Mode switch hits `/api/host/mode` which returns `{"ok":true,"mode":"..."}` — telemetry `host_action` fires (beacon, not asserting storage per instructions).

Evidence: `apptester-01-admin-mode-switcher-3modes.png`, `apptester-02-mode-pertable-ativo.png`

### 2. Full-karaoke round-robin — PASS

Patron A (uuid `aaaa`) submitted 3 songs, Patron B (uuid `bbbb`) submitted 1.

Observed queue order: A-Song1(aaaa) → B-Song1(bbbb) → A-Song2(aaaa) → A-Song3(aaaa)

This is A,B,A,A — correct round-robin, NOT FIFO (A,A,A,B). Patron page shows correct position labels (▶, 2, 3, 4) with mode hint "🎤 Karaokê completo".

Evidence: `apptester-03-patron-roundrobin-AB-AA.png`

### 3. PER-TABLE-2 cap and alternation — PASS

Two patrons at table 1, one at table 2. Table 1 submitted 3 entries; Table 2 submitted 1 entry.

Queue order: T1A-Song1(t=1) → T2A-Song1(t=2) → T1A-Song2(t=1) → T1B-Song1(t=1)

Tables alternate. Then tested cap=4 per A2: table 1 submitted a 4th entry (accepted), 5th entry rejected with "Sua mesa já tem 4 músicas na fila — espere uma tocar." (reason: "cap"). This matches the A2 spec: cap=4 (quota + one round of lookahead). Entry count stayed at 5 (4 for table 1 + 1 for table 2).

### 4. PER-PERSON-1 cap=2 and round-robin — PASS

Patron 1 (uuid `1111`) submitted 3 songs: first 2 accepted, 3rd rejected with "Você já tem 2 músicas na fila — espere uma tocar para adicionar outra." (reason: "cap").

Patrons 2 and 3 submitted 1 each. Observed order: P1-Song1(1111) → P2-Song1(2222) → P3-Song1(3333) → P1-Song2(1111)

Round-robin by uuid confirmed.

### 5. Listen/dance entries — PASS

Submitted 2 sing entries first, then 1 listen entry. Queue order:
1: S1-Sing (mode=sing)
2: S2-Sing (mode=sing)
3: L1-Listen (mode=listen-dance)

Listen entry is correctly pushed to end of queue while sing entries are pending. Spec A3 policy (`maxConsecutiveListen: 0`) confirmed: listen only when no sing pending. Listen mode shown as "Dance" on patron page.

Also tested: submitting listen BEFORE sing entries — listen becomes now-playing (pinned at 0), sing is next. This is correct: the pinned now-playing is not displaced by the fairness engine.

### 6. MODE SWITCH MID-QUEUE — PASS

Seeded 5 entries (4 sing + 1 listen) in full-karaoke mode. Switched to per-table-2. Switched back to full-karaoke.

BEFORE count: 5
AFTER count: 5
ZERO entries lost across both switches. Queue reordered per new mode. Mode switch result: `{"ok":true,"mode":"per-table-2"}`.

Evidence: `apptester-09-midqueue-before-switch.png`, `apptester-10-midqueue-after-switch.png`

### 7. Grace/no-show — PASS

Tested via "🙅 Não veio" button on admin page: S1-Sing (now-playing) was re-queued with `graceRequeue=true`, moved to position 2 (behind the new now-playing S2-Sing). This confirms the A4 grace requeue = front-of-next-round-slot.

Also tested via `POST /api/host/skip?room=... {"grace":true}` directly — returns `{"ok":true,"grace":true,"nowPlaying":{...}}` with the grace entry. `graceRequeue=true` is set on the re-queued entry and visible in GET /api/queue response.

Evidence: `apptester-05-admin-noshow-grace-requeue.png`

### 8. /tv reflects engine ordering — PASS

TV page at `/bar-test-night-warm-gxk8/tv` showed:
- "Tocando agora": S1-Sing (SS1) — matches API items[0]
- "A SEGUIR": S2-Sing (2), A-Song3 (3), B-Song1 (4) — matches API items[1..3]
- 30s "🎤 SS1 — vá para o microfone!" countdown active (graceRequeue entry triggers no-show mic call)

TV ordering matches `GET /api/queue` order exactly.

Evidence: `apptester-06-tv-engine-order-mic-call.png`

### 9. Regressions — PASS

- **Submit flow**: Patron page submit form renders correctly; "Add to queue" disabled until a valid video ID is provided.
- **Search degraded mode**: Typing in search box triggers `data-testid="search-degraded"` notice: "Busca indisponível — cola o link do YouTube" (expected in local dev without YouTube API key).
- **Feedback widget**: FAB opens dialog with emoji sentiment buttons + category tags. Widget present on all pages.
- **Host controls**: Pause, skip, no-show, remove all render; remove confirmed working; skip/grace confirmed working. Admin queue shows positions and patron nicknames correctly.
- **Unit suite**: `STORE_DRIVER=memory npx jest __tests__` → **22 suites, 308 tests PASS**.
- **Engine tests**: `node --test` in `packages/rotation-engine` → **59 pass / 0 fail**.
- **Rotation adapter tests**: `rotation-adapter.test.ts` → **12/12 pass** (AC1–AC8 covered).

---

## Evidence Index

| File | What it proves |
|------|----------------|
| `apptester-01-admin-mode-switcher-3modes.png` | 3 mode cards visible with pt-BR labels and ATIVO chip on full-karaoke |
| `apptester-02-mode-pertable-ativo.png` | Mode switched to per-table-2; ATIVO chip moved |
| `apptester-03-patron-roundrobin-AB-AA.png` | Patron page showing round-robin order A,B,A,A with mode hint |
| `apptester-04-admin-queue-5-entries-per-table-mode.png` | Admin queue with 5 entries + listen "só curtir" badge in per-table-2 mode |
| `apptester-05-admin-noshow-grace-requeue.png` | Admin queue after no-show: S1 re-queued at position 2 with graceRequeue |
| `apptester-06-tv-engine-order-mic-call.png` | TV showing engine-ordered up-next + 30s no-show mic call countdown |
| `apptester-07-patron-page-mode-hint-queue.png` | Patron page mode hint "Modo: 🍻 2 por mesa" + queue positions |
| `apptester-08-patron-feedback-widget.png` | Feedback widget dialog open with emoji buttons |
| `apptester-09-midqueue-before-switch.png` | Queue (5 entries) before mode switch |
| `apptester-10-midqueue-after-switch.png` | Queue (5 entries) after mode switch — zero lost |

---

## Defects

None found.

## Friction

The memory-store singleton reset on first-compile-per-route in `next dev` required a warmup-before-seeding pattern. This is a documented known issue. The warmup must include both API routes AND page routes via Playwright navigation to ensure all modules share the same process-level singleton. Creating rooms before the `/[room]/admin` page compiled caused the admin route to boot a fresh `roomBackend` instance with no rooms.

A follow-up mitigation could be a startup script that warms all routes, but this is a local-dev-only issue and not blocking.

