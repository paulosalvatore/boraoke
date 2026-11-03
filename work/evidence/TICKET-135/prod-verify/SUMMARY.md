# TICKET-135/136 prod smoke (PR #97, a1c7a11)

Checked 2026-11-03. GitHub Production deployment for a1c7a11 (created 2026-11-02T08:11Z) has status success.

Three distinct GET https://boraoke.com/api/search calls (v=2, live=1, random uuid; no tokens involved). Raw headers and bodies are in q1..q3 here (set-cookie headers checked absent).

| # | q | status | results | source |
|---|---|--------|---------|--------|
| 1 | evidencias karaoke | 200 | 16 | index |
| 2 | evidencias -karaoke | 200 | 16 | index |
| 3 | bohemian rhapsody karaoke | 200 | 2 | index |

Reading: the route is healthy on the new build. All three were answered by the karaoke index tier, so none reached the live Google call or the folded cache key; the 7-day cache path and the exclusion-operator key split were NOT exercised live (covered by the unit tests and Cyber probe only). No repeat call was made (quota budget), so cache-hit behavior is unobserved.
