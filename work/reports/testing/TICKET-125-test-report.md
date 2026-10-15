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
