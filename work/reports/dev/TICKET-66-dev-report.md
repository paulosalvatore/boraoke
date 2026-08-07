# TICKET-66 — dev report: split the accent token by role

**Branch:** `ticket/66-accent-token-split` · **Decision implemented:** Option B (role-split accent tokens), per `work/design/landing-rethink/CONTRAST.md` and the TL's approval of landing-rethink Direction 2.

## What changed

`app/globals.css` keeps `--accent: #e63946` as the brand hue and adds two derived roles:

| Token | Hex | Role |
|---|---|---|
| `--accent` | `#e63946` (unchanged) | borders, focus rings, non-text UI, large/decorative text |
| `--accent-strong` | `#d92330` (new) | filled CTA background under `#fff` text |
| `--accent-hover` | `#c1121f` (unchanged) | CTA hover |
| `--accent-text` | `#ee5a64` (new) | accent used AS text on dark backgrounds |

A single darkened hex cannot satisfy both constraints — white-on-accent ≥4.5:1 needs a darker red, accent-as-text-on-dark ≥4.5:1 needs a lighter one. The split is the fix, not an implementation detail.

## Ratios — recomputed independently with the WCAG relative-luminance formula

Every value below was computed from the hexes, not copied from CONTRAST.md. **All 19 pairs reproduced CONTRAST.md exactly; no disagreement.**

| # | Foreground | Background | Before | After | AA (4.5:1) |
|---|---|---|---|---|---|
| C1 | `#ffffff` | `.btn-primary` fill | **4.17** (`--accent`) | **4.96** (`--accent-strong`) | FAIL → PASS |
| C2 | mode-switcher active label | accent tint `.09` over `--bg` → `rgb(33,17,18)` | **4.37** (`--accent`) | **5.45** (`--accent-text`) | FAIL → PASS |
| C3 | accent-as-text | `--surface #1a1a1a` | **4.18** (`--accent`) | **5.21** (`--accent-text`) | FAIL → PASS (latent) |
| C4 | accent-as-text | `--bg #0d0d0d` | 4.66 | **5.81** | pass → pass (margin widened) |
| — | `#ffffff` | `--accent-hover #c1121f` (hover) | 6.22 | 6.22 | pass |
| — | accent-as-text | tint `.12` over `--bg` → `rgb(39,18,20)` | 4.26 | **5.31** | (headroom check — no accent-coloured TEXT currently sits on this tint; the patron reorder toast paints `--text` on it) |
| — | accent-as-text | tint `.10` over `--surface` → `rgb(46,29,30)` (SongSearch selected row) | 3.84 | **4.79** | FAIL → PASS |
| — | `--accent` as non-text UI (borders/focus) | `--bg` / `--surface` | 4.66 / 4.18 | unchanged | PASS on the 3:1 UI bar |

One extra genuine failure surfaced beyond CONTRAST.md's named list: accent-as-text on the `.10`-over-`--surface` tint (SongSearch selected row) at **3.84** — the worst ratio in the codebase, and fixed by the same `--accent-text` swap. The `.12`-over-`--bg` row is a headroom check only: no accent-coloured text sits on that tint today.

## Every accent call site found, and how it was classified

Grep: `grep -rn "accent\|e63946\|230, *57, *70" app components`.

### Changed → `--accent-text` (accent used AS text)

| File:line | Element |
|---|---|
| `app/globals.css:31` | global `a { color }` |
| `app/(patron)/[room]/admin/admin.module.css:174` | `.removeBtn` (0.8rem/700 on the dark queue row) |
| `app/(patron)/[room]/admin/admin.module.css:265` | `.error` (login-gate error) |
| `app/(patron)/[room]/admin/admin.module.css:391` | `.rejectBtn` **colour only** (its border stays `--accent`) |
| `components/host/ModeSwitcher.module.css:32` | `.option.active .name` — the C2 failure |
| `components/host/ModeSwitcher.module.css:47` | `.chip` "ATIVO" (0.68rem/700) — latent C3 |
| `components/LanguageSwitcher.module.css:75` | `.check` glyph |
| `app/new/page.tsx:158, 190` | saved-room link, error text |
| `app/(patron)/[room]/page.tsx:121` | back-to-home link |
| `app/(patron)/[room]/PatronRoom.tsx:329, 366, 442, 488, 526` | venue-name span, nickname button, submit error, rejected-pending text, player-hint link span |
| `components/SongSearch.tsx:221, 280` | `role="status"` search status, selected-row indicator glyph |
| `components/SavedRooms.tsx:137, 146, 153` | three saved-room action links |

### Changed → `--accent-strong` (filled background under `#fff` text)

| File:line | Element | Before → After |
|---|---|---|
| `app/globals.css:57` | `.btn-primary` | 4.17 → 4.96 |
| `app/(patron)/[room]/admin/admin.module.css:182` | `.confirmYes` (0.75rem/700 white) | 4.17 → 4.96 |
| `app/(patron)/[room]/admin/admin.module.css:346` | `.pendingBadge` (0.8rem/700 white) | 4.17 → 4.96 |

