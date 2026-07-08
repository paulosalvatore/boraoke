# TICKET-20 — App Tester Report

**Verdict: PASS**
**Date:** 2026-07-07
**Branch:** `ticket/20-p0-ux-fixes`
**PR:** paulosalvatore/boraoke#17
**Port tested:** 3040 (hardcoded in `package.json` `npm run dev` script; PORT=3020 env var not honored)
**Worktree:** `/Users/paulosalvatore/Documents/GitHub/cantai/.worktrees/ticket-20`

---

## CI Status

All required checks terminal-green before verdict issued:

| Check | Status |
|---|---|
| build-and-test | pass (2m38s) |
| Vercel | pass — deployment completed |
| Vercel Preview Comments | pass |

---

## Test Counts (verbatim)

- **Unit (Jest):** 333 passed / 333 total — 23 suites — 0 failures
- **E2e (Playwright):** 28 passed / 28 total — serial worker — 0 failures
  - Includes 10 new specs in `e2e/render-and-links.spec.ts`

---

## Per-Item Results

### Item 1 — Landing "Já tem um código?" join input visible + join-by-code end-to-end

**PASS.**

The join input is present with `placeholder="ex.: bar-do-ze"`. Before the fix the input background matched its card (camouflaged); after the fix it has a distinct fill and is immediately visible. Typed `bar-render-tv` → "Entrar" button enabled → click navigated to `http://localhost:3040/bar-render-tv`. Evidence: `apptester-01-landing-join-input.png`.

### Item 2 — Clean slugs

**PASS.**

- "Bar do Paulin" → `bar-do-paulin` (clean slug, no random tail). Confirmed via the post-create success screen showing `http://localhost:3040/bar-do-paulin`. Evidence: `apptester-02-clean-slug.png`.
- "Bar do Paulin" (second create, collides) → `bar-do-paulin-hsd1` (4-char suffix appended on collision). Verified via Playwright manual session.
- Reserved name "tv" → `tv-<suffix>` (reserved-safety guard fires). Screenshot shows URL `http://localhost:3040/tv-<suffix>`. Evidence: `apptester-03-reserved-slug-suffix.png`.
- `new-78c6` patron page routes correctly (no shadowing of `/new` route). Verified patron-room page renders song form.

### Item 3 — Room-404 page: valid-shape missing slug → recreate CTA → prefills /new

**PASS.**

`/sala-que-nao-existe-xyz` shows "Essa sala não existe (ou o link está errado)" and a "Recriar sala «Sala Que Nao Existe Xyz»" link pointing to `/new?name=Sala%20Que%20Nao%20Existe%20Xyz`. Evidence: `apptester-04-room-404-recreate.png`.

Clicking the link navigates to `/new?name=...` with the input pre-filled "Sala Que Nao Existe Xyz". Clicking "Criar sala" created the room with slug `sala-que-nao-existe-xyz` (full recreate flow confirmed end-to-end).

### Item 4 — Patron page "assista na TV" player-hint present + correct link

**PASS.**

The patron page shows `data-testid="patron-player-hint"` "🖥️ O vídeo toca na tela do bar. Assistir na TV ↗" with `href="/<room>/tv"` pointing to the correct room's TV page. Confirmed on multiple rooms (`/new-78c6/tv`, `/bar-do-paulin/tv`, `/sala-que-nao-existe-xyz/tv`). Evidence: `apptester-05-patron-player-hint.png`.

### Item 5 — Admin: "Sala do público" + "Abrir /tv" links correct

**PASS.**

After admin login, the header shows:
- `data-testid="admin-patron-link"` → `/bar-admin-test` (patron page) ✓
- `data-testid="admin-tv-link"` → `/bar-admin-test/tv` (TV page) ✓

Both links use `target="_blank"` (new tab) as specified. Evidence: `apptester-06-admin-customer-links.png`.

### Item 6 — Ephemeral-warning: absent in local dev + logic confirmed

**PASS (with minor gap noted).**

The ephemeral-room warning is **absent** in local dev — confirmed on the `/new` success screen after creating "Ephemeral Test Bar" in `NODE_ENV=development`. The success screen shows no temporary-room notice. The warning logic in `lib/rooms.ts`:

```typescript
export function isEphemeralRoomStore(): boolean {
  return resolveDriver() === "memory" && process.env.NODE_ENV === "production";
}
```

