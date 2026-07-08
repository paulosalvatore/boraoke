# TICKET-40 — App Test Report

**Verdict: PASS** (re-test after BUG-01 fix, commit 3b5b861 — see "Re-test" section at the end; the original FAIL run is preserved below for the record)
**Date:** 2026-07-08 (initial run + same-day re-test)
**Branch:** ticket/40-search-ux
**Worktree:** .worktrees/ticket-40
**PR:** #21 (paulosalvatore/boraoke)
**Port:** 3040 (npm run dev PORT=3040)

---

## CI / Actions State

GitHub Actions: **Vercel PASS** (Deployment completed). No red CI blocking the gate.

All four local CI gates (reproducing ci.yml):

| Gate | Result |
|---|---|
| `npm test` (Jest unit) | 369 passed / 369 total, 25 suites |
| `npm run build` (lint + typecheck + compile) | Green |
| `node --test` (packages/rotation-engine) | 59 passed / 0 failed |
| `PORT=3040 npx playwright test` (e2e) | 30 passed |

---

## Test Items — Results

### 1. SING mode search — karaoke keyword + CTA focus

| Check | Verdict | Detail |
|---|---|---|
| 1a — Network query has " karaoke" appended | PASS | Query sent: `"evidencias karaoke"` (network-level intercept confirmed) |
| 1b — CTA focused after select (no auto-submit) | PASS | `document.activeElement` is the "Add to queue" button |
| 1c — No auto-submit | PASS | No success toast present immediately after selection |
| 1d — CTA ergonomics (above keyboard fold) | PASS | CTA bbox y=481, h=42 — bottom at 523px, below simulated keyboard fold at 544px — comfortable reach above the keyboard |
| 1e — Submit works | PASS | Success toast appears after patron presses CTA |

Evidence: `apptester-01-sing-results-390px.png`, `apptester-02-cta-focused-390px.png`

### 2. LISTEN/DANCE mode — raw query, no karaoke keyword, CTA jump

| Check | Verdict | Detail |
|---|---|---|
| 2a — Network query is RAW (no karaoke) after mode switch | PASS | Query sent: `"evidencias"` after switching to listen-dance |
| 2b — Results still show after mode switch | PASS | Results visible (search re-ran) |
| 2c — CTA focus jump works in listen mode | PASS | CTA focused after picking a result in listen mode |

Evidence: `apptester-03-listen-raw-results-390px.png`

### 3. No double-keyword — query already containing "karaoke"

| Check | Verdict | Detail |
|---|---|---|
| 3 — No double "karaoke" | PASS | Query "Karaoke songs" → sent as `"Karaoke songs"` (1 occurrence, not doubled); whole-word case-insensitive check working |

### 4. Paste-link path (degraded + normal)

| Check | Verdict | Detail |
|---|---|---|
| 4a — Degraded mode: pasted link resolves | PASS | `Selected: dQw4w9WgXcQ` appears after paste in degraded mode |
| **4b — Degraded mode: CTA gets focus after paste resolve** | **FAIL** | CTA does NOT receive focus after paste resolve in degraded mode. INPUT retains focus. Root cause identified — see Defect below. |
| 4c — Paste URL never sent to /api/search | PASS | URL resolved locally; no karaoke-augmented URL query sent |
| 4d — Normal mode paste: no karaoke keyword on URL | PASS | URL resolved locally, no keyword augmentation |
| 4e — Normal mode paste: CTA gets focus | PASS | CTA focused after paste resolve in normal (non-degraded) mode |

Evidence: `apptester-04-degraded-paste-cta-390px.png`, `apptester-05-normal-paste-cta-390px.png`

### 5. Keyboard/mobile ergonomics judgment (390x844)

**PASS — CTA is visible above the keyboard fold.**

CTA measurement after scroll (390x844 viewport):
- CTA bounding box: y=438, height=42, bottom=480 (with page scrolled)
- Simulated keyboard fold estimate: 544px (844 - ~300px typical mobile keyboard)
- CTA bottom (480px) is comfortably above the fold
- `scrollIntoView({ block: "center" })` correctly centers the CTA in the visible area
- The TL's friction complaint (CTA below fold) is resolved for the search-pick path

**Caveat:** The measurement is in a headless browser without a real software keyboard. Real-world keyboards may push the viewport differently depending on browser behavior. However, the implementation uses `block:"center"` which centers the CTA in whatever visible area remains — this is the correct approach for handling variable keyboard heights.

Evidence: `apptester-06-ergonomics-full-390px.png` (full page), `apptester-07-ergonomics-viewport-390px.png` (viewport only)

### 6. Regression: full test suites

| Suite | Result |
|---|---|
| Jest unit (369 tests, 25 suites) | PASS — 369/369 |
| rotation-engine node --test (59 tests) | PASS — 59/59 |
| Playwright e2e (30 tests) | PASS — 30/30 |
| TV smoke | PASS (included in e2e — tv.spec.ts 4 tests) |
| Admin smoke | PASS (included in e2e — host-controls.spec.ts 2 tests) |

---

## Defect: TICKET-40-BUG-01 — CTA focus skipped in degraded paste path

**Severity:** Medium (UX regression in degraded mode specifically; primary flows unaffected)
**Steps to reproduce:**
1. Join a room as a patron
2. Type a free-text query (≥3 chars) — this triggers the search and sets degraded=true when quota is exhausted
3. Clear and paste a YouTube URL into the same input field
4. Observe: `Selected: dQw4w9WgXcQ` appears (link resolves correctly), but the ADD TO QUEUE button does NOT receive focus — the INPUT retains focus

**Expected:** CTA scrolls into view and receives focus (same as non-degraded pick path)
**Actual:** INPUT retains focus; patron must still scroll/tap to find the CTA

