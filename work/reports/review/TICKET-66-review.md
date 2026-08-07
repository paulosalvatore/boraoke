# TICKET-66 — independent opus review (accent token role split)

**Branch:** `ticket/66-accent-token-split` · **Reviewer:** independent opus, no prior context on this work · **Date:** 2026-08-07

Everything below was recomputed / re-run by the reviewer. Nothing is inherited from `CONTRAST.md` or the dev report.

---

## 1. Independently recomputed contrast ratios

Method: own implementation of the WCAG 2.x relative-luminance formula (sRGB linearization with the 0.03928 / 12.92 / 1.055-2.4 constants, `L = 0.2126R + 0.7152G + 0.0722B`, `(L1+0.05)/(L2+0.05)`). rgba tints composited with straight alpha (`fg·a + bg·(1−a)`, rounded to integer channels as browsers do) over the named opaque backdrop.

### White text on the accent family

| Foreground | Background | Ratio | 4.5:1 |
|---|---|---|---|
| `#ffffff` | `--accent` `#e63946` | **4.17** | FAIL |
| `#ffffff` | `--accent-strong` `#d92330` | **4.96** | **PASS** |
| `#ffffff` | `--accent-hover` `#c1121f` | **6.22** | **PASS** |

### Accent as text on opaque dark

| Foreground | Background | Ratio | 4.5:1 |
|---|---|---|---|
| `#e63946` | `--bg` `#0d0d0d` | **4.66** | pass (thin) |
| `#e63946` | `--surface` `#1a1a1a` | **4.18** | FAIL |
| `#ee5a64` | `--bg` `#0d0d0d` | **5.81** | **PASS** |
| `#ee5a64` | `--surface` `#1a1a1a` | **5.21** | **PASS** |

### Accent as text on rgba(230,57,70,α) tints

| α | Backdrop | Composited bg | `#e63946` | `#ee5a64` |
|---|---|---|---|---|
| .09 | `#0d0d0d` | `rgb(33,17,18)` | **4.37** FAIL | **5.45** PASS |
| .09 | `#1a1a1a` | `rgb(44,29,30)` | **3.87** FAIL | **4.83** PASS |
| .10 | `#0d0d0d` | `rgb(35,17,19)` | **4.34** FAIL | **5.41** PASS |
| .10 | `#1a1a1a` | `rgb(46,29,30)` | **3.84** FAIL | **4.79** PASS |
| .12 | `#0d0d0d` | `rgb(39,18,20)` | **4.26** FAIL | **5.31** PASS |
| .12 | `#1a1a1a` | `rgb(50,30,31)` | **3.76** FAIL | **4.68** PASS |

### Dark text on accent (the regression direction)

| Foreground | Background | Ratio | 4.5:1 |
|---|---|---|---|
| `#0a0a0a` | `--accent` `#e63946` | **4.75** | **PASS** |
| `#0a0a0a` | `--accent-strong` `#d92330` | **3.99** | **FAIL** |
| `#0a0a0a` | `--accent-hover` `#c1121f` | 3.18 | FAIL |

### Cross-checks of CONTRAST.md's other claims

`#f1f1f1` on `#0d0d0d` = **17.21**, on `#1a1a1a` = **15.41**. `#9a9a9a` = **6.91 / 6.19**. `#888` = **5.48 / 4.91**. Rejected single-hex candidate `#e42735`: `#fff` on it = **4.53**, it on `#0d0d0d` = **4.29**, on `#1a1a1a` = **3.85**.

**Verdict on item 1: CONFIRMED — zero disagreement.** Every figure in `CONTRAST.md` (C1–C4, P1–P9, the rejected-single-hex paragraph) and every figure in the dev report's ratio table reproduces exactly to 2 decimal places against my own implementation. The mathematical-incompatibility argument is sound: `#fff` ≥4.5:1 forces the accent luminance down, accent-as-text ≥4.5:1 on `#1a1a1a` forces it up, and `#e42735` demonstrates the squeeze empirically. The role split is the correct fix, not an over-engineering.

