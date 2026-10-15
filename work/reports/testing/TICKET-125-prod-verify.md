# TICKET-125 — production verification (boraoke.com)

- **Date:** 2026-10-15, 13:07 UTC
- **Merge:** PR #89 squash `4d1940eb5bb7fb20a3ff9665b143762269345db2`
- **Deploy:** GitHub deployment 7093355672 (Production) `success` → https://boraoke-ljfile55k-paulosalvatores-projects.vercel.app, serving https://boraoke.com
- **Method:** headless Chromium (Playwright), 390×844, real network, no mocks. Script: `work/evidence/TICKET-125/prod-verify/t125-prod-verify.cjs`. Full request/response timeline: `work/evidence/TICKET-125/prod-verify/network-timeline.json`.
- **Room:** created a throwaway room `t125-prod-verify-throwaway` ("T125 prod verify (throwaway)") via /new; joined as "T125 verify" (pt-BR) and "T125 verify en" (en). No songs queued. The room is still on prod.
- **YouTube quota spent:** 2 live calls (one in (c), one in (d)). No retries were needed.

## Results

| Check | Result | Evidence |
|---|---|---|
| (a) "evidencias" shows index rows while typing, no live=1 | **PASS.** Index-only (v=2, no live) lookups for `evid karaoke` (mid-typing) and `evidencias karaoke`, both `source: index`, 16 results; 8 rows rendered. 0 live calls, including a further 4.5 s idle wait (an index answer never triggers the idle live search). The mid-typing screenshot taken 0.7 s after "evid" shows no rows yet, because the first cold index response took about 1.5 s. | `a1-while-typing-evid.png`, `a2-evidencias-index-rows.png` |
| (b) index miss → hint, no live=1 while typing (pt-BR) | **PASS.** `hoppipolla sigur ros karaoke` → `liveRequired: true`, hint "Toque em Buscar (ou Enter) para pesquisar no YouTube", 0 live calls. The hint wraps to 2 lines at 390 px, which is the known cosmetic note. | `b1-miss-hint-pt-BR.png` |
| (b) hint in en | **PASS.** `diablo rojo rodrigo y gabriela karaoke` → `liveRequired`, hint "Tap Search (or press Enter) to search YouTube", 0 live calls. Input cleared and context closed before the 4 s idle. One earlier en candidate was skipped because a cold response missed the script's 1.3 s window. That response was also `liveRequired`, and it billed nothing. | `b2-miss-hint-en.png` |
| (c) Enter → exactly one live=1 + results | **PASS.** Enter 1.2 s after the last key → one `live=1` request 5 ms later, 200 with 50 results, 8 rows shown, hint gone. No repeat over the next 6 s. | `c1-after-enter-results.png` |
| (d) fresh miss + ≥5 s idle → exactly one live=1 at ~4 s | **PASS.** `tamacun rodrigo y gabriela karaoke` → `liveRequired`, then one `live=1` request 3897 ms after the last keystroke, 200 with 50 results, 8 rows shown. Exactly 1 live call in 6.5 s. | `d1-fresh-miss-hint.png`, `d2-after-idle-results.png` |

**Verdict: PASS. Production behaves as specified.**
