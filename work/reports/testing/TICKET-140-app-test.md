# TICKET-140 App Test — paste-a-YouTube-link gaps (PR #95)

**Verdict: PASS**

Head tested: `71a6d5e` (branch `ticket/140-paste-link`, worktree `.worktrees/t140-paste-link`). Date 2026-10-15.

## How it was run

- Production build into its own dist dir (`NEXT_DIST_DIR=.next-apptest`), `next start -H 127.0.0.1 -p 3140`, with `BORAOKE_E2E_STUBS=1` and `YOUTUBE_API_ORIGIN` / `YOUTUBE_OEMBED_ORIGIN` pointed at a loopback stub on 4140 (`work/evidence/TICKET-140/apptest/stub.mjs`). No real YouTube key anywhere; the stub saw only `local-stub-key`.
- Headless Playwright, one Chromium, never the TL's screen. Host load was ~65-110 during the run.
- `/api/search` mocked at the browser network layer (words return a result, a trigger word returns 429). Every other call hit the real server.
- Harness: `work/evidence/TICKET-140/apptest/apptest.mjs`; full log `run.log`; 88 screenshots in the same folder.
- Matrix: pt-BR, en, es x 390x844, 320x640, 1280x800 = 9 combos, each with a fresh room (host context = room creator, separate patron contexts). **108/108 checks PASS.**

## Results mapped to the handoff

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | "Imagination", "Bittersweet", "UNBREAKABLE" run a search (query reaches `/api/search`), no "YouTube link" row, no "Selected" line; bare `dQw4w9WgXcQ` is still a video | PASS in all 9 combos | `*-word-imagination.png`, `*-bare-id.png` |
| 2 | Queued from music.youtube.com, youtube-nocookie.com/embed, `HTTPS://WWW.YOUTUBE.COM/watch?v=`, `youtu.be/<id>/`, share text "olha essa https://youtu.be/<id> kkk" | PASS, all 5 forms in pt-BR 390 (own patron each); one rotating form in the other 8 combos | `pt-BR-m390-{music,nocookie,upper,slash,share}-{picker,queue}.png` |
| 3 | Real title + channel in the picker (placeholder gone), patron queue (`Title · Channel`), host admin queue, TV (`/<room>/tv` shows the title); duration in the host moderation pending row (`... · Canal Teste · 3:27`), pt/en/es | PASS | `*-picker.png`, `*-queue.png`, `*-host-admin.png`, `*-tv.png`, `*-d1280-host-pending.png`, `*-patron-pending.png` |
| 3b | Lookup fails (stub 5xx) -> picker keeps "Link do YouTube", song still queues, row falls back to `youtu.be/<id>`, no console errors | PASS | `pt-BR-m390-fallback-label.png` |
| 4 | Not-embeddable (stub `embeddable:false`) refused with friendly copy, nothing queued; copy fits (no overlap, no horizontal scroll on the patron page) at 390/320/1280 in all 3 locales; no quota/cost/billing word in the copy | PASS in all 9 combos | `*-not-embeddable.png` |
| 4b | Check that times out (stub waits 4 s) still lets the song in (queued in ~2.4 s) | PASS | `pt-BR-m390-timeout-queued.png` |
| 5 | "Too many searches" copy mentions pasting a link (UI via mocked 429, all 9 combos; real server 429 after 31 calls from one uuid returns the `searchRateLimited` copy with "ou cole um link do YouTube") | PASS | `*-rate-limited.png` |
| 6 | Regression: join, search, pick, queue, host admin, TV, moderation approve flow all worked; `/api/video-meta` 400 on bad id, 200 with title on good id | PASS | whole matrix |

CI note: no `verify-green-local` runs for this product repo from my side; I relied on the dev's verbatim jest (71 suites passed) and e2e (136 passed + the 2 fixed, re-run 6 passed) evidence in `work/evidence/ticket-140/`. The merge-gate "CI green" stays the TM's later gate.

## Defects

None in scope.

## Observations (not blocking, not caused by this PR)

- Host admin page scrolls horizontally at 390 and 320 px (the queue section is ~470 px wide, so the up/down/remove buttons are partly off-screen). Measured with a short fallback row (`youtu.be/<id>`) and a long title row: both rows are the same width, so the cause is not the new `Title · Channel` label, which still ellipsizes. Worth a separate ticket for the host admin mobile layout.
- The TV of a room created in an en/es browser still shows pt-BR UI chrome ("TOCANDO AGORA"): TV follows the room language, which defaults to pt-BR. By design, unrelated to this PR.
- The patron-side real-oEmbed path (no stub, real network) was not exercised on purpose; the stub mechanism covers the same code path.

## Friction

- `next build` takes minutes at load ~100; a dedicated `NEXT_DIST_DIR` kept it off the dev tree. `next build` rewrites `tsconfig.json` (`include` gets the dist dir); I reverted it.
- Search input accessible name is `Search.aria`, not the visible label, so `getByLabel(label)` fails in en/es; harness uses `Search.aria`.