**Two measurement nits (not defects, see §4/§9):**
- The dev report labels the `.12`-over-`--bg` tint row "patron reorder toast area". That toast (`PatronRoom.tsx:552`) does **not** paint accent text — its text inherits `--text` `#f1f1f1`. The 4.26→5.31 row is therefore hypothetical, not an actual fixed call site. The `.10`-over-`--surface` row (3.84→4.79) **is** real — it is the `SongSearch` selected-row check glyph.
- The new "queue-row remove button" test's own name says "on a `--surface` card", but the element Playwright actually measures sits on `.rowPlaying` (`background: #f59e0b12` over `--bg`), resolving to `rgb(29,23,13)` — measured in-browser during my negative control. Real ratios there: `#e63946` = **4.26** (fail), `#ee5a64` = **5.32** (pass). The test is still a genuine, correctly-failing-before / passing-after assertion of the C3 class; only the label is imprecise.

---

## 2. Both `test.fixme` blocks are genuine passing tests, thresholds untouched

- `grep -nE 'test\.(fixme|skip|only)'` over `e2e/contrast.spec.ts` returns **zero code hits** — the only matches are the words `test.fixme` inside explanatory prose comments. No `describe.skip`, no `.only`.
- Both former fixmes are now `test(...)` with real bodies; 16 `test(` blocks total (was 14 + 2 fixme).
- **Threshold logic is byte-identical to `main`.** `git diff main...HEAD -- e2e/contrast.spec.ts` filtered to lines mentioning `4.5 / 3 / 18.66 / 24 / threshold / isLarge / ratio` shows **only removed/added comment prose** — every `-` hit is a `//` comment line. The live code still reads:
  - `const isLargeText = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);`
  - `const threshold = r.isLargeText ? 3 : 4.5;`
  - `expect(r.ratio, message).toBeGreaterThanOrEqual(threshold);`
- The `assertAA` helper, `inPageContrast`, `resolveOpaqueBackground` and the three self-test sanity cases (21:1 black-on-white, ~1:1 surface-on-surface, transparent-ancestor resolution) are all unmodified.

Real run output (`PORT=3180 npx playwright test e2e/contrast.spec.ts --reporter=list`):

```
Running 16 tests using 1 worker
  ✓   1 › contrast math sanity › black text on white background resolves to 21:1 (the canonical WCAG max) (9.4s)
  ✓   2 › contrast math sanity › known-bad pair (surface-on-surface, the original TICKET-20 bug) computes ~1:1, well under AA (3.5s)
  ✓   3 › contrast math sanity › transparent-background element resolves against the real ancestor paint, not black/white default (3.8s)
  ✓   4 › landing page contrast › heading and join-by-code section heading meet AA (3.6s)
  ✓   5 › landing page contrast › create-room CTA button text meets AA (--accent-strong #d92330 under #fff = 4.96:1) (3.8s)
  ✓   6 › landing page contrast › join-code input: typed text is legible against its OWN fill, not the card behind it (3.8s)
  ✓   7 › landing page contrast › footer + tagline (muted text) meet AA against the page background (3.7s)
  ✓   8 › patron room contrast › post-join essentials: add-song heading, inputs, live-queue heading, player hint (4.0s)
  ✓   9 › patron room contrast › live queue entry: title, meta line, and mode badge meet AA once seeded (4.1s)
  ✓  10 › admin room contrast › dashboard controls and customer-screen links meet AA (3.6s)
  ✓  11 › admin room contrast › active mode-switcher label meets AA (--accent-text #ee5a64 on the accent tint = 5.45:1) (4.4s)
  ✓  12 › admin room contrast › admin queue row: accent-coloured remove button on a --surface card meets AA (latent C3) (4.5s)
  ✓  13 › admin room contrast › admin mode-switcher active chip: accent-as-text meets AA (latent C3) (3.7s)
  ✓  14 › admin room contrast › login gate: host-code input text is legible against its own fill (3.6s)
  ✓  15 › tv screen contrast › idle state: wordmark + call-to-action text meet AA (3.5s)
  ✓  16 › tv screen contrast › now-playing state: hero title meets AA (large-text threshold) once seeded (3.6s)

  16 passed (1.2m)
```

**Verdict on item 2: CONFIRMED.** 16 passed, 0 skipped, 0 fixme, thresholds unweakened.

---

