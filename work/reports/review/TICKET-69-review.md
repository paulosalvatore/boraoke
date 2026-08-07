# TICKET-69 — Reviewer report (clean context, independent re-derivation)

**Verdict: APPROVE-WITH-FOLLOWUPS** — no blockers remain. (BLOCKING-1 was raised mid-review against a dirty tree and has since been **RESOLVED**; see the addendum at the foot of this report for the resolution and the re-run gate output that clears it.)

**Reviewed:** branch `ticket/69-landing-demo-vivo`, worktree `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-69`, base `8a93fdf`. Main pass ran against committed HEAD `5a1d6c7`; final gate re-run against `914bc9e` (see addendum).
**Ports:** 3181 exclusively. No `.env` (in-memory store, degraded YouTube search) — expected, not a defect.
I did not write this code and re-ran every claim rather than trusting either report.

## Commits under review

```
5a1d6c7 chore(events): auto-commit event log after: test(TICKET-69): re-verify phone-card nudge
d0dfdb1 test(TICKET-69): re-verify phone-card nudge — up-next legibility partially fixed
2c94753 chore(events): auto-commit event log after: TICKET-69: rebuild the landing page
546bd75 TICKET-69: rebuild the landing page — Direction 2 "Demo vivo"
07cf747 chore(events): auto-commit event log after: test(TICKET-69): app tester visual gate evidence
1b5bddd test(TICKET-69): app tester visual gate evidence + PASS report
```

Diffstat: `app/page.module.css` (NEW, 421), `app/page.tsx` (+199/-64), `e2e/contrast.spec.ts` (3), `e2e/render-and-links.spec.ts` (6), the three `messages/*.json` (38 each), 10 evidence PNGs, 3 reports/tickets. Nothing else.

---

## Real command output I observed

### `npm test`

```
Test Suites: 43 passed, 43 total
Tests:       683 passed, 683 total
Snapshots:   0 total
Time:        2.505 s
Ran all test suites.
```

### `npm run build`

Exit 0, compiled successfully, full route table emitted (`/`, `/new`, `/tv`, `/[room]/**`, all `/api/**`). Only the pre-existing Next "inferred workspace root / multiple lockfiles" warning.

### `PORT=3181 npx playwright test e2e/contrast.spec.ts e2e/render-and-links.spec.ts e2e/rooms.spec.ts e2e/saved-rooms.spec.ts e2e/language-switcher.spec.ts`

```
  ✓   4 [chromium] › contrast.spec.ts:281 › landing page contrast › heading and join-by-code section heading meet AA (2.9s)
  -   5 [chromium] › contrast.spec.ts:298 › landing page contrast › create-room CTA button text meets AA — FAILS on current main: white-on-accent (#e63946) measures 4.17:1 …
  ✓   6 [chromium] › contrast.spec.ts:310 › landing page contrast › join-code input: typed text is legible against its OWN fill …
  ✓   7 [chromium] › contrast.spec.ts:334 › landing page contrast › footer + tagline (muted text) meet AA against the page background (3.0s)
  -  11 [chromium] › contrast.spec.ts:418 › admin room contrast › active mode-switcher label meets AA — FAILS on current main: accent-on-tinted-accent measures 4.37:1 …
  ✓  19 [chromium] › render-and-links.spec.ts:78 › landing renders create CTA + a working join-code input (2.6s)
  ✓  30 [chromium] › rooms.spec.ts:91 › landing join-by-code navigates into the room (2.6s)
  ✓  32-34 [chromium] › saved-rooms.spec.ts › created room appears / patron join remembers / ✕ forgets

  2 skipped
  32 passed (1.7m)
```

**Confirmed: the only 2 skips are the two pre-existing `test.fixme` blocks (`contrast.spec.ts:298` and `:418`), both owned by TICKET-66. Zero failures.**

> **False alarm worth recording.** My *first* e2e attempt reported `26 failed / 6 passed`, with failures spread across `/new`, `/[room]`, `/tv` and `/admin` specs that this diff does not touch. Cause was my own doing, not the branch: I had run `npm run build` immediately before, and `next dev` then booted on top of the production `.next` output. `rm -rf .next test-results` and re-running produced the clean 32/2 above, twice. The branch is not flaky.

---

## Point-by-point against the 10 required items

### 1. Tests — PASS
Re-ran all three myself; output above. 683/683 unit, build clean, 32 passed / 2 skipped e2e. The 2 skips are exactly the TICKET-66 `test.fixme` blocks. **No new AA contrast failure** (see item 7 for my own independent sweep, which is stricter than the spec).

