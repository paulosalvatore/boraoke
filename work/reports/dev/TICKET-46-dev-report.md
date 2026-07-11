# TICKET-46 — Kiosk-TV screen-token self-heal — Dev Report

**Status:** IMPLEMENTED. Build + full unit suite green. Branch pushed; ready for the testing gate. e2e gap documented below (accepted per ticket).

**Ticket:** `work/tickets/TICKET-46-tv-token-self-heal.md`
**Branch:** `ticket/46-tv-token-self-heal` (worktree `.worktrees/ticket-46`, off origin/main)

## What was built

Both layers from the ticket, with the decision logic extracted into a pure, DOM-free helper module for unit testing.

### New pure module — `components/tv/self-heal.ts`

Holds every self-heal DECISION with no React/DOM/timer dependency (same pattern as `watchdog.ts`):

- `SELF_HEAL_TOKEN_MAX_AGE_MS = 20h` — proactive threshold, comfortably inside the first 24h bucket so a reload always re-mints in the current bucket (never in the previous-bucket grace tail), with a ~28h margin before the ≤48h hard expiry.
- `SELF_HEAL_RELOAD_DEBOUNCE_MS = 5min` — reactive (401) reload spacing.
- `shouldProactivelyReload({ tokenAgeMs, isPlaying })` — Layer 1: reload only when the token is old AND the player is idle. Never mid-song.
- `shouldReactivelyReload({ lastReloadAt, now })` — Layer 2: reload at most once per 5min window.
- `shouldSelfHealReload({ tokenAgeMs, isPlaying, lastReloadAt, now, got401 })` — combined surface matching the ticket's suggested signature; the reactive debounce guards BOTH paths so neither can storm.

### Layer 1 (proactive) — server page + TvScreen

- `app/(patron)/[room]/tv/page.tsx`: capture `screenTokenMintedAt = Date.now()` right next to the mint call, pass `mintScreenToken(room, screenTokenMintedAt)` the same timestamp (so the prop matches the token's bucket), and pass `screenTokenMintedAt` to `TvScreen`. **No secret/signing material crosses to the client — only a ms-epoch timestamp.**
- `components/tv/TvScreen.tsx`: a new effect derives `isPlaying = nowPlaying !== null` (reuses the existing now-playing state — `queue[0]`), and when `shouldProactivelyReload` returns true it does a full `window.location.reload()`. It runs on idle/playing transitions AND on a 60s interval, so a page that is *already idle* when it crosses 20h still heals without waiting for a queue change to re-render. Dormant for a no-key room (`screenTokenMintedAt` undefined).

### Layer 2 (reactive backstop) — advance()

- `components/tv/TvScreen.tsx` `advance()` now captures the advance fetch's response and, on **`status === 401`**, calls `reactiveSelfHeal()` and returns early. `reactiveSelfHeal()` reads the `sessionStorage` one-shot marker `boraoke-tv-selfheal-reload`, applies `shouldReactivelyReload`, writes the marker, and reloads — at most once per 5min. sessionStorage failures (private mode) degrade to "no prior reload" so the one-shot can still fire once. Non-401 errors keep the pre-existing transient-retry behavior.

## Log-mode behavior-neutrality argument

Current prod default is `ADVANCE_AUTH=log` (`advanceAuthMode()` returns `log` unless the env is exactly `enforce`). The advance route in log mode **never returns 401** — it records the would-block `console.warn` and lets the call proceed with a 2xx (confirmed by `__tests__/telemetry-instrumentation.test.ts`, which exercises the log-mode would-block path and asserts the call proceeds). Therefore:

- **Layer 2 is dormant in log mode** — `advanceRes.status === 401` is never true, so `reactiveSelfHeal()` never runs. Zero behavior change.
- **Layer 1's only effect in log mode** is an occasional idle `window.location.reload()` of a >20h-old page. That re-mints a fresh token via the existing `force-dynamic` page and re-renders identical UI; it fires only when the queue is empty (idle), so no singer is ever interrupted. Harmless and rare (once per >20h idle page).

Net: no behavior change for the current production default beyond a benign idle re-mint. The change is what makes the enforce flip safe — it removes the "hard-reload every venue TV after the enforce flip" runbook requirement.

## Files changed

- `components/tv/self-heal.ts` (new) — pure decision module.
- `__tests__/tv-self-heal.test.ts` (new) — 17 unit tests.
- `app/(patron)/[room]/tv/page.tsx` — mint timestamp captured + passed.
- `components/tv/TvScreen.tsx` — Layer 1 effect + Layer 2 401 self-heal in `advance()`.

## Self-verification (real output)

`npm test` — 462 base was green on main; now **479 passed** (17 new):

```
Test Suites: 33 passed, 33 total
Tests:       479 passed, 479 total
Snapshots:   0 total
Time:        1.756 s
Ran all test suites.
```

`npm run build` (Next runs ESLint + tsc typecheck as part of build) — clean:

```
 ✓ Compiled successfully in 3.6s
   Linting and checking validity of types ...
 ✓ Generating static pages (23/23)
```

(No separate `lint`/`typecheck` npm scripts exist in this repo; `next build` is the authoritative typecheck+lint gate, matching `.github/workflows/ci.yml` which runs `npm run build` then `npm test`.)

The framework `verify-green-local.sh` (md-doctor + shell-tests in Debian Docker) gates FRAMEWORK PRs; it does not apply to the cantai product repo, whose gate is `npm run build` + `npm test` (both green above) plus the App Tester visual gate.

Unit-test coverage (per ticket's required cases):
- (a) old + idle → reload ✓
- (b) old + playing → no reload ✓
- (c) fresh + idle → no reload ✓
- (d) 401 backstop respects the sessionStorage debounce (no storm; loop-simulated) ✓
- (e) ~20h boundary (just-below / exact / exact+playing) ✓

## e2e gap (accepted per ticket)

No Playwright e2e added. Both self-heal triggers require awkward time-travel: Layer 1 needs a >20h-old token (48h clock manipulation) and Layer 2 needs a live `ADVANCE_AUTH=enforce` deployment with an expired token — neither is cheap or reliable to assert in Playwright. The ticket explicitly makes e2e optional and directs relying on the pure-helper unit coverage, which fully exercises the decision matrix. The wiring in `TvScreen` (reading the prop, checking `res.status`, the sessionStorage marker) is thin glue over the tested pure functions.

## Deviations from the ticket

None material. Notes:
- The ticket suggested one combined `shouldSelfHealReload(...)` helper; I shipped that exact signature PLUS two smaller focused predicates (`shouldProactivelyReload`, `shouldReactivelyReload`) that `TvScreen` actually calls at each site, and unit-tested all three. This keeps each call site reading only the logic it needs while still providing the requested combined surface.
- Layer 1 is checked on a 60s interval (not only on queue-change re-render) so an already-idle page that crosses the 20h threshold heals without needing a queue event — closes a gap the ticket's prose implied but didn't spell out.
