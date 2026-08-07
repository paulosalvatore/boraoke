# TICKET-69 — Dev report: landing rebuild, Direction 2 "Demo vivo"

**Branch:** `ticket/69-landing-demo-vivo` (worktree `.worktrees/ticket-69`, cut from `origin/main` @ `8a93fdf`)
**Spec:** `work/design/landing-rethink/PROPOSAL.md` §"Direction 2 — Demo vivo" · **Visual target:** `work/design/landing-rethink/mockup-2-demo-vivo.html` + `screenshots/direction-2-demo-vivo-{desktop,mobile}.png`

## What changed

| File | Change |
|---|---|
| `app/page.tsx` | Rewritten to the Direction-2 structure. All copy via `next-intl` `Landing`. |
| `app/page.module.css` | NEW — ported from the approved mockup, using only tokens that exist today. |
| `messages/pt-BR.json` · `en.json` · `es.json` | 33 new `Landing` keys; `createCta` + `footer` rewritten; `tagline` removed (superseded by `heroTitle` / `heroSub`). Key sets identical across all three. |
| `e2e/render-and-links.spec.ts` | The landing CTA assertion pinned the OLD copy (`/criar a sala do seu bar/i`). Updated to the new CTA and additionally asserts `href="/new"`. |
| `e2e/contrast.spec.ts` | Same stale CTA locator inside the existing `test.fixme` block (still skipped — TICKET-66 owns unskipping it). Locator updated so it targets a real element when it is unskipped. |

No other spec touched. `app/globals.css`, `components/tv/**`, `components/FeedbackWidget.tsx` and `components/feedback/**` are untouched (sibling tickets own them).

## Structure delivered

header (brand · "Grátis · acesso antecipado" pill · `LanguageSwitcher`) → venue chips (No bar / Na festa / No condomínio / Na empresa) → split hero (h1 + sub + CTA + microcopy left · static TV mock with rotation tag and overhanging QR phone card right) → three bullets (QR sem app / qualquer música do YouTube / rodízio justo) → `SavedRooms` → compact join-by-code strip → free-promise footer.

## Acceptance criteria

- **No regression.** Join-by-code input (same `normalize()` + `router.push` logic, unchanged), `SavedRooms` (TICKET-43 recovery card, same slot), `LanguageSwitcher` (moved into the header) and the `last-room-link` quick-entry all survive. `cantai_last_room` storage key untouched.
- **One click to create.** The CTA is a `Link href="/new"`, measured above the fold at both widths (see App Tester report).
- **Trilingual.** Zero hardcoded copy in `app/page.tsx` — every string, including the demo mock's fake queue rows, goes through the `Landing` catalog. `__tests__/i18n-completeness.test.ts` enforces identical key sets + ICU placeholders across pt-BR/en/es and passes.
- **Honest marketing.** Advertised: QR join + tables, YouTube search *and* URL paste, `/tv` playback, the three rotation modes named exactly as the product names them (`Modes.fullKaraokeName` / `perTableName` / `perPersonName`), sing vs listen (shown in the mock rows), three languages (footer). NOT advertised: accounts, theming, per-venue presets, payments. The venue chips are inert `<li>`s that widen the framing without promising per-venue behaviour.
- **Responsive**, single-column below 860px; verified at 1440/390/320 by the App Tester with `scrollWidth` vs `innerWidth`.
- **Static mock.** No `<iframe>`, no `fetch`, no polling anywhere in the landing — the mock is pure markup + one inline SVG.
- **Accessible.** `<header>` / `<main>` / `<footer>` landmarks; single `h1` (the hook) then `h2`s (bullets, join strip, SavedRooms); the TV mock is exposed as one labelled image (`role="img"` + `aria-label={t("demoAlt")}`) rather than a wall of fake queue rows; the CTA is a real link with the default focus ring; the chips list carries `aria-label={t("venuesLabel")}`.

## Deliberate deviations from the mockup (both accessibility-driven)

1. The mockup uses `--accent-strong` / `--accent-text`, which **do not exist on this branch** (TICKET-66 adds them to `globals.css`, which this ticket must not touch). Everything therefore uses today's tokens, and accent-coloured **text** only ever sits on `--bg` (`#e63946` on `#0d0d0d` = 4.64:1, AA-clean) and never on `--surface` (4.18:1, a fail). That is why the rotation tag is filled with `--bg` instead of the mockup's `--surface`. Buttons keep the **global** `.btn-primary` class for colour — the module only overrides layout — so whatever TICKET-66 lands applies here automatically. **Follow-up:** once `--accent-text` exists, the rotation tag can move back onto a `--surface` fill.
2. The TV screen uses flat fills instead of the mockup's gradients, so `e2e/contrast.spec.ts` can resolve a real painted background for every text node inside the mock.
3. The QR phone card sits slightly lower/further left than the mockup (`bottom: -4.75rem; left: -3rem`), because at the mockup's exact offset it hid the first ~70px of all four up-next titles — and this direction's entire premise is that the visitor *sees* the queue.

## Verification — real observed output

### `npm test` (jest)
```
Test Suites: 43 passed, 43 total
Tests:       683 passed, 683 total
Snapshots:   0 total
Time:        2.023 s
```
(includes `__tests__/i18n-completeness.test.ts` — no missing keys, no extra keys, matching ICU placeholders for en and es.)

### `npm run build`
```
 ✓ Compiled successfully in 1102ms
Route (app)                                 Size  First Load JS
…
├ ƒ /new                                  3.5 kB         130 kB
└ ƒ /tv                                    176 B         103 kB
+ First Load JS shared by all             102 kB
```
No errors. (One pre-existing workspace-root inference warning from Next, unrelated to this change.)