## 3. Negative control — the fix is NOT vacuous

Procedure: `cp app/globals.css` to scratchpad, collapsed `--accent-strong` and `--accent-text` both to `#e63946` (single hex), re-ran the suite, restored from backup, confirmed `git status --porcelain` **empty**.

```
  4 failed
    › create-room CTA button text meets AA (--accent-strong #d92330 under #fff = 4.96:1)
    › active mode-switcher label meets AA (--accent-text #ee5a64 on the accent tint = 5.45:1)
    › admin queue row: accent-coloured remove button on a --surface card meets AA (latent C3)
    › admin mode-switcher active chip: accent-as-text meets AA (latent C3)
  12 passed (1.1m)
```

Real in-browser failure messages captured from the run:

```
Contrast failure for "landing: create-room CTA button text":
  fg=rgb(255, 255, 255) on bg=rgb(230, 57, 70) → ratio=4.17:1 (needs 4.5:1 for normal text, fontSize=16px, fontWeight=600)
Contrast failure for "admin: active mode-switcher label":
  fg=rgb(230, 57, 70) on bg=rgb(33, 17, 18) → ratio=4.37:1 (needs 4.5:1 for normal text, fontSize=16px, fontWeight=800)
Contrast failure for "admin: queue-row remove button (accent-as-text on --surface)":
  fg=rgb(230, 57, 70) on bg=rgb(29, 23, 13) → ratio=4.26:1 (needs 4.5:1 for normal text, fontSize=12.8px, fontWeight=700)
Contrast failure for "admin: active mode-switcher 'ativo' chip":
  fg=rgb(230, 57, 70) on bg=rgb(33, 17, 18) → ratio=4.37:1 (needs 4.5:1 for normal text, fontSize=10.88px, fontWeight=700)
```

The browser-measured 4.17 / 4.37 / 4.37 match my hand-computed values exactly; 4.26 corresponds to `rgb(29,23,13)` = `#f59e0b12` over `#0d0d0d` (the now-playing row tint), which I re-derived independently. Every element measured is genuinely below its threshold, and none of the four is large text (16px/600, 16px/800, 12.8px/700, 10.88px/700 — all short of the 18.66px-bold bar, so the 3:1 relief correctly does not apply).

Worktree confirmed clean after restore.

**Verdict on item 3: CONFIRMED.** The reproduction is exact — 4 failures, the claimed ones, with the claimed ratios.

---

## 4. Call-site sweep — every remaining accent usage classified

`grep -rnE 'var\(--accent|#e63946|230, ?57, ?70' app components --include='*.tsx' --include='*.ts' --include='*.css'`, run by me, complete list:

### Remaining `var(--accent)` — correctly left alone (non-text / 3:1 UI bar)

| Site | Role |
|---|---|
| `app/globals.css:48` | input focus `border-color` |
| `admin.module.css:51` `.tvLink:hover` | border |
| `admin.module.css:163` `.moveBtn:hover` | border |
| `admin.module.css:212` `.ctrlBtn:hover` | border |
| `admin.module.css:325` | `outline` on switch focus-visible |
| `admin.module.css:387` `.rejectBtn` | border (its `color` correctly moved to `--accent-text`) |
| `ModeSwitcher.module.css:24` | active option border |
| `ModeSwitcher.module.css:48` `.chip` | border (its `color` moved) |
| `ModeSwitcher.module.css:25` | tint `rgba(230,57,70,.09)` background — deliberately untouched, correct |
| `SongSearch.tsx:246,247` | selected-row tint + border |
| `PatronRoom.tsx:479` | dashed rejected-card border |
| `PatronRoom.tsx:552,553` | reorder-toast tint + border (toast text inherits `--text`, not accent) |
| `analytics.module.css:108` `.dayBar` | chart bar, non-text graphic |
| `components/tv/tv.module.css:151` | `rgba(230,57,70,0.92)` decorative fill under `#fff` — sibling-owned, unchanged |

All are borders/outlines/decorative fills. `#e63946` on `#0d0d0d`/`#1a1a1a` = 4.66 / 4.18, both clear the 3:1 non-text-UI bar. Correct classification.

### `var(--accent)` still used as TEXT anywhere?