### 2. All three locales complete — PASS
Checked programmatically, not by eye:

```
pt-BR 47 keys · en 47 · es 47 — key sets IDENTICAL
en  missing: []  extra: []
es  missing: []  extra: []
MISSING (used in page.tsx, absent from catalog): []
DEAD (in catalog, unused): savedAdmin, savedEnter, savedForget, savedHint, savedTitle, savedTv
```

The six "dead" keys are **not** dead — `components/SavedRooms.tsx:35` also consumes the `Landing` namespace (`savedTitle` :80, `savedHint` :88, `savedEnter` :140, `savedAdmin` :149, `savedTv` :156, `savedForget` :165). The removed `tagline` key has no remaining referent anywhere in `app/`, `components/`, `__tests__/` or `e2e/`. Zero hardcoded user-visible copy in `app/page.tsx` — all 41 strings resolve through `t(...)` / `t.rich(...)`, including the mock's fake queue rows. ES catalog read in full: idiomatic, no pt-BR leakage, no untranslated fragments.

### 3. Nothing regressed — PASS (verified in the running app, not by reading)
Driven against `http://127.0.0.1:3181` with an isolated Playwright context:

- **Join by raw code:** `"MEU-BAR-Teste"` → navigated to `/meu-bar-teste` (lower-casing preserved).
- **Join by pasted URL (`normalize()` path):** `"https://boraoke.app/Bar-Do-Ze?x=1"` → navigated to `/bar-do-ze`. Query string and origin correctly stripped. `normalize()` is byte-identical to base (`app/page.tsx:53-58`).
- **`cantai_last_room` quick-entry:** seeded the key, reloaded — `[data-testid="last-room-link"]` renders with `href="/sala-antiga"`, rect `{x:297.8, y:746.3, w:70.2, h:16}`. Storage key untouched (`app/page.tsx:48`).
- **`SavedRooms`:** all three `saved-rooms.spec.ts` tests pass (create → listed, patron join → remembered, ✕ → forgotten). Component untouched by the diff.
- **`LanguageSwitcher`:** present in the header, tab-reachable first; switching to EN flips the CTA to `"Start now — it's free"`. All 4 `language-switcher.spec.ts` tests pass.

### 4. Forbidden files / no new tokens — PASS
`git diff --name-only 8a93fdf...HEAD` filtered for `globals.css|components/tv/|FeedbackWidget|components/feedback/` → **empty**. Grep for added custom-property *declarations* (`^\+.*--x:`) in the diff → only two comment lines, zero real declarations. `page.module.css` consumes exactly `--accent, --bg, --border, --radius, --surface, --text, --text-muted`, all of which already exist in `app/globals.css`.

### 5. Honest marketing — PASS, with one MEDIUM
Cross-checked all three locales against `work/roadmap.md` and the code:

| Claim | Shipped? |
|---|---|
| "Everyone scans the QR … own phone" | Yes — QR join + table capture |
| "the TV plays the queue by itself" | Yes — `/tv` auto-advance |
| "on a fair rotation" / "Three modes — full karaoke, 2 per table, 1 per person" | Yes — and the copy uses the product's **actual** mode labels (`Modes.fullKaraokeName/perTableName/perPersonName` = "🎤 Karaokê completo / 🍻 2 por mesa / 🙋 1 por pessoa"). This is *more* accurate than the approved mockup, which said the looser "completo, duas por mesa, uma por pessoa". |
| "Search inside Boraoke or paste the link" | Yes — search + URL paste |
| "Plays in the official player, full screen" | Yes — `/tv` fullscreen |
| "No app, no sign-up" | Yes — anon-first |
| sing 🎤 / listen 🎧 in the mock rows | Yes — `modeSing`/`modeListen` |
| "pt-BR / EN / ES" footer | Yes — TICKET-30 |
| "Everything that exists today is free — and stays free" | Yes — verbatim the TL's standing promise, `work/roadmap.md:16` |

Nothing advertises accounts, theming presets, venue-type presets or payments. Host moderation/reorder/pause and analytics ship but are deliberately *not* advertised — under-promising, which is fine.