### `npx tsc --noEmit`
Repo-wide `tsc --noEmit` reports **pre-existing** errors only, all of them in `__tests__/**` (`Cannot find name 'it'/'expect'/'jest'` — `@types/jest` is not a devDependency) and one in `e2e/advance-auth.spec.ts`. **Zero** errors in `app/`, `components/`, `lib/` or `messages/`, and zero in either spec this ticket edited:
```
$ npx tsc --noEmit 2>&1 | grep -E "^(app|components|lib|messages)/"
(no output)
$ npx tsc --noEmit 2>&1 | grep -E "e2e/(render-and-links|contrast)"
(no output)
```
`tsc --noEmit` is not a package script here; the typecheck that gates the product code is `npm run build`, which is clean.

### `PORT=3181 npx playwright test e2e/contrast.spec.ts e2e/render-and-links.spec.ts e2e/rooms.spec.ts e2e/saved-rooms.spec.ts e2e/language-switcher.spec.ts`
```
  ✓   4 [chromium] › contrast.spec.ts:281 › landing page contrast › heading and join-by-code section heading meet AA (2.6s)
  -   5 [chromium] › contrast.spec.ts:298 › landing page contrast › create-room CTA button text meets AA — FAILS on current main … (skipped, test.fixme — TICKET-66)
  ✓   6 [chromium] › contrast.spec.ts:310 › landing page contrast › join-code input: typed text is legible against its OWN fill, not the card behind it (2.6s)
  ✓   7 [chromium] › contrast.spec.ts:334 › landing page contrast › footer + tagline (muted text) meet AA against the page background (2.8s)
  ✓  19 [chromium] › render-and-links.spec.ts:78 › landing renders create CTA + a working join-code input (2.5s)
  ✓  28 [chromium] › render-and-links.spec.ts:211 › link-crawler: landing, /new, and a live room's pages have no 404 links (6.1s)
  ✓  30 [chromium] › rooms.spec.ts:91 › landing join-by-code navigates into the room (2.5s)
  ✓  32 [chromium] › saved-rooms.spec.ts:39 › a created room appears under Suas salas with working links (2.4s)
  ✓  33 [chromium] › saved-rooms.spec.ts:61 › joining a room as a patron remembers it (joined role) (3.2s)
  ✓  34 [chromium] › saved-rooms.spec.ts:82 › the ✕ control forgets a room (2.8s)

  2 skipped
  32 passed (1.7m)
```
Both skips are the two pre-existing `test.fixme` blocks owned by TICKET-66 (white-on-accent CTA 4.17:1, mode-switcher label 4.37:1). **No new AA failure introduced** — every non-skipped contrast assertion passes on the new page.

## Addendum — `last-room-link` accent-as-text fix (handed over from TICKET-66 / PR #49)

The TICKET-66 agent swept every accent call site and flagged one it could not fix because this ticket owns the file: the `last-room-link` ("Última sala: …"), `#e63946` as normal-size text = **4.18:1**, the last accent-as-text miss in the codebase.

**The link survived the rebuild** (it is still the returning-patron quick entry inside the join strip), so the fix was needed and is applied:

- `app/page.tsx` — the link now carries `className={styles.lastRoomLink}`. (The rebuild had already dropped the old inline `color: var(--accent)`, but it was still inheriting the same failing colour from the global `a { color: var(--accent) }` rule, so the defect genuinely survived.)
- `app/page.module.css` — new `.lastRoomLink { color: var(--accent-text); text-decoration: underline; }`.

`--accent-text` is **referenced, never redefined** — it belongs to `app/globals.css`, which PR #49 owns and this branch does not touch. Verified: this branch defines **zero** CSS custom properties (`grep -n "^\s*--" app/page.module.css` → no output).

**Ordering is safe in both directions.** PR #49 is still OPEN at time of writing, so on this branch the var is unresolved, the declaration is invalid at computed-value time, and the link inherits `.lastRoom`'s `--text-muted` (#888 = **4.91:1** on `--surface`) — AA-clean. Once #49 merges it renders `#ee5a64` = **5.21:1**. It is never the failing 4.18:1 accent in either state. The added underline means the link is not identified by colour alone in either state.

Re-verified after this change: `npm run build` → `✓ Compiled successfully in 4.5s`; `PORT=3181 npx playwright test e2e/contrast.spec.ts e2e/render-and-links.spec.ts e2e/rooms.spec.ts e2e/saved-rooms.spec.ts` → `2 skipped, 28 passed (1.8m)` (the 2 skips remain the pre-existing TICKET-66 `test.fixme` blocks).

**Related, not done here (cheap follow-up once #49 is on main):** the accent-as-text sites this page introduces all pass AA today against `--bg` but with thin margin — `.nowLabel` 4.58:1 (on the mock's `#140d0e` screen fill), `.rotationTag` / `.chipOn` / `.pill` / `.freePromise` / `h1 em` 4.64:1 (on `--bg`). Moving them to `--accent-text` after #49 lands would take each to ~5.8:1. Deliberately not done on this branch, because pre-#49 they would degrade to an inherited colour and visibly lose the brand red.

## Out of scope / known, deliberately not fixed here

- The mobile `FeedbackWidget` bubble overlaps the hero's QR phone card at 390px. `components/FeedbackWidget.tsx` belongs to sibling **TICKET-71** (mobile feedback overlap) — untouched by design.
- White-on-accent CTA contrast (4.17:1) is **TICKET-66**'s token fix; this page uses the global `.btn-primary` so it inherits that fix on merge, in either merge order.
- A 401 from `SavedRooms`' host-session probe once a saved room exists is pre-existing behaviour of that component (expired-cookie routing), not introduced here.