**Exactly one:** `app/page.tsx:93` — `<Link style={{ color: "var(--accent)" }} data-testid="last-room-link">`. Sibling-owned (landing rebuild), correctly handed off rather than edited. See §5.

### `--accent-strong` as a background — three sites, all under `#fff`

`globals.css:57` `.btn-primary` (`color: #fff`), `admin.module.css:177` `.confirmYes` (`color: #fff`), `admin.module.css:341` `.pendingBadge` (`color: #fff`). All now 4.96:1. Correct.

### `--accent-text` swaps — all 22 sites verified as genuine text

Global `a` rule, admin `.removeBtn` / `.error` / `.rejectBtn` colour, ModeSwitcher `.name` / `.chip`, LanguageSwitcher `.check`, `new/page.tsx` ×2, `[room]/page.tsx`, `PatronRoom.tsx` ×5, `SongSearch.tsx` ×2, `SavedRooms.tsx` ×3. Every one is a `color:` declaration on real text/glyph content. No background or border was mistakenly moved to `--accent-text`.

**Verdict on item 4: CONFIRMED — no missed or misclassified call site.** The only unconverted accent-as-text site is the deliberately-handed-off `app/page.tsx:93`.

---

## 5. Sibling-owned files untouched

`git diff main...HEAD --name-only` filtered for `app/page.tsx`, `app/page.module.css`, `components/tv/`, `components/FeedbackWidget`, `components/feedback/` returns **empty**. `git diff main...HEAD --stat -- app/page.tsx` is **empty** — the file is byte-identical to `main`.

The hand-off description is accurate: `app/page.tsx:93` is `color: "var(--accent)"` on the last-room link, normal-size text (0.85rem context), which measures 4.66 on `--bg` and would fail on `--surface`. It sits on `--surface` inside the join card in the evidence screenshot, so it is a genuine outstanding AA miss. It is visible in `landing-cta-after.png`: "Última sala: **default**" renders a shade darker than the "Entrar" link above it, exactly as claimed.

`components/tv/tv.module.css:151` is a `0.92`-alpha fill under `#fff` — near-opaque `#e63946`, so ~4.2:1 under white text at 1.6vw/700 (large text at typical TV widths). Sibling-owned, unchanged by this branch, out of scope. Flagging only for completeness; not a TICKET-66 defect.

**Verdict on item 5: CONFIRMED.**

---

## 6. Regression hunt — dark text on an accent background

I grepped for every dark `color:` value in `app/` and `components/` and cross-referenced against accent backgrounds. **Exactly one** element pairs a dark foreground with an accent background:

`app/admin/analytics/analytics.module.css:49` — `.button { background: var(--accent); color: #0a0a0a; font-weight: 700 }`.

Numerically verified: `#0a0a0a` on `#e63946` = **4.75:1 PASS**; on `#d92330` = **3.99:1 FAIL**; on `#c1121f` = 3.18 FAIL. The implementer's claim is exactly right — moving this to `--accent-strong` would have introduced a new AA failure. Leaving it on `--accent` is correct.

No other dark-on-accent case exists. `tv.module.css:132` (`#0f0f14`) and `:165` (`#1a1a1a`) sit on the amber `rgba(255,183,3,.94)` skip-notice and other non-accent fills; `components/feedback/*` `#1a1424` sits on the pink feedback gradient — none involve `--accent`.

Second regression vector I checked independently: the global `a { color: var(--accent-text) }` change would regress if any anchor sat on a LIGHT background. I grepped for light backgrounds — the only `#fff` in the app is `admin.module.css:315`, the toggle-switch knob pseudo-element (no text, no descendants). There is a single `:root`, no `prefers-color-scheme` block, no light theme. No regression.

