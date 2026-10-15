# TICKET-126 App Test — PR #90 (head 6a6854c)

Verdict: **PASS** (51/51 harness assertions, plus API probes). Notes below.

## Setup
- Worktree `.worktrees/t126-search-limits` at `6a6854c`, `next dev -H 127.0.0.1 -p 3126`, `STORE_DRIVER=memory`, `SEARCH_DEVICE_DAILY_CAP=2`, `SEARCH_IP_DAILY_CAP=3`, `TRUSTED_CLIENT_IP_HEADER=x-forwarded-for`.
- `YOUTUBE_API_KEY=sandbox-fake-key` (never the production key). The googleapis calls are mocked at the network layer on the SERVER (`harness/mock-yt.cjs`, a `--require` preload that replaces `fetch` for `www.googleapis.com/youtube/v3/*`, 1.5 s latency, logs each `search.list`). This lets the real route, the real per-device/per-IP counters and the real single-flight run, which a browser-side route mock could not exercise.
- Karaoke index from a local fixture (`KARAOKE_INDEX_FILE`, 12 "Evidencias karaoke versao N" rows).
- Headless Playwright (chromium), one browser, 390x844 and 1280x800 in pt-BR, en and es; 320x640 for copy fit. Host load was 110-150 throughout; every run completed without timeouts.
- Harness: `work/evidence/TICKET-126/apptest/harness/apptest.cjs`; full log `run-log.txt`; API probes `api-probes.txt`.

## Results mapped to the Testing Handoff
1. **Personal-limit copy after the cap.** Per locale and viewport, two live searches (Enter, distinct queries) returned results and billed exactly 2 `search.list`; the third showed the personal-limit copy with 0 extra billed calls. The text contains no billing/quota/cost words (regex checked) and the generic outage copy ("Search is down" etc.) never showed. PASS x6 combinations.
   - pt-BR: "As buscas ao vivo de hoje acabaram neste aparelho ou nesta rede — ..."
   - en: "Live searches are used up for today on this device or network — ..."
   - es: "Se acabaron las búsquedas en vivo de hoy en este dispositivo o en esta red — ..."
2. **While capped.** Typing "evidencias" shows the karaoke-index rows; pasting `https://youtu.be/dQw4w9WgXcQ` and pressing Enter queues it (queue row added). PASS x6.
3. **Platform daily limit** (mock `reason: "daily-limit"`): its own copy shows ("Today's search limit is reached", "Chegamos ao limite de buscas de hoje", "Alcanzamos el límite de búsquedas de hoy"), not the personal copy. PASS x6.
4. **Fit.** No horizontal scroll at 390 or 1280 while capped; at 320 px the notice box is 248 px wide inside the 320 viewport (x=36), no overlap, 3 locales PASS. Screenshots reviewed (pt-BR phone, es 320).
5. **Single-flight UX.** Two tabs (different device + IP) fire the same uncached live query at once: both get results, neither sees the degraded/error notice, and only 1 `search.list` is billed for the pair. PASS x3 locales (desktop).
- **IP cap** (curl, `api-probes.txt`): 4 distinct devices behind one IP, cap 3: the 4th gets `personal-limit`; another IP is unaffected; the capped IP still gets a cached answer and index rows free.

## Evidence index (`work/evidence/TICKET-126/apptest/`)
- `<loc>-<vp>-1-second-live-results.png`: second live search succeeds (under cap).
- `<loc>-<vp>-2-third-live-personal-limit.png`: personal-limit copy, no outage copy.
- `<loc>-<vp>-3-capped-index-results.png`: index rows while capped.
- `<loc>-<vp>-4/5-capped-paste-link-*.png`: pasted link selected, then queued.
- `<loc>-<vp>-6-platform-daily-limit.png`: platform copy.
- `<loc>-desktop-8/9-singleflight-tabA/B.png`: both tabs show results.
- `<loc>-narrow320-7-personal-limit-320px.png`: 320 px fit.
- `api-probes.txt`, `run-log.txt`, `harness/`.

## Notes / friction
- **One unexplained first-run anomaly (not reproduced).** On the very first cold-compile run (en desktop, fresh `next dev`), the third live search was billed (3 `search.list`, no personal-limit) while `next dev` was still compiling `/api/search`. A same-flow debug run, 3 immediate re-runs and the full 51-assertion matrix all enforced the cap exactly. Most likely cause is dev-mode module re-evaluation resetting the in-memory counters on first compile (TICKET-116 documents this class for `next dev` + memory store); it cannot happen in a production build or with Redis, but I did not prove that. Flagged for the Reviewer; not a FAIL.
- Dev-overlay "1 Issue" badge / console warning about an empty `src` come from my mock rows having `thumbnailUrl: ""`; mock artefact, unrelated to the PR.
- Gates not re-run here: jest/e2e/build (Dev reports 134/134 e2e etc.). boraoke has no `verify-green-local.sh`, so there is no local-Docker verdict to cite; the PR body states the full local gates were green at this head.
- Design-parity pass skipped: no approved mockup for this surface (copy-only change).