**MEDIUM-1 — the venue chips' "active" styling over-promises a selector that does not exist.** `app/page.module.css:84-87` renders "No bar" with `border-color: var(--accent); color: var(--accent)` while the other three are muted — the universal visual grammar of a *selected filter*. The elements are inert `<li>`s (`app/page.tsx:36-41`), so a visitor who clicks "Na festa" expecting per-venue behaviour gets nothing, and venue-type presets are roadmap item 32, **NOT STARTED**. Mitigating: the list's accessible name is `venuesLabel` = "Onde dá pra usar" / "Where it works", which correctly frames them as *where it works* rather than *what you pick*; and the chip-with-active-state is exactly what the TL approved in the mockup (`mockup-2-demo-vivo.html:95` uses the same `class="on"`), with the proposal explicitly calling them "ready to become real preset-switching chips in Phase 3". So this is a faithful rendering of an approved design, not an implementer invention. I do not think it blocks, but the affordance lie is real and worth a follow-up (e.g. drop the active state, or make the chips genuinely inert-looking, until item 32 lands).

### 6. Fidelity to the approved mockup — PASS
Structure is element-for-element faithful to `mockup-2-demo-vivo.html`: header (brand + free pill) → chips → split hero (h1/sub/CTA/microcopy left, stage right) → rotation tag → TV (now-playing + up-next rail) → overhanging QR phone card → 3 bullets with red top rules → join strip → free-promise footer. Copy matches the proposal's specified hook and CTA in all three languages.

Justified structural *additions*, both mandated by the ticket and absent from the static mockup: `LanguageSwitcher` in the header, and the `SavedRooms` card between bullets and join strip.

The three claimed deviations, judged individually:

1. **Accent text kept off `--surface`** (`page.module.css:229-242`) — **JUSTIFIED, and I verified the numbers rather than trusting them.** `#e63946` on `--surface` `#1a1a1a` = **4.18:1** (fails the 4.5:1 floor); on `--bg` `#0d0d0d` = **4.66:1** (passes). The dev report's 4.18/4.64 figures are correct to rounding. Filling the rotation tag with `--bg` is the only AA-clean option while `--accent-text` doesn't exist, and the follow-up to move it back once TICKET-66 lands is correctly recorded rather than silently dropped.
2. **Flat fills instead of gradients** (`page.module.css:142-154`) — **JUSTIFIED.** It makes every text node in the mock resolve to a real painted ancestor background, which is what lets the computed-contrast suite (and my own sweep) actually walk it. Visual cost is negligible; the approved screenshot's gradient was near-flat anyway.
3. **QR phone card nudged down/left** (`page.module.css:244-256`) — **JUSTIFIED, and an improvement on the mockup.** I compared the approved `direction-2-demo-vivo-desktop.png` against `work/evidence/TICKET-69/landing-desktop-1440x900.png` directly: the *mockup itself* occludes all four up-next titles behind the card ("…ande o Meu Amor por Você", "…panema", "…hapsody", "…ecer"). The shipped page fully clears row 1 and reduces rows 2-4 from ~70px to ~46px of occlusion. It is strictly better than what was approved. See MEDIUM-2 for the residual.

### 7. Accessibility — PASS
Measured live at 1440x900:

- Landmarks: `HEADER`, `MAIN`, `FOOTER` present, header/footer correctly outside `<main>` (`app/page.tsx:76, 84, 192`).
- Headings: exactly **one h1** ("A fila do karaokê na TV…"), then `H2` ×4 (three bullets + "Já tem um código?") plus SavedRooms' own h2. No skipped level, no h1 duplication — note the brand is now a `<div>` (`page.tsx:78`), which is right.
- **TV mock as `role="img"` + `aria-label` (`page.tsx:107`): I judge this the correct call.** The rows are *fictional* — "Ana · mesa 4", "Bohemian Rhapsody". Exposing them as a real `<ol>` would tell a screen-reader user there is a live queue with four songs in it, which is a lie in a way the sighted framing (a picture of a TV) is not. `demoAlt` describes the whole composition including the QR, the tables and the rotation tag, so nothing informational is lost. There is no interactive content inside the subtree, so `role="img"` swallows nothing usable.
- Keyboard: tab order is `LanguageSwitcher → CTA a[href="/new"] → join input → feedback widget`. CTA reachable in 2 tabs, focus style `outline: auto 1px rgb(0, 95, 204); outline-offset: 1px` — a real, visible ring (UA default, not suppressed).
- Chips list carries `aria-label="Onde dá pra usar"` (`page.tsx:87`).
- **Independent contrast sweep** (my own, stricter than the spec — every text-bearing node under `header/main/footer`, resolving each element's true painted ancestor background, with the correct large-text relief): exactly **two** sub-AA nodes, both `.btn-primary` white-on-`--accent` at **4.17:1** — the CTA and the join "Entrar" button. That is the *existing* token pair TICKET-66 owns (it is literally what `contrast.spec.ts:298`'s fixme documents), it applied identically to the old landing, and this page inherits the fix automatically because it reuses the global `.btn-primary` class. **No new AA failure introduced.**

