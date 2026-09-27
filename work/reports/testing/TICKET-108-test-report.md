# TICKET-108 — App Tester report: stop billing a `search.list` call per keystroke

**Verdict: BLOCKED (on the core UX flows) — with the independently-verifiable subset PASS.**

**Role:** App Tester (boraoke) · **Date:** 2026-09-27
**Branch:** `ticket/108-keystroke-billing` · **Worktree:** `.worktrees/t108-keystroke-billing`
**Boot:** `npx next dev -p 3083` (port range 3080–3089 per assignment), warmed `/`, `/default`, `/default/tv`, `/api/search` before the timed pass.

---

## Why BLOCKED, stated plainly, first

The whole point of this gate is item 1–5 of the brief: does the local-narrowing search **feel** right — responsive, no flicker on the local↔fetch transition, honest loading state, correct behaviour typing slowly, and no stale-result race. **All five of those require the app to actually hold a real fetched page of YouTube results to narrow against.** This environment has no `YOUTUBE_API_KEY`:

- No `.env.local` in this worktree, any other boraoke worktree, or the main checkout.
- No vault entry: `scripts/vault.sh list` (run from the framework repo) has no `boraoke/*` entries at all — consistent with the Dev report's own note ("boraoke has no Credential Vault entry yet — TICKET-107").
- Confirmed live against the running app, not just reasoned from `.env.example`:

```
$ curl -s "http://127.0.0.1:3083/api/search?q=escurinho%20karaoke&uuid=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
{"degraded":true,"reason":"no-api-key","results":[]}
```

Every search in this environment returns `results: []`. The planner's held pool is therefore **always empty**, so `isExtensionOf` + the starvation guard (`MIN_LOCAL_MATCHES=3`) can never be satisfied — **every single query, extension or not, refetches**. I proved this directly rather than assuming it (see §2): typing `escu` → pause → `rinho` → pause → ` do cinema` → pause fired **three** separate `/api/search` calls, one per pause, exactly the old per-keystroke-pause behaviour this ticket exists to remove. There is no way, in this environment, to get the app into the state where narrowing actually narrows anything — so I cannot see it feel responsive, cannot see it flicker or not flicker, cannot see an honest-vs-dishonest loading state on a real transition, and above all **cannot exercise the race condition the Dev fixed in self-review** (an in-flight fetch landing after a local narrowing has already superseded it) — that race is specifically about a stale fetch racing against real held rows, and there are never any held rows here.

