# TICKET-60 — Independent review (clean-context Reviewer)

- **Date:** 2026-08-05 · **Branch:** `ticket/60-contrast-e2e` · **Worktree:** `.worktrees/ticket-60` · **Port used:** 3160
- **Method:** read every changed file directly, re-derived all contrast math myself, ran the suite 4×, unskipped both `test.fixme` entries to see their real failure output, and injected + reverted a deliberate regression. The dev report was read last and treated as an unverified claim throughout.

## Verdict

**APPROVE-WITH-FOLLOWUPS**

The spec does what the ticket asked, the math is the real WCAG formula (not an approximation), the ancestor walk genuinely alpha-composites through multiple real layers in the live app, both `test.fixme` entries are genuine product findings rather than test bugs, and the suite provably fails loudly on an injected regression with the required diagnostic shape. The follow-ups below are documentation-accuracy and test-naming issues, none blocking.

## What I independently verified

### 1. File scope + tests run

`git status --porcelain` in the worktree shows exactly three untracked files and nothing else:

```
?? e2e/contrast.spec.ts
?? work/reports/dev/TICKET-60-dev-report.md
?? work/tickets/TICKET-60-contrast-e2e.md
```

(this review file is the fourth allowed path). `git diff --stat main -- e2e/helpers.ts` is empty and `helpers.ts` does not appear in `git status` — **untouched**, as required. `node_modules` was already present; no `npm ci` needed.

Suite run (`PORT=3160 npx playwright test e2e/contrast.spec.ts`), observed by me:

```
Running 14 tests using 1 worker
  ✓ 1..3  contrast math sanity (3 tests)
  ✓ 4     landing: heading and join-by-code section heading
  -  5     landing: create-room CTA (fixme)
  ✓ 6     landing: join-code input vs its own fill
  ✓ 7     landing: footer copy
  ✓ 8     patron: post-join essentials
  ✓ 9     patron: seeded queue entry
  ✓ 10    admin: dashboard controls + customer-screen links
  -  11    admin: active mode-switcher label (fixme)
  ✓ 12    admin: login gate host-code input
  ✓ 13    tv: idle state
  ✓ 14    tv: now-playing hero
  2 skipped
  12 passed (1.4m)
```

**12 passed / 2 skipped (fixme) / 0 failed** — matches the dev report's claim exactly. Reproduced green a second time (1.8m).

### 2. Contrast math re-derived independently

I re-implemented the WCAG formula in a throwaway Node script (linearize each sRGB channel with `v<=0.03928 ? v/12.92 : ((v+0.055)/1.055)^2.4`, `L = 0.2126R+0.7152G+0.0722B`, `ratio = (L1+0.05)/(L2+0.05)`) and compared line-by-line with `inPageContrast`:

- The code's `relLuminance` and ratio expression are **character-for-character the real WCAG formula** — correct 0.03928 knee, correct 12.92 divisor, correct 1.055/0.055 offsets, correct 2.4 exponent, correct coefficients. Not an approximation tuned to pass one case.
- My script: black on white = **21.0000** exactly. The in-spec self-test (`toBeCloseTo(21, 0)`) does run and does pass (test 1, observed green).
- Large-text logic: `fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700)` — matches WCAG's 18pt / 14pt-bold definition, correct direction, no inversion. Empirically confirmed: the injected-regression run on the 40px/weight-700 `h1` printed `needs 3:1 for large text`, while the 16px/weight-600 CTA printed `needs 4.5:1 for normal text`. Both branches exercised for real.
- The `expect(..., message)` form passes the diagnostic as the assertion message, so it prints ahead of Playwright's own `Expected/Received` — verified in real failure output.

### 3. Ancestor walk / transparency handling is real, not a stub

Reading `resolveOpaqueBackground`: it pushes each ancestor's own `backgroundColor` (starting with the element itself) into a layer stack, stops at the first alpha >= 0.999 or at the document root, seeds a white base only as an explicit last-resort fallback, then composites **back-to-front** (`for (i = layers.length-1; i >= 0; i--)`) with a correct `over*a + under*(1-a)` source-over formula. Order and formula are both right.