**Root cause analysis:**
The defect is a React state-update race in `PatronRoom.tsx`. In `SongSearch.tsx` (useEffect, line 132), `onSongChosen?.()` fires synchronously alongside `onSelect({videoId})`. In the parent:
1. `handleSelect` → `setParsedVideoId(videoId)` — React state update (async, schedules re-render)
2. `handleSongChosen` → `requestAnimationFrame(fn)` — schedules callback after next paint

The rAF fires after one paint. If React's state update (parsedVideoId → non-null → button `disabled` removed) hasn't been processed by that first paint, the button is still `disabled` when `btn.focus()` runs, and `focus()` on a `disabled` element is silently rejected.

In the **result-pick path** (non-degraded), the rAF fires after the same mechanism, but the button appears to be enabled already because the e2e test shows it works. This may be due to subtle timing differences (the result list was visible, the button was already mounted and enabled in a prior render). In the degraded paste path, the button transitions from `disabled` to `enabled` in the SAME render triggered by `setParsedVideoId`, and the rAF races this render.

**Fix suggestion:** Double-rAF or `setTimeout(fn, 0)` inside `handleSongChosen` to ensure at least one additional React render cycle has committed before attempting focus. Or better: use a `useEffect` in PatronRoom watching `parsedVideoId` to trigger focus once the button is actually enabled, rather than relying on `onSongChosen` callback timing.

This is not auto-fixed by the App Tester; returning to Dev for fix.

---

## Evidence Index

| File | What it proves |
|---|---|
| `apptester-01-sing-results-390px.png` | Sing mode: search results visible at 390px with karaoke-augmented query in flight |
| `apptester-02-cta-focused-390px.png` | CTA focused after selecting a result — no auto-submit, focus ring on "Add to queue" |
| `apptester-03-listen-raw-results-390px.png` | Listen/dance mode: results from raw query after mode switch |
| `apptester-04-degraded-paste-cta-390px.png` | Degraded mode: paste resolves (Selected shown), but CTA focus defect visible (INPUT focused) |
| `apptester-05-normal-paste-cta-390px.png` | Normal mode: paste resolves correctly, CTA gains focus |
| `apptester-06-ergonomics-full-390px.png` | Full-page view: CTA positioned above simulated keyboard fold after scroll |
| `apptester-07-ergonomics-viewport-390px.png` | Viewport-only view: what patron sees at 390x844 after CTA jump |

---

## Friction

- MCP Playwright browser was locked by another session; fell back to the dev-provided capture script + a custom apptester script (Playwright API directly). Sanctioned fallback per agent instructions.
- The MCP browser locking issue should be filed as a framework friction item.

---

## Summary

**13 PASS, 1 FAIL, 0 WARN**

The primary happy paths work correctly: sing-mode karaoke keyword is appended at the network level, listen-mode searches raw, no double-keyword, select→CTA jump works, ergonomics are solid at 390px (CTA above keyboard fold). All 30 e2e tests, 369 unit tests, 59 rotation-engine tests pass.

One defect found in the **degraded paste path only**: CTA focus is not transferred after pasting a YouTube link when the search was previously in degraded state. The link resolves correctly and the patron CAN still submit — they just have to tap/scroll to the CTA. Severity is Medium (UX friction in an edge-case path, not a data loss or crash).

**Verdict: FAIL** — returning to Dev for the degraded-paste focus fix before merge.

---

## Re-test — BUG-01 fix (commit 3b5b861)

The Dev fixed TICKET-40-BUG-01 by removing the `onSongChosen` callback entirely and driving the jump-to-CTA from a `useEffect` in `PatronRoom` watching `parsedVideoId` — effects run after React commits, so the CTA is already enabled when `.focus()` fires; a null guard skips selection-clear/post-submit resets. One mechanism for both selection paths.

**Re-test verdict: PASS** — all 4 targeted re-tests + full suites green.

| Check | Verdict | Detail |
|---|---|---|
| 4b — Degraded paste → CTA enabled + focused (the failed item) | PASS | CTA `enabled=true, focused=true` after paste-resolve in degraded mode |
| 1b — Result pick → CTA focused, no auto-submit (mechanism changed, sanity) | PASS | focused=true, no toast |
| 4e — Normal-mode paste → CTA focused (sanity) | PASS | focused=true |
| Post-submit reset → no uninvited focus jump | PASS | After submit, `parsedVideoId` resets to null; CTA disabled; activeElement is BODY — the effect's null-guard prevents a re-focus/scroll jump |

**Regression after fix:**
- Playwright e2e: **30/30 passed** (degraded e2e now asserts `toBeEnabled` AND `toBeFocused` after paste-resolve — regression coverage for the gap)
- Jest unit: **369/369 passed**

**Re-test evidence:**
| File | What it proves |
|---|---|
| `apptester-retest-4b-degraded-paste-cta-focused-390px.png` | Degraded paste: CTA now enabled + focused (BUG-01 fixed) |
| `apptester-retest-1b-pick-cta-focused-390px.png` | Result-pick path unregressed under the new effect mechanism |

**Actions / mergeability state:** PR #21 reports `mergeable: CONFLICTING` / `mergeStateStatus: DIRTY` — this is the known CI-suppression cause: the GitHub Actions `ci.yml` runs do not surface on the PR (only Vercel checks show, both green). The branch needs a rebase/merge from main before the Actions checks will run and the PR can merge. All four ci.yml gates were reproduced green locally in their place.

**Final verdict: PASS** — app-level gate cleared; the CONFLICTING mergeability is a branch-hygiene item for the Dev/TM (rebase onto main), not an app defect.