NITs: `<em>` in the h1 (`page.tsx:94`) carries semantic emphasis for what is purely a colour highlight — carried over from the mockup, harmless. The `.joinStrip` `<section>` has no accessible name so it is not exposed as a landmark region — also harmless.

### 8. Responsiveness / overflow — PASS
Measured myself, not copied from the tester:

| Viewport | `scrollWidth` | `innerWidth` | Overflow | CTA `rect.bottom` | Above fold |
|---|---|---|---|---|---|
| 1440x900 | 1440 | 1440 | No | **437.27** | Yes |
| 390x844 | 390 | 390 | No | **455.67** | Yes |
| 320x800 | 320 | 320 | No | 475.67 | Yes (not required, but clean) |

Matches the App Tester's numbers to the pixel. I viewed `work/evidence/TICKET-69/landing-desktop-1440x900.png` and `landing-mobile-390x844.png` myself, plus both approved mockup screenshots.

### 9. The mock is static — PASS
`app/page.tsx` contains **zero** occurrences of `fetch`, `iframe`, `setInterval`, `setTimeout`, `youtube`, `googleapis`, `EventSource` or `WebSocket` outside the doc comment. Live confirmation at all three viewports: `document.querySelectorAll('iframe').length === 0`, and a full request log per navigation shows **zero** off-origin requests — not one call to `youtube.com`, `googleapis.com` or `ytimg`. Everything loaded is same-origin Next assets. The QR is an inline `<svg>` `<path>`, not an image fetch.

### 10. Spec edits are legitimate — PASS
Both edits are honest and narrow.

- `e2e/render-and-links.spec.ts:78-85` — updates the CTA locator from the retired copy `/criar a sala do seu bar/i` to `/começar agora/i` **and adds** `await expect(createCta).toHaveAttribute("href", "/new")`. That is a *strengthening*: the old test only asserted visibility, the new one also pins the target. Not a weakening to hide a failure.
- `e2e/contrast.spec.ts:298-307` — the same stale locator inside the **still-skipped** `test.fixme`. The `test.fixme` wrapper, its title and its FINDING comment are untouched; only the selector changed, so that when TICKET-66 unskips it, it targets a real element instead of dead copy. Nothing was newly skipped, and nothing that was passing was made to stop running.
- Diffstat confirms **only these two spec files** changed. No TV, host-control, advance-auth or admin spec touched.

---

## Findings, severity-ranked

### ~~BLOCKING-1~~ (RESOLVED during review — see addendum) — the working tree was dirty; the branch as committed was not what was on disk
`git status --short` in the review worktree, *during* this review:

```
 M app/page.module.css
 M app/page.tsx
 M work/reports/dev/TICKET-69-dev-report.md
```

HEAD also advanced from `2c94753` to `5a1d6c7` between the start and the middle of my pass. The uncommitted delta adds a `.lastRoomLink` rule (`app/page.module.css:363-379`) plus its `className` (`app/page.tsx:184-188`):

```css
.lastRoomLink { color: var(--accent-text); text-decoration: underline; }
```

