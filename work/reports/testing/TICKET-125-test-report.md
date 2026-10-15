# TICKET-125 — App Tester report (PR #89)

**Verdict: PASS** (with notes). Head tested: `7be6824` (`ticket/125-enter-idle-search`). Date: 2026-10-14.

## How it was tested

- `next dev -p 3135 -H 127.0.0.1` in the ticket worktree, `KARAOKE_INDEX_FILE=work/measurements/ticket-124/index-fixture.json.gz` (gitignored local fixture, not committed), **no `YOUTUBE_API_KEY`**. For the cooldown probe only, the server was restarted with a FAKE key string (not a real key) so requests get past the no-key early return.
- Headless Chromium via Playwright (`harness/apptest.cjs`), never the TL's screen. Every `/api/search` request was recorded with a timestamp relative to the scenario's last keystroke (or Enter). A request carrying `live=1` (or a `pageToken`) is the only kind that can reach the billed path, so the `live=1` timeline is the billing evidence.
- In most scenarios `live=1` and `pageToken` requests were answered by a Playwright mock (12 rows + a next-page token), so the post-live UI and "load more" could be exercised without a key. They are still recorded. Index-only requests always went to the real server and the real index. The `no-key Enter` scenario and all curl probes hit the real server unmocked.
- Matrix: 3 locales (pt-BR, en, es, via the `NEXT_LOCALE` cookie) × 2 viewports (390×844 phone with touch, 1280×800 desktop) × 10 checks = **60/60 PASS**. Typing speed 120 ms/char.
- Load at start: 6.9 (10 cores). No other playwright test runner was live; only idle `playwright-mcp` servers from other tabs.
- No approved mockup exists for this surface, so the design-parity pass was skipped.

## live=1 timeline per scenario

All six locale × viewport combinations produced the same timeline, within ±0.04 s. Full per-run log: `network-timeline.txt`.

| Scenario | Requests (t = 0 at the last keystroke unless noted) | Result |
|---|---|---|
| Known song `evidencias` | 0.29 s index → rows (visible ~0.8–1.3 s). No `live=1` over 10.5 s. No hint. | PASS |
| No-match `soda stete`, idle | 0.28 s index → `liveRequired`. Hint shown. **3.88–3.89 s: ONE `live=1`.** None more through +12 s. 0 `live=1` while typing. | PASS |
| Edit after idle (`+ " xyz"`) | 0.28 s index → `liveRequired`. **3.88 s: ONE `live=1`** for the new text. | PASS |
| Enter (0.9 s after typing, then a 2nd Enter at +0.4 s) | t = 0 at Enter: **`live=1` at 0.00–0.04 s.** The 2nd Enter sends nothing. No idle `live=1` through +8 s. | PASS |
| Enter-fast (Enter right after the last key, before the index answer) | Exactly 1 `live=1`, no idle follow-up. | PASS |
| Load more | Enter → 1 `live=1`. 1st tap reveals rows 9–12 with **0 requests**. 2nd tap → **1 `pageToken` request** (`v=2`, no `live=1`). | PASS |
| Listen mode | Mode flip: 0 requests. Index lookup → `liveRequired` (listen mode is never in the index). Hint shown. **ONE idle `live=1` at ~3.9 s** with the raw `q="evidencias"` (no "karaoke"). | PASS |
| Switch mode mid-typing (`soda st` → flip → `ete`) | Flip: 0 requests. No `live=1` while typing. **ONE idle `live=1` at >3.5 s** with the listen-mode `q="soda stete"`. | PASS |
| No key, Enter (real server) | Delayed index response shows the skeleton. Enter → 1 `live=1` → `degraded:no-api-key` → "search is down — paste a link" copy. No retry. | PASS |
| Edges: `abc` + Enter; pasted link + Enter | 0 `live=1`. No hint on a link. | PASS |

## Curl probes (`api-probes.txt`)

- **Old tab (no `v=2`), index miss** → `{"degraded":true,"reason":"no-api-key"}`: it reached the live path, so the index→live fallback is preserved.
- **Old tab, index hit** → index rows.
- **Current client (`v=2`), miss, no `live=1`** → `{"results":[],"liveRequired":true}`. With `live=1` → `no-api-key`, i.e. the live path.
- **Cooldown**, fake key: two `live=1` requests inside 2 s with one uuid. The 2nd answer is `{"deferred":"live-cooldown","retryAfterMs":849}`. Legacy (no `v=2`), same pattern: the 2nd answer is `deferred`, `retryAfterMs` 1647. Without a key, the no-key early return comes before the cooldown. That is harmless, because nothing can bill.
- **`live=1` on an index-hit query** → index rows in about 8 ms. The server answers from the index and does not bill. So `live=1` means "may bill", not "billed": billing needs `live=1` **and** an index/cache miss.