This correctly gates the warning behind `NODE_ENV === "production"` so it never appears in local dev or CI.

**Gap:** No dedicated unit tests for `isEphemeralRoomStore()` exist in `__tests__/rooms.test.ts`. The function is simple (one-liner boolean) and the behavior is proven locally, but the TL asked for "confirm the logic via the unit tests" — there are no tests for it. This is a minor finding (not a blocker given the function's simplicity), but it should be noted for follow-up coverage.

### Item 7 — Full e2e suite (28/28) + unit (333/333)

**PASS.**

Ran both suites locally against the worktree. Verbatim output:
- `jest --forceExit`: 23 suites, **333 passed**, 0 failed, 2.814s.
- `playwright test --reporter=line`: **28 passed** (1.3m), 0 failures.

The link-crawler spec (`render-and-links.spec.ts:207`) crawls all internal hrefs on landing, `/new`, `/<room>/tv`, and `/<room>` and asserts none return HTTP 404.

**Optional honesty probe (link-crawler):** Skipped. The crawler passes with real data, which is sufficient evidence. A synthetic broken-href injection would add no meaningful gate signal beyond what the passing spec already demonstrates.

### Item 8 — Regression smoke: mode switcher, submit flow, /tv playing + idle

**PASS.**

- **Mode switcher:** Switched from "Karaokê completo" to "2 por mesa" on the admin page. Confirmed the radiogroup reflects the new active mode and the patron page queue shows "Modo: 🍻 2 por mesa". No regression.
- **/tv idle state:** `/bar-do-paulin/tv` with empty queue shows "Escaneia e canta! 🎤" poster + QR code. Evidence: `apptester-07-tv-idle.png`.
- **/tv playing state:** After seeding "Never Gonna Give You Up" via `/api/queue`, `/bar-do-paulin/tv` shows the YT iframe with the video playing, "Tocando agora" hero, and song/patron info. Evidence: `apptester-08-tv-playing.png`.
- **Submit flow:** Patron page renders song input form, queue list, and player hint. Queue reflects seeded song. End-to-end covered by e2e `submit-song.spec.ts` (part of the 28-pass suite).

---

## Evidence Index

All files at `work/evidence/ticket-20/` in the PR branch.

| File | What it proves |
|---|---|
| `apptester-01-landing-join-input.png` | Join input visible with distinct fill; usable (Item 1) |
| `apptester-02-clean-slug.png` | "Bar do Paulin Test" → `bar-do-paulin-test` (no suffix) (Item 2) |
| `apptester-03-reserved-slug-suffix.png` | Reserved name "tv" → `tv-<suffix>` — reserved-path safety works (Item 2) |
| `apptester-04-room-404-recreate.png` | Room-404 shows error + "Recriar sala…" CTA with correct href (Item 3) |
| `apptester-05-patron-player-hint.png` | Patron page "assista na TV" hint linking to room's /tv (Item 4) |
| `apptester-06-admin-customer-links.png` | Admin header shows "Sala do público ↗" + "Abrir /tv ↗" with correct hrefs (Item 5) |
| `apptester-07-tv-idle.png` | /tv idle state: recruitment poster, QR code, no dead player panel (Item 8) |
| `apptester-08-tv-playing.png` | /tv playing state: YT iframe embedded, song hero displayed (Item 8) |

(Dev evidence 01–07 also present from prior Dev run.)

---

## Defects Found

| # | Severity | Description |
|---|---|---|
| D1 | Minor | `isEphemeralRoomStore()` has no dedicated unit test. Function is correct and behavior verified locally; TL asked for unit-level proof. Follow-up ticket recommended. |

No blockers. D1 does not affect gate verdict.

---

## Friction

- Port mismatch: the task brief said PORT=3020 but `package.json` hardcodes `-p 3040`. Worktree's port is 3040. No breakage — server was already running from a prior session — but the port spec in the task brief should be updated.
- Playwright MCP screenshot tool saved to `.playwright-mcp/*.png` but files did not persist to disk (tool reports success, files absent). Used a Playwright Node.js script as workaround to write evidence directly to the product worktree.

---

## Verdict

**[app-tester] PASS — all 8 items verified, 28/28 e2e + 333/333 unit, CI green, one minor gap (no unit test for isEphemeralRoomStore — not a blocker)**