This is not just exercised by a synthetic probe. The live mode-switcher measurement (below) resolves through **three real layers** — a `.name` span with no background, an `.option.active` with `rgba(230,57,70,0.09)`, and further transparent ancestors — down to the opaque page `--bg`, producing `rgb(33,17,18)`. That value can only come from genuine multi-layer alpha compositing; a hardcoded default would have produced `rgb(13,13,13)` or `rgb(26,26,26)`. Likewise the injected-regression `h1` (no background of its own) correctly resolved to `rgb(13, 13, 13)` = `--bg` via the walk.

### 4. Both `test.fixme` entries are genuine findings

I temporarily flipped each `test.fixme(` to `test(` one at a time, ran it, and reverted (the spec file's md5 is byte-identical to before my edits: `dfeb9b3e751527c2e2c2279cd32432c1`).

**(a) `.btn-primary` — white on `--accent`.** Real output:

```
Error: Contrast failure for "landing: create-room CTA button text":
fg=rgb(255, 255, 255) on bg=rgb(230, 57, 70) → ratio=4.17:1
(needs 4.5:1 for normal text, fontSize=16px, fontWeight=600)
```

My independent computation for `#fff` on `#e63946`: **4.1681** → 4.17 ✓. `app/globals.css` confirms `--accent: #e63946` and `.btn-primary { background: var(--accent) }`. Genuine miss, correctly classified as normal text (16px/600 is nowhere near 18.66px-bold).

**(b) `.option.active .name` — accent on accent-tint.** Real output:

```
Error: Contrast failure for "admin: active mode-switcher label":
fg=rgb(230, 57, 70) on bg=rgb(33, 17, 18) → ratio=4.37:1
(needs 4.5:1 for normal text, fontSize=16px, fontWeight=800)
```

`components/host/ModeSwitcher.module.css` confirms `.option.active { background: rgba(230, 57, 70, 0.09) }` and `.option.active .name { color: var(--accent) }`. Recomputing: `rgba(230,57,70,0.09)` over `#0d0d0d` (`--bg`) = `rgb(33,17,18)`, and `#e63946` on that = **4.374** → 4.37 ✓. Genuine miss.

Note the small factual correction in **Issue 1** below: the composite base is `--bg` `#0d0d0d`, not `--surface` `#1a1a1a` as both the spec comment and the dev report state. (Over `--surface` the composite would be `rgb(44,29,30)` and the ratio **3.87**, which is a *worse* miss — so the direction of the finding is unaffected, only its attribution.)

### 5. Injected-regression test (the decisive check)

I edited `app/page.tsx` line 53 to add `color: "#101010"` to the landing `h1` (near-invisible against the `#0d0d0d` page background) and re-ran only that test. It failed, with exactly the required shape:

```
Error: Contrast failure for "landing: h1 brand heading":
fg=rgb(16, 16, 16) on bg=rgb(13, 13, 13) → ratio=1.02:1
(needs 3:1 for large text, fontSize=40px, fontWeight=700)
```

Label ✓, both resolved rgb() values ✓, computed ratio ✓, threshold + which branch + font metrics ✓ — not a bare boolean. The background was resolved through the ancestor walk (the `h1` has no background of its own), which independently re-confirms item 3 on real app markup.

I then reverted with `git checkout -- app/page.tsx`; `git status --porcelain` returns to the three untracked files only, and a full re-run is green again (12 passed / 2 skipped). **No injected regression remains in the worktree.**

### 6. Test-quality sanity

Good: no `waitForTimeout`/arbitrary sleeps anywhere; every wait is a Playwright auto-waiting locator or an explicit `expect(...).toBeVisible/toContainText` with a bounded timeout; `retries: 0` in the config means the observed greens are unretried; the `warmUp` route-compilation pattern is copied from the established `render-and-links.spec.ts` convention (documented in `playwright.config.ts` as the in-memory-driver caveat), not invented here; nothing depends on the two fixme'd failures staying broken (fixing the tokens later just requires un-fixme'ing).

Flakiness observed across 4 runs: two full greens, one run where every test after the landing block failed **immediately after I reverted `app/page.tsx`** (Next dev hot-reload recompiling mid-run against `reuseExistingServer` — an artifact of my own edit, not the spec), and one run with a single failure whose `error-context.md` shows `apiRequestContext.post: read ECONNRESET` on `POST /api/rooms` inside `warmUp` — a dev-server transport hiccup, not contrast logic. Both are environmental and affect the whole e2e suite equally; see Follow-up 3.

## Issues found (none blocking)

