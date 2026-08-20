# TICKET-79 App Tester Report — server-rendered `<html lang>`

## Overall Verdict: PASS

All 21 HTTP-level cases (A–E), the inline-script grep (F), and the JS-disabled
cross-check (G) passed. The server-rendered `<html lang>` attribute is correct
in the raw response body — no client-side JS is required or used to fix it.
The TICKET-75 `document.documentElement.lang = …` inline script is gone (zero
occurrences across every captured response body).

Verified from `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-79`
against the already-running dev server at `http://127.0.0.1:3196`.

Test room used: id `some-venue` (created via `POST /api/rooms` with
`Cookie: NEXT_LOCALE=en`, confirmed via `GET /api/rooms?id=some-venue` to have
`settings.language: "en"` before, during, and after every case below — the
dev-mode in-memory-store-reset caveat did NOT bite because all routes were
warmed first).

---

## Case A — Landing routes: `/`, `/new`, `/admin`, `/admin/analytics`
(cookie → Accept-Language → pt-BR, no room tier)

| route | cookie | Accept-Language | expected lang | observed lang | PASS/FAIL |
|---|---|---|---|---|---|
| `/` | none | none | pt-BR | pt-BR | PASS |
| `/` | es | none | es | es | PASS |
| `/` | none | en-US,en;q=0.9 | en | en | PASS |
| `/` | es | en-US,en;q=0.9 | es (cookie wins) | es | PASS |
| `/new` | none | none | pt-BR | pt-BR | PASS |
| `/new` | es | none | es | es | PASS |
| `/new` | none | en-US,en;q=0.9 | en | en | PASS |
| `/new` | es | en-US,en;q=0.9 | es (cookie wins) | es | PASS |
| `/admin` (→307→`/default/admin`) | none | none | pt-BR | pt-BR | PASS |
| `/admin` | es | none | es | es | PASS |
| `/admin` | none | en-US,en;q=0.9 | en | en | PASS |
| `/admin` | es | en-US,en;q=0.9 | es (cookie wins) | es | PASS |
| `/admin/analytics` | none | none | pt-BR | pt-BR | PASS |
| `/admin/analytics` | es | none | es | es | PASS |
| `/admin/analytics` | none | en-US,en;q=0.9 | en | en | PASS |
| `/admin/analytics` | es | en-US,en;q=0.9 | es (cookie wins) | es | PASS |

`/admin` was followed with `curl -L`; final document (`/default/admin`) is
what was asserted on. Raw transcript: `raw_transcripts.txt`, bodies:
`body_A*.html`.

---

## Case B — `/<room>/tv` for room seeded `en` (room language only, ignores cookie + Accept-Language)

| cookie | Accept-Language | expected lang | observed lang | copy observed | PASS/FAIL |
|---|---|---|---|---|---|
| es | none | en | en | "Scan to join the queue" (en) | PASS |
| none | es-ES | en | en | "Scan to join the queue" (en) | PASS |
| none | none | en | en | "Scan to join the queue" (en) | PASS |

Room confirmed still `language: "en"` via `GET /api/rooms?id=some-venue`
immediately before and after this block (see `raw_transcripts_bcde.txt` lines
1–2, 21–22).

## Case C — `/default/tv` with cookie `es` (legacy room, no record → default)

| cookie | expected lang | observed lang | copy observed | PASS/FAIL |
|---|---|---|---|---|
| es | pt-BR | pt-BR | "Escaneia para entrar na fila" (pt-BR) | PASS |

## Case D — `/<room>` patron page for the same `en` room
(cookie → room default → Accept-Language → pt-BR)

| cookie | Accept-Language | expected lang | observed lang | copy observed | PASS/FAIL |
|---|---|---|---|---|
| es | none | es | es | "Escanea para entrar a la fila" (es) | PASS |
| none | es-ES | en (room default outranks header) | en | "Scan to join the queue" (en) | PASS |
| none | none | en | en | "Scan to join the queue" (en) | PASS |

## Case E — `/<room>/admin` with cookie `es` (host console follows host's own cookie)

| cookie | expected lang | observed lang | copy observed | PASS/FAIL |
|---|---|---|---|---|
| es | es | es | "Escanea para entrar a la fila" (es) | PASS |

Room confirmed still `language: "en"` before/after D and after E (see
`raw_transcripts_bcde.txt`).

---

## Case F — inline script removal

```
$ grep -l "documentElement.lang" body_*.html
NO MATCHES in any body file
```

Explicitly checked `body_B_tv_none.html` (the TV response) with
`grep -c "documentElement.lang"` → `0`. Zero occurrences of
`documentElement.lang` across every response body captured in this run (16 A
bodies + 8 B/C/D/E bodies).

---

## Case G — JS-disabled cross-check (Playwright, `javaScriptEnabled: false`)

Script: `js_disabled_check.mjs`. Results (`js_disabled_results.json`):

```json
[
  {
    "label": "G_tv_es_cookie_jsdisabled",
    "path": "/some-venue/tv",
    "cookieVal": "es",
    "lang": "en",
    "hasScanEn": true,
    "hasEscaneiaPt": false,
    "hasEscaneaEs": false
  },
  {
    "label": "G_tv_none_jsdisabled",
    "path": "/some-venue/tv",
    "cookieVal": null,
    "lang": "en",
    "hasScanEn": true,
    "hasEscaneiaPt": false,
    "hasEscaneaEs": false
  }
]
```

With JavaScript disabled and a `NEXT_LOCALE=es` cookie set, `/some-venue/tv`
still serves `lang="en"` and English copy ("Scan to join the queue") — this
is the exact scenario (TV route, JS not executing, cookie present) that would
have failed under the TICKET-75 client-side-only fix, since that fix depended
on an inline script running to correct the attribute. It now passes because
the correction is server-side. PASS.

---

## Reproduction

All commands are captured verbatim and re-runnable:

- `run_checks.sh` — Case A (16 requests), writes `raw_transcripts.txt` and
  `body_A*.html`.
- `run_checks_bcde.sh` — Cases B, C, D, E (8 requests + 5 room-existence
  checks), writes `raw_transcripts_bcde.txt` and `body_{B,C,D,E}*.html`.
- `js_disabled_check.mjs` — Case G, run via
  `node work/evidence/TICKET-79/js_disabled_check.mjs` from the worktree
  root, writes `js_disabled_results.json`.

Room setup (must be re-run once if the dev server restarts, since the room
store is in-memory):

```
curl -s -X POST http://127.0.0.1:3196/api/rooms \
  -H "Content-Type: application/json" \
  -H "Cookie: NEXT_LOCALE=en" \
  -d '{"name":"Some Venue"}'
# -> {"id":"some-venue", ...}
curl -s "http://127.0.0.1:3196/api/rooms?id=some-venue"
# -> settings.language must read "en" before trusting cases B-E
```

## Notes / anything ambiguous

- Nothing ambiguous. All expected-vs-observed pairs matched exactly on the
  first run; no retries or route-recompile/room-reset issues were hit because
  every room-scoped route (`/some-venue/tv`, `/some-venue`, `/some-venue/admin`,
  `/default/tv`) was warmed with a throwaway request before any assertion,
  and the room record was independently re-confirmed via
  `GET /api/rooms?id=some-venue` immediately around each case block.
- The patron page (`/<room>`) turned out to render the same localized
  "Scan/Escaneia/Escanea to join the queue" string used on the TV screen —
  this was not assumed, it was observed directly in each response body
  alongside its `lang` attribute, and it agreed with `lang` in every case.
