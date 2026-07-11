# TICKET-46 — Kiosk-TV screen-token self-heal — App Tester Report

**Verdict: PASS**

Branch `ticket/46-tv-token-self-heal` (worktree `.worktrees/ticket-46`). Tested under the realistic prod default `ADVANCE_AUTH=log` (log mode — advance never 401s), memory store driver, dev server on port 3046.

## Gate focus (regression + no-spurious-reload)

This is not a 48h time-travel test. The self-heal decision matrix is covered by the dev's 17 pure-helper unit tests (`__tests__/tv-self-heal.test.ts`, part of the 479/479 green suite). My job was the live regression: prove a FRESH-token kiosk does NOT reload (the #1 risk — a hot-reload loop), and that normal queue/advance behavior still works.

## What was tested and observed

### 1. No spurious reload on a fresh token (primary risk) — PASS

Loaded `/default/tv` and instrumented the live page. A freshly minted token has age ~0 ms, far below the 20h proactive threshold (`SELF_HEAL_TOKEN_MAX_AGE_MS`), so `shouldProactivelyReload` must return false.

Held the page open for the full session (**~169 s continuous**, crossing multiple 60 s proactive-check interval ticks) and repeatedly sampled `performance.getEntriesByType('navigation')[0].type` and `performance.now()`:

- `navType` stayed **`"navigate"`** the entire time (a reload would flip it to `"reload"`).
- `performance.now()` climbed continuously (1 s → 84 s → 106 s → 133 s → 169 s) with no reset — a reload resets it to ~0.
- The Layer-2 sessionStorage marker `boraoke-tv-selfheal-reload` stayed **`null`** throughout (never written → reactive path never fired).

**Zero reloads across the whole session, spanning several proactive-check ticks and multiple advance calls. No reload loop. The fresh-token no-op is confirmed.**

### 2. Normal queue behavior — idle render + advance still works — PASS

- **Idle state** renders correctly on fresh load — recruitment poster, room QR, `127.0.0.1:3046/default` join label (evidence 01).
- **Idle → playing transition:** enqueued a song via the same-origin `POST /api/queue`; within one 3 s poll the TV switched to the playing state — hero "Golden Path Song", singer "🎤 Carol · Mesa 7", the 30 s mic-call, and the skip button all rendered (evidence 02). `idleShown` flipped false.
- **advance() 200-path (the modified callback):** `POST /api/queue/advance` returned **200** in log mode (never 401), the queue advanced/drained, and the TV returned to idle on the next poll. The new `if (advanceRes.status === 401)` guard is transparent on the 200 path — normal advance is unbroken and Layer 2 stays dormant, exactly as designed for the prod default.

### 3. Console errors — PASS (0 errors)

**0 console errors** for the entire session. 6 warnings, all pre-existing YouTube IFrame API noise sourced from `www.youtube.com` (`postMessage` target-origin mismatch + "player not attached to the DOM" — the normal churn when the YT player is created/destroyed as the queue changes). None originate from the new self-heal code or props; none are new to this ticket.

## Evidence index

| File | What it proves |
|------|----------------|
| `work/evidence/TICKET-46/01-tv-idle-fresh-load.png` | Fresh-load idle state renders normally; no reload fired (fresh token < 20h threshold). |
| `work/evidence/TICKET-46/02-tv-playing-after-advance.png` | Queue advance still drives the TV to the playing state (hero, singer, mesa, mic-call) — the modified `advance()` 200-path is unbroken. |

## Gate status

- Unit suite: **479/479 passed** (verified locally, incl. the 17 new self-heal tests).
- Console errors: 0.
- No spurious reload observed over ~169 s live (multiple interval ticks).
- Note: the framework `verify-green-local.sh` gates framework PRs only; the cantai product gate is `npm run build` + `npm test` + this visual gate. Build/typecheck/lint green per dev report; unit suite re-confirmed green here.

## Notes / limitations

- Time-travel triggers (token > 20h for Layer 1; live `enforce` + expired token for Layer 2) are covered by the pure-helper unit tests, not e2e — accepted per the ticket. This gate confirms the FRESH-token / log-mode behavior is a clean no-op, which is what production runs today.
- Memory-store observation: an early cross-process `curl` submit was not visible to a later browser fetch (Next dev module isolation); re-submitting from the browser origin worked immediately. Test-harness artifact only, not a product defect.
