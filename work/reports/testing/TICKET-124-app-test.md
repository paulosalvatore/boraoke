# TICKET-124 App Test — PR #88 (index-primary search tier)

**Verdict: PASS** (with 2 LOW, pre-existing, out-of-scope notes)

- Branch `ticket/124-index-primary` at `bed2857`, clean tree, merge-base = `origin/main` tip `af080ca`.
- Server: `next dev -p 3134`, `NEXT_DIST_DIR=.next-apptest`, `STORE_DRIVER=memory`, `KARAOKE_INDEX_FILE=<worktree>/work/measurements/ticket-124/index-fixture.json.gz`, `CRON_SECRET=apptest-local-secret` (local dummy), and `YOUTUBE_API_KEY` / Upstash vars explicitly unset (`env -u`). No `.env*` file other than `.env.example` exists in the worktree. Zero YouTube API calls were possible: every non-index answer returned `degraded: no-api-key`.
- Browser: Playwright Chromium, headless, own context. Viewports 390x844 (mobile, touch) and 1280x800 (desktop). Harness: `work/evidence/TICKET-124/apptest/apptest.mjs`.
- Pre-flight: no `playwright test` process was running (only idle `playwright-mcp` servers from other tabs). Load average was about 11 on 10 cores.

## Results mapped to the Testing Handoff

| # | Flow | Result | Evidence |
|---|---|---|---|
| 1 | Sing `evidencias` → index, 16 rows, duration + thumbnail | PASS. API `source=index`, 16 rows, `nextPageToken=IDXLIVE`. The UI shows 8 rows and "Ver mais resultados". Durations show. Thumbnails load: `naturalWidth` was 320 for all 8 rows when the capture waited for images. | `{mobile,desktop}-01-sing-evidencias.png`, `mobile-18-thumbnails-loaded-zeca-pagod.png` |
| 1b | Loading state | PASS. A 3-row skeleton matching the row layout appears while the request is in flight (delayed with a 1.5 s route hold). | `{mobile,desktop}-01-sing-evidencias-loading.png` |
| 2 | `escurinho do cinema` / `escurinho do cin` | PASS. Index returns the Rita Lee "Flagra (No Escurinho do Cinema)" karaoke as its only row, with "load more" still offered. | `*-02-*`, `*-03-*` |
| — | `ze ramalho` | PASS. Index, 16 Zé Ramalho karaoke rows. | `*-04-sing-ze-ramalho.png` |
| 3 | `brasil karaoke` and `brasil` → no channel-name dump | PASS. Both go out as `brasil karaoke`. 16/16 rows have "Brasil" in the **title**, and 0 rows match only by channel name. | `*-05-*`, `*-06-*`, `run-log.txt` ("channel-dump check") |
| — | Typos `evidencas`, `ze ramlho` | PASS (by design). The index does not answer, so the query goes live. With no key the patron sees the degraded copy "Busca indisponível — cola o link do YouTube". There is no blank screen and no crash. | `*-07-*`, `*-08-*` |
| — | Partial words `evid`, `zeca pagod` | PASS. Both are answered by the index (16 rows of relevant results). | `*-09-*`, `*-10-*` |
| — | No index match, live unavailable (`xyzzyqq florbix`) | PASS. The patron sees the same degraded copy, and the paste-a-link input stays usable. | `*-11-sing-no-match-live-unavailable.png` |
| 5 | "Load more" past the index answer | PASS. Tap 1 reveals rows 9–16 locally with no request. Tap 2 sends `page=2&pageToken=IDXLIVE`, which gets `degraded:no-api-key` with no key. The 16 rows already shown stay put, and nothing crashes. | `*-12-*`, `*-13-loadmore-tap1.png`, `*-13-loadmore-tap2.png`, `*-search-calls.json` |
| 4 | Listen mode `evidencias` → the index must not answer | PASS. The request goes out raw as `q=evidencias`, without "karaoke". The response is `degraded:no-api-key`, not `source=index`. | `*-14-listen-evidencias.png` |
| — | Mode flips must not fetch | PASS. In `*-search-calls.json` there is no request between the IDXLIVE call, the flip to listen, the listen search, the flip back to sing and the next sing search. | `*-search-calls.json` |
| — | Queue an index-found song end to end | PASS. Picked the index row "Flagra (No Escurinho do Cinema)…" → "Adicionar à fila" → "música na fila". `/api/queue` contains it. `/default/tv` shows it (now playing from mobile, "A seguir" from desktop). | `*-15-*`, `*-16-queue-1-queued.png`, `*-17-tv-shows-queued.png` |
| 6 | Cron route auth | PASS. Without `CRON_SECRET`: no bearer → 503, wrong bearer → 503 (fail-closed). With a local dummy `CRON_SECRET`: no bearer, `nope`, a near-miss (`apptest-local-secre`) and a bare `Bearer` all → 401. The correct bearer was never sent, so refresh never ran. | `run-log.txt` / this report |
| — | Console errors | 0 on both viewports. | `run-log.txt` |

## Defects / notes (none in handoff scope)

1. **LOW, pre-existing, out of scope:** a page-2 "load more" that comes back degraded for any reason other than `daily-limit` (here `no-api-key`) is swallowed silently. The rows stay and the "Ver mais resultados" button stays, with no message. This is the existing `SongSearch.tsx` load-more branch, which this PR does not change. In production the key is present, so the IDXLIVE escape goes live as intended. The PR does make this path more reachable (every index answer ends in an IDXLIVE tap), so a follow-up could show the degraded copy and retire the button there, as the daily-limit branch already does. Evidence: `*-13-loadmore-tap2.png`.
2. **LOW, pre-existing, out of scope (TV):** a long karaoke title on `/tv` ("Flagra (No Escurinho do Cinema)- karaokê - MÚSICA ORIGINAL SEM VOZ c/ letra - Rita Lee") wraps into a very tall headline. That pushes the singer line under the "vá para o microfone" banner and the QR card. The PR touches no TV code, but index rows tend to have long channel-style titles. Evidence: `desktop-17-tv-shows-queued.png`, `mobile-17-tv-shows-queued.png` (the TV page captured at 1280x720).
3. **Capture note, not a defect:** thumbnails show black in the first-pass captures because the screenshot fired before the `i.ytimg.com` images finished loading. A re-capture that waited for images shows them all (`mobile-18-thumbnails-loaded-zeca-pagod.png`).

No approved mockup exists for this surface (search behaviour only, no UI change), so the design-parity pass was skipped.

## Conditions

- CI: boraoke has no `verify-green-local.sh`. The App Tester did not re-run jest/e2e (the Dev reported jest 1,049 passed and e2e 127/127). The CI gate stays with the Reviewer/TM before merge.
- Not testable locally: Upstash loading, the real cron refresh and live YouTube results after IDXLIVE. These are by design, no key and no production.

## Friction

- The search rate limit is 5 requests per uuid per 10 s. A fast API probe burst from one `anon` uuid hit 429. The harness spaces queries about 2.5 s apart.
- `next dev` with a custom `NEXT_DIST_DIR` rewrites `tsconfig.json` `include` (adds `.next-apptest/types`). I reverted it after the run; it was not committed. Future App Testers using a separate dist dir should expect this.