I have **no objection to the change itself** — it is a sensible fix for the one accent-as-text miss I independently found (the last-room quick-entry link, which on committed HEAD takes the global `a { color: var(--accent) }` and lands at **4.18:1 on `--surface`**; that ratio is *pre-existing*, identical to the old landing's inline `color: var(--accent)`, so it is not a regression this ticket caused). Referencing `--accent-text` without defining it degrades correctly: while TICKET-66/PR #49 is unmerged the declaration is invalid at computed-value time and the link inherits `.lastRoom`'s `--text-muted` (**4.91:1** on `--surface` — I measured `rgb(136,136,136)` on `rgb(26,26,26)` live), and the `text-decoration: underline` preserves the link affordance that colour alone would otherwise carry. AA-clean in both states, and it never redefines a token in a file this ticket must not touch.

The problem is purely process: **none of the gate output above covers those edits.** My `npm test` / `npm run build` / e2e runs and the App Tester's committed evidence all predate them, and a reviewer cannot certify uncommitted code. Commit the delta and re-run the gate chain (at minimum `e2e/contrast.spec.ts` + `render-and-links.spec.ts`), or revert it and file it as the follow-up the CSS comment already describes. Either resolution clears this; it is the only thing standing between this branch and APPROVE.

### MEDIUM-1 — venue chips' active styling implies a venue selector that does not ship
`app/page.module.css:84-87` + `app/page.tsx:36-41`. Full reasoning in item 5. Faithful to the TL-approved mockup, so not the implementer's call to reverse — but worth a follow-up before launch, since roadmap item 32 (venue types) is NOT STARTED.

### MEDIUM-2 — the phone card still occludes the leading word of 3 of 4 up-next titles at 1440x900
`app/page.module.css:244-256` (`.phone { bottom: -4.75rem; left: -3rem; width: 138px }`). In `work/evidence/TICKET-69/landing-desktop-1440x900.png` the rail reads "de Ipanema", "…an Rhapsody", "…contecer". The App Tester measured 45.8px of overlap on rows 2-4 and flagged it as a residual; I confirm it visually. This matters more than usual because this direction's entire premise is *the visitor sees the queue*.

I am **not** blocking on it, for a reason the implementer's report understates: the approved mockup is **worse** — it occludes all four rows including row 1. The shipped page is a strict improvement over the artefact the TL signed off. A further ~3rem of `.phone { left }` (or trimming its width) would clear all four; that is a one-line follow-up, not a rework.

### MEDIUM-3 — the new landing's own text is largely outside the contrast suite's coverage
`e2e/contrast.spec.ts:281-337` still asserts only the h1, the join-section h2, the join input and the footer span. The page gained ~20 new text styles (chips, early-access pill, rotation tag, `nowLabel`, `railLabel`, `.who` on the striped rail, the phone caption at 0.68rem) and none are pinned. I swept them all by hand this pass and they pass — `.who` on the odd-row `#211a1b` fill computes 4.67:1, the tightest of the new pairs, with only 0.17 of headroom. Nothing is failing today, but a future token change could silently break it. The ticket's AC was "no *new* AA failure", which is met, so this is a follow-up rather than scope I am demanding here.

### NIT-1 — `landing-desktop-1440x900.png` is captured in English, not pt-BR
The filename and the App Tester's index entry describe it as the plain `/` capture, but the committed image renders the EN catalog (Playwright's default `en-US` Accept-Language resolving through the TICKET-30 detection path), while `landing-desktop-en.png` exists separately for the same purpose. Net effect: there is no committed pt-BR desktop full-page evidence. Product behaviour is correct; only the evidence labelling is off.

### NIT-2 — stale test title
`e2e/contrast.spec.ts:281` is still named "…h1 brand heading" and `:334` "footer + tagline", but the h1 is now the hero hook and `tagline` no longer exists as a key. The assertions are correct; only the names have rotted.

### NIT-3 — `<em>` for a purely visual highlight
`app/page.tsx:94` / `page.module.css:106-109` (`font-style: normal; color: var(--accent)`). Screen readers may announce emphasis that is not semantically intended. Inherited from the mockup.

---

## Two claims in the incoming reports I checked and can confirm

- The dev report's e2e block (32 passed / 2 skipped, with the two named fixmes) reproduces **exactly** on a clean `.next`. Its 4.18/4.64 contrast arithmetic is right.
- The App Tester's overflow and CTA-fold table reproduces to the pixel (437.27 / 455.67). Its self-flagged residual on up-next legibility is real and honestly stated — it did not paper over its own finding, which is the right behaviour.

## Recommendation

**Merge.** File MEDIUM-1, MEDIUM-2 and MEDIUM-3 as follow-ups; MEDIUM-2 in particular is a one-line CSS nudge that would fully deliver the direction's core promise.

---

## Addendum — BLOCKING-1 resolved

While I was writing this report the implementer committed the pending delta as **`914bc9e` "TICKET-69: route the last-room link through --accent-text (from TICKET-66)"** (+ its event-log commit `bdb591a`), covering `app/page.module.css`, `app/page.tsx` and `work/reports/dev/TICKET-69-dev-report.md`. `git status --short` is now clean.

I verified the committed hunks are **byte-identical** to the working-tree edit I had already measured live (the `.lastRoomLink { color: var(--accent-text); text-decoration: underline }` rule plus its `className`), so my substantive assessment of that change in BLOCKING-1 carries over unchanged: AA-clean in both the pre- and post-TICKET-66 states (4.91:1 muted fallback today, 5.21:1 once `--accent-text` lands), affordance preserved by the underline, no token redefined in a file this ticket may not touch.

The only thing outstanding was that no gate had run against it. I re-ran them on a clean `.next` at HEAD `914bc9e`:

```
Test Suites: 43 passed, 43 total
Tests:       683 passed, 683 total
Ran all test suites.

  ✓  26 render-and-links.spec.ts:152 › /[room]/admin: login → controls + mode switcher + customer-screen links (4.2s)
  ✓  28 render-and-links.spec.ts:211 › link-crawler: landing, /new, and a live room's pages have no 404 links (11.9s)
  ✓  30 rooms.spec.ts:91 › landing join-by-code navigates into the room (6.4s)
  ✓  32 saved-rooms.spec.ts:39 › a created room appears under Suas salas with working links (5.2s)
  ✓  33 saved-rooms.spec.ts:61 › joining a room as a patron remembers it (joined role) (7.2s)
  ✓  34 saved-rooms.spec.ts:82 › the ✕ control forgets a room (4.9s)

  2 skipped
  32 passed (3.0m)
```

Same result as the main pass: 683/683 unit, 32 passed / 2 skipped e2e, the 2 skips still exactly the two TICKET-66 `test.fixme` blocks. **BLOCKING-1 is cleared and the branch is merge-ready**, subject only to the three MEDIUM follow-ups above.

Process note for the TM, not a defect in the work: a branch under formal review moved twice under the reviewer (HEAD `2c94753` → `5a1d6c7` → `914bc9e`, with an uncommitted window in between). It worked out here because the change was small, correct, and I could re-derive it — but a review verdict is only meaningful against a frozen commit, and the next one may not be so cheap to re-verify.

---

# Delta re-review

Scope: only what is new since `914bc9e` — three changes (the contrast-coverage commit, the `origin/main` merge, the token-role commit). Everything I signed off in the main pass above I did not re-derive, except where the new base could have invalidated it. Same worktree, PORT=3181.

**Final verdict: APPROVE.**

## New commits reviewed

```
4c1e8df chore(events) …
f7a5dd1 TICKET-69: route accent-as-text onto --accent-text now that TICKET-66 is on main
5a3e89d chore(events) …
25b97fc review(TICKET-69): resolve BLOCKING-1 …            ← my own
f46c90b Merge remote-tracking branch 'origin/main' into ticket/69-landing-demo-vivo
faf293b chore(events) …
152a859 TICKET-69: pin the new landing's text styles in the contrast suite
118ad06 TICKET-66: split the accent token by role … (#49)  ← arrived via the merge
```

Branch scope vs the new `origin/main` is exactly the 7 files this ticket owns — `app/page.module.css`, `app/page.tsx`, `e2e/contrast.spec.ts`, `e2e/render-and-links.spec.ts` and the three `messages/*.json`. Nothing else.

## Gate output I observed

```
Test Suites: 43 passed, 43 total
Tests:       683 passed, 683 total

npm run build →  ✓ Compiled successfully in 5.1s

rm -rf .next && PORT=3181 npx playwright test   (WHOLE suite)
  66 passed (2.9m)
```

**66 passed, 0 failed, 0 skipped** — reproduces the TM's number exactly. i18n parity re-checked on the new base: pt-BR / en / es all 47 `Landing` keys, identical sets, 41 used in `page.tsx`, none missing.

> **My own false alarm, recorded because it is the same trap twice.** My first attempt at the full suite reported `5 failed / 61 passed` (2 × `advance-auth`, 3 × patron/admin `contrast`). Self-inflicted: I ran `npm run build` immediately *before* the suite, so `next dev` booted on top of the production `.next` — the exact failure mode I flagged in the main pass, which I then walked into myself. A second attempt died on `EADDRINUSE :::3181` from a leftover server. With a killed port and `rm -rf .next` it is 66/66. **Recommended house habit: never `npm run build` in the same breath as `npx playwright test`, and free the port first.**

## 1. MEDIUM-3 closed — assertions are real, with one precise gap

I resolved all 19 new locators myself and dumped the true computed paint each one measures. Every locator resolves to **exactly one** element, and to the *intended* element (no silent parent-walk). Ratios (pt-BR, 1440x900):