1. **Documentation mis-attribution of finding (b)'s backdrop layer.** The inline comment at `e2e/contrast.spec.ts:411-413`, `work/reports/dev/TICKET-60-dev-report.md` finding 2, and `work/tickets/TICKET-60-contrast-e2e.md` finding 2 all say the `rgba(230,57,70,0.09)` tint is "composited onto the card's `var(--surface)` (#1a1a1a)". The measured `bg=rgb(33,17,18)` proves the base is actually `var(--bg)` `#0d0d0d`. The reported rgb and 4.37:1 ratio are both correct — only the named layer is wrong. Worth a one-line correction so the follow-up a11y ticket does not chase the wrong token.

2. **Three test titles promise more than the body asserts.**
   - `"live queue entry: title, meta line, and mode badge"` — asserts title and badge; there is **no meta-line assertion**.
   - `"footer + tagline (muted text)"` — asserts only `footer span`; the tagline `<p>` is not asserted.
   - `"post-join essentials: ... inputs ..."` (plural) — asserts one input.
   Titles should either shrink to what they check or the missing assertions should be added. Low severity, but this is precisely the "assertions check what their names claim" property the ticket exists to defend.

3. **Container-level assertions under-cover their children.** `assertAA` on wrappers (`tv-idle`, `tv-hero`, `patron-player-hint`) reads the *wrapper's* computed `color`. Any descendant that sets its own color is not checked. This is a coverage ceiling, not a bug — the wrapper assertion is still valid — but it means "the TV idle screen is legible" is weaker than it reads.

4. **Minor dead code / robustness nits** (not worth blocking):
   - `computeContrast`'s `if ("error" in result)` branch is unreachable — `inPageContrast` never returns the `{ error }` variant despite its declared union.
   - `parseColor` splits on commas, so it assumes Chromium's legacy `rgb(r, g, b)` / `rgba(r, g, b, a)` serialization. Correct today for `color`/`background-color` in Chromium; would silently return `[0,0,0,0]` (treated as transparent) if a future engine emits space-separated `rgb(r g b / a)` or `color(srgb …)`. A cheap guard would be to also accept the space-separated form.
   - `resolveOpaqueBackground` ignores `opacity` and background-images/gradients. Neither is in play on the covered surfaces today; a gradient background would silently read as transparent and walk past.
   - `page.locator("section", { has: codeInput })` would trip Playwright strict mode if the landing page ever nests another `<section>` around the input.

## Follow-ups worth filing

1. **[a11y, HIGH] `--accent` (#e63946) fails AA as a foreground token.** Two confirmed, reproducible misses: `.btn-primary` white-on-accent at **4.17:1** (site-wide primary CTA — landing, patron join, submit-song, admin login) and `.option.active .name` accent-on-tint at **4.37:1**. Both need a token decision (lighten the accent for text use, darken the button fill, or raise weight/size past the large-text bar), then the two `test.fixme` entries in `e2e/contrast.spec.ts` flip back to `test`. This ticket correctly refused to fix them.
2. **[docs, LOW] Correct the finding-(b) backdrop attribution** (`--bg` `#0d0d0d`, not `--surface` `#1a1a1a`) in the spec comment, dev report, and ticket file — see Issue 1.
3. **[test-infra, LOW] e2e dev-server flakiness.** An intermittent `ECONNRESET` on `POST /api/rooms` during `warmUp` can fail an arbitrary test. Affects the whole e2e suite, not just this spec (`retries: 0` makes it visible). Consider a single retry on the warm-up requests, or `retries: 1` in CI.
4. **[test-coverage, LOW] Tighten the three over-promising test titles and consider descending into child elements for the container-level assertions** — Issues 2 and 3.

## Post-review fix

Follow-up 2 (the `--surface`/`--bg` mis-attribution in Issue 1) was corrected immediately after
this review: the inline comment in `e2e/contrast.spec.ts` and the matching prose in the dev report
and ticket file now correctly name `var(--bg)` (#0d0d0d) as the nearest opaque ancestor the tint
composites onto, instead of `var(--surface)`. The measured rgb values and 4.37:1 ratio were already
correct and are unchanged.

## Worktree state at end of review

Clean. `git status --porcelain` shows only the three untracked ticket files (plus this review file). `app/page.tsx` reverted and verified byte-identical to `main`; `e2e/contrast.spec.ts` md5-verified identical to its pre-review state (both `test.fixme` markers restored); `e2e/helpers.ts` untouched; the gitignored `test-results/` artifact directory removed.