## Re-check at fb373ed (round 2) — PASS

Date 2026-10-15. Source tested is `fb373ed`; the branch has since only gained report/event files (`36400a2`), no source change. Scope: what changed since the PASS at `71a6d5e` (patron "Título da música" field removed, client title never stored, 512-char input cap, paste hint in 429/error copy).

Run: production build into its own dist dir (`.next-apptest`, port 3141, removed afterwards), loopback YouTube stub on 4140 (`work/evidence/ticket-140/apptest-r2/stub.mjs`), no real key, `ROOM_CREATE_LIMIT=200` only to lift the per-IP room-creation throttle, **without** `BORAOKE_TEST_CLIENT_TITLES` (so the server behaves like production for titles). Headless Playwright, one Chromium. Matrix: pt-BR, en, es x 390x844 and 1280x800 (6 combos). Harness `work/evidence/ticket-140/apptest-r2/apptest-r2.mjs`; logs `run-full.txt` and `run-rerun.txt`; 115 screenshots in the same folder.

Result: 103 checks in the full run, 100 PASS first time; the 3 misses were harness timing, not product (TV watchdog skipped the unplayable stub video before the TV text was read; one cold-start timeout). Re-run of those two combos (`ONLY=pt-BR-m390,es-d1280`, TV now read the moment the row appears, longer waits): 35/35 PASS. **Net: all checks PASS, 0 defects.**

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | No "Título da música"/"Song title"/"Título de la canción" label anywhere; form children share the same left and right edges, vertical gaps 11-12 px between controls (no hole where the field was), no horizontal overflow; the only visible inputs are the mode radios, the search box and Mesa. Submit works: paste link + table 7 -> "Música na fila!", row `Title · Canal Teste` | PASS in 6/6 | `*-form-no-title.png`, `*-form-filled.png`, `*-paste-queued.png` |
| 2 | Failed lookup (stub 5xx): a search result picked with patron-visible title `PATRONTEXT_XYZ_n` queues; patron queue, host admin and TV show `youtu.be/<id>`, never the text. A direct `POST /api/queue` with `title:"EVIL_API_TITLE"` is accepted (201) and shows `youtu.be/<id>` too; the queue API returns no stored title for it. TV shows `youtu.be/<id>` | PASS in 6/6 | `*-fail-picker-results.png`, `*-fail-queue.png`, `*-fail-host-admin.png`, `*-fail-tv.png` |
| 3 | Real paste (`insertText`) of 5,000 chars: input keeps exactly 512, 8-105 ms, page stays responsive and typable. Programmatic 100,000-char fill: capped at 512 by the input, 28-105 ms, no freeze. A link followed by 900 chars of junk: link within the first 512 stays recognised and queueable. Server side: `POST /api/queue` with a 629-char and a 100,000-char `youtubeUrl` -> 400 in 0.5 s and 0.08 s | PASS in 6/6 | `*-long-paste-5000.png`, `*-long-paste-100k.png`, `*-long-paste-with-link.png` |
| 4 | Paste hint is shown (and fits, no overflow) in: 429 with empty body (client copy "...cole um link do YouTube" / "...paste a YouTube link" / "...pega un enlace de YouTube"), 429 carrying a server error string (server copy shown as sent), network failure, degraded 200. All three languages | PASS in 6/6 | `*-state-429.png`, `*-state-429-server-copy.png`, `*-state-network-abort.png`, `*-state-degraded-200.png` |
| 5 | Regression: paste queues with real title + channel, normal search -> pick -> queue shows the server title, not-embeddable refused with friendly copy and nothing queued (copy fits, no overflow), host admin shows real titles | PASS in 6/6 | `*-paste-queued.png`, `*-search-queued.png`, `*-not-embeddable.png`, `*-host-admin.png` |

Notes, none blocking and none from this PR:

- The picker row for a pasted link whose lookup failed shows the generic label "Link do YouTube / Pasted link" with the "Selected: <id>" line under it, not `youtu.be/<id>` (that form appears in the queue, host and TV). Never patron text. Screenshot `en-m390-fail-paste-picker.png`.
- A non-JSON or JSON HTTP 500 from `/api/search` shows no message at all (no results, no hint). The route never answers 500 (it returns `degraded` JSON, 200, and 429 for limits), so this is unreachable today and predates the PR. Screenshots `*-state-500-*-NOHINT.png`. Cheap hardening if wanted: treat any non-2xx like the network-error branch.
- The real-server 429 body check was not reproduced this round: 40 distinct-term calls from one uuid never reached a 429 (all answered 200, cause not investigated). The 429 copy is covered by the mocked states above and by the earlier round's real-server 429.
- The TV loads `youtu.be/<id>` rows but the TV watchdog skips unplayable stub videos within seconds ("Pulando vídeo indisponível"), so TV text must be read right away; harness does.
