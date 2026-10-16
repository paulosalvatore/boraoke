# TICKET-126 production verification

- **Date:** 2026-10-15
- **Merge:** PR #90 squash `a0f2b5965ff88bccb571a0087ed7c87b9b9c93b8` (caps 30/device, 90/network)
- **Deploy:** GitHub deployment 7105715255 (Production) state `success`, created 2026-10-15T22:16:53Z, `https://boraoke-2pyawtz5j-paulosalvatores-projects.vercel.app`; `https://boraoke.com/` → 200.
- **Method:** headless Chromium (Playwright), phone viewport, pt-BR, never the TL's screen. Room reused: `t125-prod-verify-throwaway` (no new room). Harness: `work/evidence/TICKET-126/prod-verify/harness.cjs`. Raw log: `work/evidence/TICKET-126/prod-verify/run-log.txt`.
- **Live calls spent:** 1 (budget was 2).

## Results

| Check | Observed | Verdict |
|---|---|---|
| Type an index song (`evidencias`), no Enter | one `/api/search` `v=2`, `live` absent, 200, `source: "index"`, 16 rows; 0 live calls (`01-index-typed-evidencias.png`) | PASS |
| Enter on a likely index miss (`hermeto pascoal bebe ao vivo montreux`) | index-only request → 200 `liveRequired: true`, then exactly 1 `live=1` request → 200 with 50 results; no personal-limit or daily-limit copy on the page (`02-index-miss-enter.png`) | PASS |
| `/api/search` `v=2` index-only probe (no `live`) | 200 `{"results":[],"liveRequired":true}` for both probes; no 5xx, no live call | PASS |

Overall: **PASS**. The caps themselves (30/90) were not exercised in production on purpose: reaching them would burn 30+ billed calls. They are covered by the unit tests (`__tests__/api-search-personal-caps.test.ts`, `default caps` block).
