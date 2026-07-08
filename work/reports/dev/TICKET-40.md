# TICKET-40 — Dev Report: patron search UX

Status: IMPLEMENTED + VERIFIED — all local CI gates green; opening draft PR
Branch: `ticket/40-search-ux` · Worktree: `.worktrees/ticket-40` · App/e2e port: 3040
Repo: paulosalvatore/boraoke

## Scope delivered
1. **Select → jump to add-to-queue CTA** — after a result is picked or a pasted link resolves, the patron is scrolled to and the "Add to queue" button is focused (no auto-submit).
2. **Mode-aware search keyword** — sing mode appends `karaoke` to the query client-side; listen/dance searches raw; mode-switch re-runs the search; already-typed karaoke not doubled; pasted links never touched.
3. **Tests** — 15 unit tests for the augmentation logic; 2 new e2e tests (focus-jump + sing-mode karaoke query at the API-call level).

## Design decisions
- **Client-side query augmentation (vs server-side).** New `lib/search-query.ts#augmentQuery(query, mode)` runs in `SongSearch.runSearch` BEFORE calling `/api/search`. Rationale: the existing cache/rate-limit layer is keyed on the query string, so the augmented text becomes the cache key naturally — sing and listen searches for the same raw words land on distinct, coherent cache entries with ZERO server changes. Server-side would have forced the cache key to also include mode/keyword (cross-mode cache poisoning risk). Documented in the module header.
- **Mode switch after results shown → re-run the search.** `runSearch` now depends on `mode`, so changing the mode select recreates the callback and re-fires the debounced search effect with the newly-augmented query. Cheapest honest behavior: results always match the active mode (no stale-results flag needed).
- **Focus jump timing.** `onSongChosen` fires from `SongSearch` on both pick and paste-resolve; the parent defers the scroll+focus one `requestAnimationFrame` so the CTA (which only enables once `parsedVideoId` is set) has re-rendered. Uses `scrollIntoView({ block: "center", behavior: "smooth" })` (centers the CTA above the mobile keyboard fold) + `.focus({ preventScroll: true })` (no competing second scroll). Never auto-submits.
- **Already-contains-karaoke check is whole-word, case-insensitive** (`/\bkaraoke\b/i`). "karaokestar" still gets augmented (substring, not the word); the accented Portuguese "karaokê" is NOT treated as already-present (distinct string) — acceptable, the keyword we inject is the ASCII "karaoke" that YouTube search matches.

## Files touched
- `lib/search-query.ts` (new) — `augmentQuery`, `containsKaraoke`.
- `components/SongSearch.tsx` — new `mode` + `onSongChosen` props; augment query in `runSearch`; fire `onSongChosen` on pick + paste-resolve.
- `app/(patron)/[room]/PatronRoom.tsx` — pass `mode`/`onSongChosen`; `submitBtnRef`; `handleSongChosen` scroll+focus.
- `__tests__/search-query.test.ts` (new) — 15 unit tests.
- `e2e/search.spec.ts` — +2 e2e tests.
- `work/tickets/TICKET-40-search-ux.md` (new).

## Self-verification (all four CI gates run locally against the worktree)
- **Unit** `npm test` (jest) → **369 passed / 369 total, 25 suites** (baseline 354 + 15 new search-query tests).
- **Build** `npm run build` → success (lint + typecheck + compile green).
- **Rotation engine** `node --test` (working-dir `packages/rotation-engine`) → **59 passed / 0 failed**.
- **E2E** `PORT=3040 npx playwright test` → **30 passed** (baseline 28 + 2 new: focus-jump §1, sing-mode karaoke query §2). search.spec alone re-run green (4/4).
- Evidence (mobile 390px, mocked search): `work/evidence/ticket-40/01-sing-mode-results-390px.png`, `02-cta-focused-after-select-390px.png`, `03-listen-mode-results-390px.png`. Capture confirmed sing query = `"evidencias karaoke"` and `document.activeElement` = the Add-to-queue CTA after select.
- Note: `tsc --noEmit` from repo root shows PRE-EXISTING errors in `__tests__/*.test.ts` (jest globals not in the app tsconfig include path) — not introduced here; the Next build uses the correct tsconfig and is green. This repo has no framework `verify-green-local.sh`; CI is GitHub Actions (`ci.yml`) whose four gates are all reproduced green above.

## Implementation log
- `e021689` — impl (`lib/search-query.ts`, `SongSearch`, `PatronRoom`) + unit tests + e2e + ticket + dev report.
- (evidence commit) — mobile screenshots + `scripts/capture-ticket-40.mjs`.

## Gate feedback addressed

### TICKET-40-BUG-01 (App Tester FAIL, Medium) — degraded-paste: CTA never focused
- **Root cause confirmed:** the `onSongChosen` callback + `requestAnimationFrame` fired while React's `setParsedVideoId` commit was still pending; the CTA was still `disabled` and `.focus()` silently no-op'd (disabled elements are not focusable).
- **Fix (tester's suggested approach adopted):** removed the `onSongChosen` callback entirely; the jump is now a `useEffect` in `PatronRoom` watching `parsedVideoId` — effects run after commit, so the CTA is already enabled when scrolled/focused. ONE mechanism covering BOTH paths (result pick + paste resolve, normal and degraded), since both converge on `setParsedVideoId` via `handleSelect`. Skips `null` (clear / post-submit reset) so focus never jumps uninvited.
- **Test coverage for the gap:** the degraded e2e now asserts `toBeEnabled()` + `toBeFocused()` on the CTA after the paste resolves (regression test for BUG-01).
- **Re-verification:** unit 369/369, build green, full e2e 30/30 (incl. the new assertions + the existing §1 focus-jump test on the pick path).

## Implementation log (SHAs)
- `e021689` — impl + unit tests + e2e + ticket + dev report.
- `6999c71` — mobile evidence screenshots + capture script.
- `ff2d3d9` — dev report final verification.
- (next commit) — BUG-01 fix: effect-on-selection focus jump + degraded-paste e2e regression assertions.