## Findings

1. **LOW: confirms reviewer item 2, with narrower impact** (`probe-reviewer-items.txt` A/A2, `pt-BR-phone-14-pasted-link-enter-in-input.png`).
   - A pasted link moves focus to "Adicionar à fila" (TICKET-40), so **paste → Enter still queues the song** (`POST /api/queue` at +0.01 s).
   - Only when the patron taps back into the search field and presses Enter/Go there does nothing happen. That is the `preventDefault()` before the link check.
2. **LOW: confirms reviewer item 3** (`probe-reviewer-items.txt` B, `pt-BR-phone-15-mode-flip-then-enter.png`).
   - Run a live search in sing mode, flip to listen, then press Enter on the same text: no request at all.
   - The "mode changed / search again" control still works.
3. **INFO: reviewer item 5 (Android IME Enter, keyCode 229)** (`probe-reviewer-items.txt` C, `pt-BR-phone-16-keycode229-enter.png`). Simulated with a CDP key event using keyCode 229:
   - no form submit, no error copy;
   - the hint stays up;
   - the idle `live=1` fires about 4 s after the last keystroke.

   Not checked on a real Android device or keyboard.
4. **INFO: Enter on an index hit sends `live=1` but doesn't bill** (`probe-enter-on-index-hit.txt`, `pt-BR-phone-12/13-*.png`). The server answers it from the index, so this is not a quota leak.
5. **INFO (pre-existing, not this PR):** a result row with an empty `thumbnailUrl` renders `<img src="">`, and React logs a console error. Only the harness mock rows triggered this; real index rows always carry thumbnails. No other console errors or page errors.
6. **Visual:** the hint copy renders correctly in all 3 locales on phone and desktop. It is one line at 390 px, sits under the input, is muted and not cramped. The loading skeleton, the degraded state, results and "load more" ("That's all we found" at the end) all render. Screenshots `*-2-nomatch-hint.png`, `*-9-loading-skeleton.png`, `*-10-nokey-degraded.png`, `*-6-loadmore-after.png`.

## CI

boraoke ships no `verify-green-local.sh`. The authoritative test record is the dev report (jest 1,087 passed, e2e 131/131) and the Reviewer's jest re-run (63/63 suites, 1,087 passed). I did not re-run the suites.

## Evidence index (`work/evidence/TICKET-125/apptest/`)

| File | Proves |
|---|---|
| `network-timeline.txt` | The 60 checks, with the timestamped request timeline and PASS/FAIL for each run |
| `api-probes.txt` | Legacy fallback, the v2 `liveRequired` answer, cooldown `deferred`, `live=1` on an index hit served free |
| `probe-enter-on-index-hit.txt` | `enterkeyhint="search"` / `inputmode="search"` on the input; Enter on an index hit answered from the index |
| `probe-reviewer-items.txt` | Findings 1–3 |
| `<locale>-<phone\|desktop>-1-indexhit-results.png` | Index rows while typing, no hint |
| `…-2-nomatch-hint.png` | The hint copy, per locale/viewport |
| `…-3-idle-live-results.png` / `…-4-enter-live-results.png` | Results after the idle / Enter live search (mocked rows) |
| `…-5/6-loadmore-*.png` | Load more, before and after |
| `…-7-listen-hint.png`, `…-8-switchmid-after.png` | Listen mode and the mid-typing mode switch |
| `…-9-loading-skeleton.png`, `…-10-nokey-degraded.png` | Loading and no-key degraded states |
| `…-11-paste-link.png` | Pasted link: no hint |
| `harness/*.cjs` | The scripts, so the run can be repeated |

## Friction

- The `next dev` dev-only fixture loader ignores `KARAOKE_INDEX_FILE` under `NODE_ENV=production`, so the app has to be tested under `next dev`, not `next start`.
- The local test room `default` collected 3 test songs in the in-memory store. These came from the paste-link + Enter edge, and they are dev-only.

## Re-check 2026-10-15 — head `638d427` (after the gate fix batch)

**Verdict: PASS.** 43/43 checks: hint fit 9/9, Enter-on-link 7/7, mode flip 18/18, regression 9/9. Scope was only what changed since `7be6824` (hint copy, Enter-with-link, per-mode once-guard); the full e2e suite was not run.