Per my brief: *"if search is unavailable in your environment, say BLOCKED and say exactly why rather than simulating results and reporting on the simulation."* I did not mock `/api/search` with `page.route` (the way the Dev's own e2e suite legitimately does) to manufacture a populated held pool, because that would be exactly the prohibited simulation — a page.route fixture is my construction, not a measurement of the app's real behaviour, and reporting a verdict off it would be reporting on my own simulation.

**What this is not:** it is not a defect in the PR. The Dev's report is explicit that the whole quality case was measured off a read-only replay of production's cache, with the same "no key needed for real API traffic" constraint (TICKET-107 is an open, separately-tracked gap). This is an environment limitation on the App Tester's side, not a code problem to send back to Dev.

---

## What I verified independently (does not require a populated held pool)

These are the checks in the handoff that are about a request **not** firing, or firing in the client-gating sense rather than the narrowing sense — verifiable with a degraded backend as the "control" that the request mechanism itself is not lying (proof-by-absence: I confirmed the network-request instrument fires correctly — see the 3-vs-4-char control below — before trusting any "0 requests" reading).

### 1. `MIN_CHARS` 3 → 4 (handoff item 8) — **PASS**

Typed `esc` (3 chars), waited >1s: **zero** `/api/search` requests (confirmed via `browser_network_requests` filtered on `/api/search`, only 12 static assets present). Typed one more char (`escu`, 4 chars): **exactly one** request fired —

```
35. [GET] http://127.0.0.1:3083/api/search?q=escu+karaoke&uuid=...  => [200] OK
```

This is also my positive control that the request-capture instrument works (it caught the request at 4 chars), which is what makes the earlier "0 requests at 3 chars" trustworthy rather than a silent miss.

### 2. Paste a YouTube URL — zero `/api/search` calls (handoff item 6) — **PASS**

Pasted `https://youtu.be/dQw4w9WgXcQ` into the search field. Result: "Link do YouTube · Link colado" chip appeared, "✓ Selecionada: dQw4w9WgXcQ" shown, "Adicionar à fila" enabled. `browser_network_requests` (unfiltered) over the whole interaction shows only `api/identity` and `api/queue*` calls — **no `/api/search` request at all**. Screenshot: `work/evidence/TICKET-108/t108-search-degraded-desktop.png` was taken in a related state; the paste itself was verified via the network log rather than a dedicated screenshot (see Friction — I should have captured one, noted below).

### 3. Mode flip fires no new request (TICKET-83 regression, handoff item 7) — **PASS**

With a query already in flight (`borbulhas`, one `/api/search` call logged as request #26), flipped **Cantar → Só curtir**. Re-checked `/api/search` requests filtered: still only request #26, nothing new. TICKET-83's "a mode flip can never re-trigger a debounce, a fetch, or a quota charge" holds in this build.

### 4. Degraded-state UI is honest, not misleading (part of handoff item 3) — **PASS, in the only state reachable here**

The UI shows an explicit status line **"Busca indisponível — cola o link do YouTube"** (search unavailable — paste the YouTube link) rather than a spinner that never resolves or a silent empty list. This is the correct honest-degraded treatment for the state this environment is actually in. I could **not** verify the loading-state honesty for the two states the handoff actually cares about — a real spinner during a real spent call, and the absence of a spinner during a real local narrow — because neither state is reachable without a key.

### 5. Regression smoke — **PASS (light)**

`/`, `/default` (join flow), `/default/tv` all load without console errors on the current navigation (`browser_console_messages(level: "error")` returned 0 for the active page — the long history of unrelated errors from `boraoke.com`/other ports/other rooms returned only when I queried with `all: true` is stale console history from a prior session on this shared Playwright MCP browser context, not from my session; noted so it isn't mistaken for a finding).

### 6. Mobile viewport (390×844) — **partially checked**

Repeated the 3-vs-4-char gating check at 390×844: same result (0 requests at 3 chars, 1 at 4). Screenshot: `work/evidence/TICKET-108/t108-search-degraded-mobile.png`. Everything requiring real narrowing is equally blocked at mobile width as at desktop.

---

## Evidence index

| File | What it shows | What it proves |
|---|---|---|
| `work/evidence/TICKET-108/t108-search-degraded-desktop.png` | Desktop (1280×720), search field with `escurinho do cinema` typed, "Busca indisponível" status line visible | The only reachable UI state in this environment: honest degraded copy, no fake spinner |
| `work/evidence/TICKET-108/t108-search-degraded-mobile.png` | Same state at 390×844 | Confirms the degraded-state copy and layout hold at phone width |
| (inline, this report) `curl` output against `/api/search` | `{"degraded":true,"reason":"no-api-key","results":[]}` | Direct, reproducible proof of the blocking condition — not inferred from `.env.example` |
| (inline, this report) network-request logs for the 3-vs-4-char, paste, and mode-flip checks | Exact request lists per interaction | The three independently-verifiable PASS items above |

---

## Gates referenced (not re-run by me — see CI-verified-green rule)

Dev report claims `npm test` GREEN (53/53 suites), `npm run test:e2e` GREEN (110/110), build GREEN. I have **not** independently re-run `scripts/verify-green-local.sh`; per the CI-verified-green rule I am not issuing a merge-blocking claim about CI status either way — that is a separate check from this visual/UX gate, and this report's BLOCKED verdict is about the UX flows specifically, not CI.

---

## What would unblock this

The fastest unblock is a real (even low-quota, test-project) `YOUTUBE_API_KEY` for boraoke, delivered the sanctioned way (Credential Vault entry — TICKET-107 is exactly this gap) rather than pasted inline. With one real key, I can re-run this exact session and actually exercise: slow-typed narrowing with pauses, the starvation-refetch case (short prefix → different real title), backspace-refetch, accent re-spelling (no refetch), `load more` against the held query, and the stale-fetch race. None of the code changes anything about that — it is purely "give the tester the same kind of key the Dev used for measurement, or a live one for interactive testing."

## Friction

- The Playwright MCP browser tools are sandboxed to write files only under the **framework repo's** `.playwright-mcp/` directory, not the boraoke worktree — screenshots had to be taken there and copied into `work/evidence/TICKET-108/` via a separate `cp`. Worth a note for the `capture-screenshots` skill if this recurs for other App Tester sessions using the MCP Playwright tools instead of a Playwright script.
- `browser_console_messages(all: true)` returns the **entire MCP browser session's** history across unrelated prior navigations (other ports, other rooms, `boraoke.com`) — it is not scoped to the current page's lifetime the way the default (non-`all`) call is. Almost mistook stale noise from a prior session for a finding; used the non-`all`, page-scoped call instead once I noticed.
- No `scripts/evidence-guard.sh` in this repo (it's referenced in the App Tester role doc as a framework-level convention); I did not fabricate one — the network-request logs above are quoted verbatim in this report instead, with an explicit positive control (the 4-char case) rather than a terminator file.
- I should have taken a dedicated screenshot of the paste-URL success state (chip + "Selecionada:" + enabled CTA) rather than relying on the network log alone — noted for a follow-up pass once a real key unblocks the rest anyway.