### Deliberately left on `--accent` (non-text UI — the 3:1 bar, already met)

`app/globals.css:48` input focus border · `admin.module.css:51` `.tvLink:hover` border · `:163` `.moveBtn:hover` border · `:212` `.ctrlBtn:hover` border · `:325` focus-visible outline · `:387` `.rejectBtn` border · `ModeSwitcher.module.css:24` active option border · `:48` `.chip` border · `SongSearch.tsx:247` selected-row border · `PatronRoom.tsx:479` dashed rejected-card border · `:553` reorder-toast border · `PatronRoom.tsx:552` and `SongSearch.tsx:246` decorative rgba tints.

### Deliberately left on `--accent` — and it MUST stay

`app/admin/analytics/analytics.module.css:49` — `.button` is `background: var(--accent)` with **`color: #0a0a0a`** (dark text, not white). `#0a0a0a` on `#e63946` = **4.75:1 PASS**; on `#d92330` it would drop to **3.99:1 FAIL**. Swapping this to `--accent-strong` would have *introduced* a regression. `analytics.module.css:108` `.dayBar` is a chart bar (non-text graphic) — unchanged.

### Hand-off — sibling-owned, NOT touched

- `app/page.tsx:93` — `<Link style={{ color: "var(--accent)" }} data-testid="last-room-link">` is an **accent-as-text call site that still fails at 4.66:1-on-`--bg`/4.18-on-`--surface` semantics** and should become `--accent-text`. The landing rebuild owns this file. Visible in `landing-cta-after.png`: "Última sala: default" renders a shade darker than the SavedRooms "Entrar" link right above it.
- `components/tv/tv.module.css:151` — `background: rgba(230,57,70,0.92)`, a decorative fill, not text. **No change needed**; listed only for completeness.
- `components/FeedbackWidget.tsx` / `components/feedback/**` — grepped, **zero** accent usages.

## Tests

Both `test.fixme` blocks are now real `test`s, plus two new tests covering the latent C3 class that nothing was asserting.

```
Running 16 tests using 1 worker
  ✓   5 landing page contrast › create-room CTA button text meets AA (--accent-strong #d92330 under #fff = 4.96:1) (2.5s)
  ✓  11 admin room contrast › active mode-switcher label meets AA (--accent-text #ee5a64 on the accent tint = 5.45:1) (3.7s)
  ✓  12 admin room contrast › admin queue row: accent-coloured remove button on a dark card meets AA (latent C3) (3.8s)
  ✓  13 admin room contrast › admin mode-switcher active chip: accent-as-text meets AA (latent C3) (3.2s)
  16 passed (1.0m)
```

16 passed, **0 skipped** (was 14 passed + 2 fixme).

**Negative control** — the new tests are not vacuous. With `--accent-strong` and `--accent-text` temporarily collapsed back to `#e63946` (single hex), all four fail with the exact documented ratios:

```
  4 failed
    › create-room CTA button text meets AA ...
    › active mode-switcher label meets AA ...
    › admin queue row: accent-coloured remove button on a dark card meets AA (latent C3)
    › admin mode-switcher active chip: accent-as-text meets AA (latent C3)
  Error: Contrast failure for "admin: active mode-switcher 'ativo' chip":
    fg=rgb(230, 57, 70) on bg=rgb(33, 17, 18) → ratio=4.37:1 (needs 4.5:1 ...)
```

Other gates:

- `npm test` → `Test Suites: 43 passed, 43 total · Tests: 683 passed, 683 total`
- `npm run build` → clean, all routes emitted
- `npx tsc --noEmit` → **zero** errors in `app/**`, `components/**` or `e2e/contrast.spec.ts`. All 61 remaining errors are pre-existing missing-jest-globals noise confined to two `__tests__/*.test.ts` files, neither of which appears in this diff.

## Independent opus review

`work/reports/review/TICKET-66-review.md` — verdict **APPROVE-WITH-FOLLOWUPS**, no blockers. The reviewer reimplemented WCAG 2.x from the spec in a clean context and reproduced every figure in CONTRAST.md and this report to two decimals; found no missed or misclassified accent call site; confirmed the AA thresholds in `e2e/contrast.spec.ts` are byte-identical to `main` (every diff hit on `4.5`/`3`/`18.66` is comment prose); independently reproduced the negative control; and confirmed no sibling-owned file appears in the diff. Its three accuracy nits are fixed above and in the test comment.

**Open follow-up:** `app/page.tsx:93` → `--accent-text`, to be routed once the landing rebuild merges. It is the last accent-as-text call site in the codebase.

## Visual evidence

`work/evidence/TICKET-66/` — before/after pairs for the landing CTA, a patron room, the admin dashboard and the admin mode-switcher, captured at 1200×900, pt-BR. The brand still reads as the brand: the CTA red is a half-step deeper, accent text a half-step lighter, and every `--accent` border/ring is pixel-identical.