Setup: `next dev -p 3125 -H 127.0.0.1`, `KARAOKE_INDEX_FILE` = the gitignored fixture `work/measurements/ticket-124/index-fixture.json.gz` (present), no `YOUTUBE_API_KEY`, `live=1` answered by a Playwright mock, headless Chromium only. Server stopped afterwards (port 3125 confirmed free). Harness: `work/evidence/TICKET-125/recheck/harness/recheck.cjs`; raw timelines `recheck-timeline-{hint,enter,mode,regr}.txt` in `work/evidence/TICKET-125/recheck/`.

### 1. Hint copy after an index miss (3 locales × 390 / 320 / 1280)

Measured on the element (bounding box, line count via Range rects, scrollWidth vs clientWidth, document overflow, overlap with the input and next sibling) plus screenshots. All 9 combinations: inside the viewport, no horizontal overflow, no overlap, 12.8 px muted grey (`rgb(136,136,136)` on `rgb(13,13,13)`, about 5.4:1), under the input.

| Locale | 390×844 | 320 px | 1280×800 |
|---|---|---|---|
| en "Tap Search (or press Enter) to search YouTube" | 1 line | 2 lines | 1 line |
| es "Toca Buscar (o Enter) para buscar en YouTube" | 1 line | 2 lines | 1 line |
| pt-BR "Toque em Buscar (ou Enter) para pesquisar no YouTube" | **2 lines** (orphan "YouTube") | 2 lines | 1 line |

The earlier UNVERIFIED "one line at 390 px" is now resolved: true for en and es, **false for pt-BR** (wraps to two lines, width 318 px). It wraps cleanly, with nothing clipped or overlapping, so this is cosmetic, not a defect. **LOW note for Dev:** if a one-liner is wanted in pt-BR, shorten it (for example "Toque em Buscar (ou Enter) para buscar no YouTube").

Evidence: `<locale>-<phone390|phone320|desktop>-hint-1-after-index-miss.png` (full viewport) and `…-hint-2-element-closeup.png`.

### 2. Enter / phone search key inside the field with a pasted link

For each locale at 390 px (Enter, and a CDP keyDown with keyCode 13 for the phone search key), plus en desktop: paste a YouTube link, tap back into `#song-search-input`, press the key. Result in all 7 runs: exactly one `POST /api/queue` with `videoId=dQw4w9WgXcQ` at +0.01–0.02 s, no error alert, no search request. This closes the earlier finding 1 (Enter in the field did nothing). Evidence: `<locale>-phone390-enterlink-{1-before,2-after}-enter-{enter,searchkey}.png`.

### 3. Per-mode once-guard

Same results in pt-BR, en and es (390 px):

| Step | Observed |
|---|---|
| Sing mode, no-match text, idle | 1 `live=1` at 3.88 s |
| Flip to listen, 7 s idle, no typing | **0 requests** (mode change alone fires nothing) |
| Listen mode, clear and retype the same text, settle | index miss then **1 `live=1` at 3.9 s**, raw `q="soda stete"` (no "karaoke"), so the guard let the same text fire again for the new mode |
| Enter again on the same mode and text | 0 requests (once-guard holds) |
| Back to sing, Enter | 1 `live=1` (sing scope differs from the last-fired listen scope) |
| Sing Enter, flip to listen, Enter on the same text | 2 `live=1` in total; the 2nd is the raw listen query |

Observation, not a defect: the guard holds one last key (mode+text), so after sing then listen, going back to sing and pressing Enter on the identical text fires again, as the above shows. My first harness attempt (type "x" and backspace back to the same text) sent no request at all, because the text settled identically and the component does not re-search an unchanged query; that was a harness error, corrected by clearing and retyping.

Evidence: `<locale>-phone390-modeflip-1-after-flip-nothing.png`, `…-2-listen-settled-live.png`.

### 4. Core timeline regression (3 locales, 390 px)

| Scenario | Result |
|---|---|
| Index hit `evidencias` | 0 `live=1` in 9 s |
| Miss `soda stete`, idle | index `liveRequired`, then exactly 1 `live=1` at 3.88–3.89 s |
| Miss, Enter at 0.9 s | `live=1` at +0.01 s, a single one, no idle follow-up through +8 s |

### Defects

None. Console and page errors were not asserted in this run beyond the checks above (the known empty-`thumbnailUrl` mock-row warning from the first run is unchanged and not this PR's).

### CI

Unchanged from the first run: boraoke ships no `verify-green-local.sh`; the jest and e2e record is the Dev report (the re-check did not re-run the suites).