| Node | fg on bg | px/weight | ratio | floor |
|---|---|---|---|---|
| early-access pill | `238,90,100` on `13,13,13` | 11.5/700 | 5.81 | 4.5 |
| active venue chip | `238,90,100` on `13,13,13` | 13.1/600 | 5.81 | 4.5 |
| inactive venue chip | `136,136,136` on `13,13,13` | 13.1/600 | 5.48 | 4.5 |
| hero h1 | `241,241,241` on `13,13,13` | 41.6/700 | 17.21 | 3 |
| hero h1 accent span | `238,90,100` on `13,13,13` | 41.6/700 | 5.81 | 3 |
| hero sub-copy | `136,136,136` on `13,13,13` | 16.8/400 | 5.48 | 4.5 |
| CTA microcopy | `136,136,136` on `13,13,13` | 13.6/400 | 5.48 | 4.5 |
| rotation tag | `238,90,100` on `13,13,13` | 11.5/700 | 5.81 | 4.5 |
| now-playing label | `238,90,100` on `20,13,14` | 10.9/800 | 5.74 | 4.5 |
| now-playing title | `241,241,241` on `20,13,14` | 16.8/700 | 17.00 | 4.5 |
| now-playing meta | `136,136,136` on `20,13,14` | 13.1/400 | 5.42 | 4.5 |
| up-next label | `136,136,136` on `20,13,14` | 10.9/800 | 5.42 | 4.5 |
| **up-next `who` on STRIPED row** | `136,136,136` on `33,26,27` | 13.6/400 | **4.82** | 4.5 |
| up-next title on flat row | `241,241,241` on `20,13,14` | 13.6/400 | 17.00 | 4.5 |
| phone caption heading | `241,241,241` on `26,26,26` | 12/700 | 15.41 | 4.5 |
| bullet heading | `241,241,241` on `13,13,13` | 16/700 | 17.21 | 4.5 |
| bullet body | `136,136,136` on `13,13,13` | 14.1/400 | 5.48 | 4.5 |
| footer span 1 (free promise) | `238,90,100` on `13,13,13` | 12.5/600 | 5.81 | 4.5 |
| footer span 2 (muted) | `136,136,136` on `13,13,13` | 12.5/400 | 5.48 | 4.5 |

Not tautological: the helper (`assertAA` / `computeContrast` / `inPageContrast`) is **unchanged by this branch** — I diffed it against `origin/main` and only call-sites moved, no threshold and no resolution logic. The suite's own three "contrast math sanity" tests still prove the helper (21:1 canonical max, ~1:1 on the known-bad pair, correct ancestor-walk on a transparent background). The striped-row pair the commit calls "tightest" genuinely is the tightest new one at 4.82:1 — my hand-sweep had estimated 4.67, so the commit's claim is honest and my earlier estimate was the conservative one. Coverage matches what I swept.

**MEDIUM-4 (new, follow-up) — the one accent node where the token split is actually load-bearing is the one node not asserted.** I ran a negative control: forcing `--accent-text` back to `--accent` and re-measuring. **All 17 new assertions still pass** (pill/chip/tag/em/footer drop only 5.81 → 4.66, still over the floor). That is not a defect in the tests — it is a property of the page: every accent-as-text node here sits on `--bg`, where *both* tokens clear AA. So the new coverage guards backgrounds and the muted token, but it does **not** guard the accent-text split on this page.

The single exception is `.lastRoomLink` (`app/page.module.css:381-384`), the only accent-as-text node on the `--surface` join strip. Measured under both states:

```
normal (--accent-text live)          PASS 5.21:1  fg rgb(238,90,100) on rgb(26,26,26)  13.6px/400  underline
REGRESSED (--accent-text := --accent) FAIL 4.18:1  fg rgb(230,57,70)  on rgb(26,26,26)  13.6px/400  underline
```

Exactly the 5.21 / 4.18 the code comment claims — verified, not taken on faith. That node is the one the new test block does not cover (it needs `cantai_last_room` seeded first). One extra assertion that seeds localStorage would make the coverage genuinely regression-proof. Not blocking: the value is correct today and the underline means it is not colour-alone identifiable even if the colour regressed.

Two smaller uncovered nodes, both fine today: `.phone p` body copy (0.68rem `--text-muted` on `--surface`) and `.joinHint`.

## 2. Merge is clean in both directions — including the one collision that mattered

`f46c90b` is a true merge (parents `faf293b` + `118ad06`), no rebase, no force-push. I checked both sides rather than trusting "clean":

- **vs the main side (`118ad06`):** the only deletions in `contrast.spec.ts` are the five landing lines TICKET-69 legitimately replaced (two retitles, the stale `/criar a sala do seu bar/i` locator, the single-span footer assertion that became two). **Nothing from TICKET-66 was dropped** — its two new latent-C3 tests, its rewritten FINDING comments and its unskips are all present.
- **vs the branch side (`faf293b`):** the only changes are TICKET-66's. **Nothing from TICKET-69 was dropped** — the 17-assertion Direction-2 block is intact.
- `components/SavedRooms.tsx` is byte-identical to `origin/main` (TICKET-66 owns it; the branch carries its version verbatim, not a stale copy).