Third vector: `--accent-hover` (#c1121f) is still darker than the new resting `--accent-strong` (#d92330), so `.btn-primary:hover` still reads as a press-down, not a lighten. Contrast improves on hover (6.22).

**Verdict on item 6: CONFIRMED, and the analytics claim is numerically correct.**

---

## 7. `npm test` and `npx tsc --noEmit`

```
Test Suites: 43 passed, 43 total
Tests:       683 passed, 683 total
Snapshots:   0 total
Time:        1.846 s
```

Matches the claim exactly (683/683, 43 suites).

`npx tsc --noEmit` → 61 error lines, spanning exactly **two** files:

```
__tests__/advance-rate-limit.test.ts
__tests__/analytics.test.ts
```

All are `TS2304 / TS2582 Cannot find name 'describe' / 'it' / 'expect' / 'beforeEach'` — the missing-`@types/jest`-globals class. **Zero** errors in `app/**`, `components/**`, or `e2e/**`, and specifically zero in `e2e/contrast.spec.ts`.

"Pre-existing" verified structurally: `git diff main...HEAD --name-only | grep -E '__tests__|advance-auth'` is **empty** — neither error file is touched by this branch, so the errors cannot have been introduced here.

One inaccuracy in the dev report: it names `e2e/advance-auth.spec.ts` as a remaining-noise file. That file produces **no** tsc errors in my run. The characterization is over-broad, not wrong in substance — the actual noise set is smaller than claimed, and the load-bearing claim (zero errors in touched code) holds.

**Verdict on item 7: CONFIRMED (with the one cosmetic over-statement noted).**

---

## 8. Visual evidence — does the brand still read as the brand?

Reviewed all four before/after pairs at `work/evidence/TICKET-66/`.

- **`landing-cta-*`** — the "Criar a sala do seu bar" CTA goes from a slightly pink-leaning red to a marginally deeper, more saturated red. Side by side you can see it; on its own you would not. The wordmark, card chrome, muted copy and feedback pill are pixel-identical. The "Entrar" saved-room link lifts a half-step lighter and reads noticeably crisper against the card. The untreated "Última sala: **default**" link is now visibly duller than the "Entrar" link directly above — a small internal inconsistency that will disappear when the `app/page.tsx` hand-off lands.
- **`admin-mode-switcher-*`** — the active option's border and `.09` tint are unchanged; the "Karaokê completo" label and the "ATIVO" chip both lighten just enough to stop looking muddy against the tint. The chip's border stays the brand `#e63946`, so the outline still anchors the brand hue.
- **`admin-dashboard-*`** and **`patron-room-*`** — no perceptible chrome change; only accent-coloured labels and the pending badge shift.

The brand identity is intact. `--accent` `#e63946` is still the hue on every border, ring and outline; the two derived tokens are a half-step either side of it, which reads as intentional depth rather than a palette change.

**Verdict on item 8: CONFIRMED — brand preserved.**

---

## Summary of findings

**Blocking:** none.

**Non-blocking nits (all cosmetic/documentation, none affect shipped behaviour):**

1. The new test named "admin queue row: accent-coloured remove button on a **--surface** card" actually measures an element on `.rowPlaying` (`#f59e0b12` over `--bg` → `rgb(29,23,13)`), not on `--surface`. The assertion is genuine and correctly discriminating (4.26 → 5.32); only the name and its inline comment are imprecise. Worth a one-word comment fix on a later pass, or leave it.
2. The dev report's ratio table attributes the `.12`-over-`--bg` tint row (4.26 → 5.31) to the "patron reorder toast area". That toast paints `--text`, not accent — the row is a hypothetical, not a fixed call site. Harmless.
3. The dev report lists `e2e/advance-auth.spec.ts` among remaining tsc noise; it produces no errors. The real noise set is `__tests__/advance-rate-limit.test.ts` + `__tests__/analytics.test.ts` only.

**Follow-up required (already correctly scoped out of this branch):** `app/page.tsx:93` `last-room-link` must move `--accent` → `--accent-text` once the landing rebuild merges. This is the only accent-as-text call site left in the codebase, it is a real AA miss, and it is now visually inconsistent with the links around it. It should be filed as a tracked follow-up rather than living only in a dev-report paragraph.

The core engineering is sound: the mathematical argument for the split is correct and independently reproduced, every ratio in `CONTRAST.md` checks out to the digit, the tests are real and discriminating (proven by negative control), no threshold was loosened, no call site was missed, the one dangerous regression vector (dark-on-accent in analytics) was correctly identified and avoided, and no sibling-owned file was touched.

---

**Verdict: APPROVE-WITH-FOLLOWUPS**
