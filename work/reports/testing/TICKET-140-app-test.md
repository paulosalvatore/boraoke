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