**The collision worth naming:** TICKET-66 unskipped the CTA `test.fixme` while TICKET-69 renamed that very CTA. A merge that took main's side wholesale would have produced a newly-*live* test pointing at dead copy (`/criar a sala do seu bar/i`) and a red suite. The resolution took **both** — TICKET-66's `test(` + its new `--accent-strong` rationale, wrapped around TICKET-69's `/começar agora/i` locator. That is the correct outcome and it is why the suite is green.

**Both ex-fixmes are live and passing:** `grep -rn "test.fixme(" e2e/` returns **nothing** — zero skips remain anywhere in the suite, consistent with the 66/0/0 run. The former CTA fixme now asserts against this landing's CTA and passes on `--accent-strong` (#fff on #d92330).

## 3. Token roles are correct

Verified against the definitions TICKET-66 landed in `globals.css:14-17`, which document `--accent` as "borders, focus rings, non-text UI, large text" and `--accent-text` as "accent used AS text on dark surfaces".

- `--accent` survives at exactly four sites, **all non-text**: pill border (`:63`), chip border-color (`:90`), rotation-tag border (`:242`), bullet `border-top` (`:300`).
- `--accent-text` at seven sites, **all text**: pill label (`:62`), active chip (`:91`), h1 `em` (`:113`), now-playing label (`:186`), rotation-tag label (`:243`), last-room link (`:382`), free promise (`:396`).
- `--accent-strong` is never referenced directly; it reaches the CTA through the global `.btn-primary`, which this module overrides for layout only. Correct — that is what keeps the CTA on the token TICKET-66 fixed.
- `f7a5dd1` is surgical: six `color: var(--accent)` → `var(--accent-text)`, zero border changes.

`app/page.module.css` defines **zero** custom properties (grep for `^\s*--x:` → empty). `app/globals.css` is **byte-identical to `origin/main`** (`git diff origin/main -- app/globals.css` → empty), as are `components/tv/**`, `components/FeedbackWidget.tsx` and `components/feedback/**`.

I also re-derived the arithmetic in the new comments rather than trusting it — all three are exact: `--accent-strong` #d92330 under #fff = **4.96:1**; `--accent-text` #ee5a64 on `--surface` = **5.21:1**; on `--bg` = **5.81:1**.

### NIT-4 — the h1 highlight is now stricter than the token doc requires
`app/page.module.css:113`. The `em` is 41.6px/700 — unambiguously large text, where `--accent` is explicitly permitted. Moving it to `--accent-text` is defensible (one rule: accent text always uses the text token) but it does lighten the hero highlight from #e63946 to #ee5a64 versus the approved mockup. Deliberate, consistent, and cosmetically minor — flagging only so the visual shift is a decision on record rather than a side effect.

### NIT-5 — a recorded follow-up was closed by re-justification, not by doing it
The main pass recorded "once `--accent-text` exists, the rotation tag can move back to a `--surface` fill". `--accent-text` now exists, and the tag **stayed** on `--bg` — but the comment (`:237-240`) was honestly rewritten from an AA constraint to a design rationale ("reads as a tag lifted off the TV", plus 5.81 vs 5.21 headroom). I have no objection to the call; I flag it because it turns a temporary, constraint-driven deviation from the approved mockup into a permanent, taste-driven one. Worth the TM knowing it is now a design decision, not a leftover.

## Item-by-item on the three delta questions

1. **Contrast assertions real and covering what I swept** — **YES**, with MEDIUM-4 as the one precise gap (the load-bearing `.lastRoomLink` is unasserted; the other 17 would survive a token regression because they sit on `--bg`). Helper untouched, no threshold loosened, no test newly skipped.
2. **Merge dropped nothing from either side; both fixmes live and passing** — **CONFIRMED**, both directions diffed, the CTA-rename/unskip collision resolved correctly, zero `test.fixme` left, 66/66 green.
3. **Token split correct, zero custom properties, `globals.css` untouched** — **CONFIRMED**, all three, with the comment arithmetic independently re-derived.

Evidence PNGs deliberately not judged — the App Tester is re-capturing them on the new base (I see `work/evidence/TICKET-69/landing-desktop-1440x900.png` modified in the tree as I write).

**Nothing here blocks. Verdict: APPROVE.** Carry forward MEDIUM-1 (venue-chip active styling), MEDIUM-2 (phone card occluding up-next titles), and add MEDIUM-4 (assert the last-room link's contrast) as follow-ups.
