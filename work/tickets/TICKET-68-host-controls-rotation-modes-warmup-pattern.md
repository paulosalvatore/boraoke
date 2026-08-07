# TICKET-68 — Adopt the TICKET-65-proven warm-up pattern in `host-controls.spec.ts` and `rotation-modes.spec.ts`

**Status:** OPEN — filed, not yet scheduled
**Filed:** 2026-08-07, interactive TM session (TL present)
**Priority:** MEDIUM
**Type:** Test infrastructure. Source: TICKET-65's own investigation trail (PR #48, merged
`e5ab830`) — the same defect class, in specs TICKET-65 deliberately did not touch.

## Why this exists

TICKET-65 deflaked `e2e/tv.spec.ts` and `e2e/tv-watchdog.spec.ts` by warming every route those
specs touch (via the new shared `warmTvRoutes()` in `e2e/helpers.ts`) before seeding, and by
replacing a couple of default-timeout waits with bounded explicit ones. That PR was scoped
strictly to the two TV specs; it did not touch `e2e/host-controls.spec.ts` or
`e2e/rotation-modes.spec.ts`, even though both carry the exact same shape of risk.

Each of those two specs defines its own **local** `warmUp()` helper (not the shared
`e2e/helpers.ts` one) that ends with a bare, default-timeout (5s) `waitFor()` immediately after
the **first-ever** `/admin` route compile:

- `e2e/host-controls.spec.ts:36` — `await page.getByLabel("Código do host").waitFor();`
- `e2e/rotation-modes.spec.ts:22` — `await page.getByLabel("Código do host").waitFor();`

That exact line — `host-controls.spec.ts:36` — is **the line the TM's original full-suite red run
failed on** during TICKET-65's PR #48 investigation (`host-controls.spec.ts:63 › host logs in,
removes, reorders, and pauses`, timing out inside its own `warmUp()`). It never reproduced in
isolation (2/2, twice), only under full-suite load — the same shape every full-suite-only failure
in the TICKET-65 investigation took, on both the TM's run and the agent's own round-2
reproduction (`tv-watchdog.spec.ts`, `ECONNRESET` on a plain `GET /api/queue`).

TICKET-65 was scoped to the TV specs' own files and correctly did not fold these two in — but the
underlying defect class in them is now proven, not hypothetical, and the fix pattern that closed
it is proven too.

## What TICKET-65 proved, and what this ticket proposes to reuse

1. **A shared warm-up helper beats a bespoke per-spec one.** `warmTvRoutes()` in `e2e/helpers.ts`
   compiles every route a spec touches before any seeding happens, mirroring the established
   `warmModerationRoutes()` precedent. `host-controls.spec.ts` and `rotation-modes.spec.ts` each
   maintain their own local `warmUp()` instead of extending the shared helper — worth folding in,
   at minimum for the `/admin` compile + first-render wait, so the pattern lives in one place.
2. **Route-compile warm-up must never share `DEFAULT_ROOM` with the rest of the suite.** TICKET-65's
   root cause was `warmTvRoutes()` firing from `beforeEach` and issuing an extra `advanceOnce()`
   against `DEFAULT_ROOM` — the same shared room nearly every other spec touches — adding per-test
   load and shared mutable state that did not exist before. The fix was a dedicated synthetic room,
   `TV_WARMUP_ROOM = "tv-warmup-e2e"` (`e2e/helpers.ts:124`), never `DEFAULT_ROOM`. Both
   `host-controls.spec.ts` and `rotation-modes.spec.ts` warm up against `room=default` /
   `DEFAULT_ROOM` today (`rotation-modes.spec.ts:16-21` posts to `/api/rooms`, logs in, and sets
   mode all on `room=default`) — the same hazard shape. A dedicated warm-up room removes it. This is
   sound because `next dev` route compilation is process-wide per route file, not tied to which
   room value triggers it — the TICKET-65 round-2 Reviewer verified that empirically on a fresh
   server, and the same reasoning transfers here.
3. **A bounded explicit timeout on the first post-compile assertion, not the 5s default.**
   TICKET-65 raised the first post-`goto` assertion in `tv.spec.ts`/`tv-watchdog.spec.ts` to
   `{ timeout: 10_000 }` — headroom for a cold SSR/route-compile render under load, not a blanket
   inflation. The two `.waitFor()` calls flagged above (`host-controls.spec.ts:36`,
   `rotation-modes.spec.ts:22`) are exactly this shape: a bare default-timeout wait immediately
   after a first-ever `/admin` compile. Same fix shape applies.

## Proposed scope

- Extend or reuse the shared `e2e/helpers.ts` warm-up pattern for the `/admin` route + the
  host-login/session/pause/skip/remove/reorder/queue endpoints both specs' local `warmUp()`
  helpers currently hand-roll.
- Route the warm-up calls through a dedicated non-`DEFAULT_ROOM` synthetic room (mirroring
  `TV_WARMUP_ROOM`), wherever the warm-up touches a room-scoped endpoint — `rotation-modes.spec.ts`
  is the clearer case (`POST /api/rooms`, `POST /api/host/login?room=default`,
  `POST /api/host/mode?room=default`); `host-controls.spec.ts`'s warm-up is default-room-implicit
  via `/api/host/*` without an explicit `?room=` param and should be checked for the same exposure.
- Replace the bare default-timeout `.waitFor()` on the first post-compile assertion in each spec
  with a bounded explicit timeout (TICKET-65 used 10s for a cold SSR render; recheck what's
  warranted for an `/admin` compile specifically — it may differ from a `/tv` page compile).
- Zero product source touched — test infrastructure only, matching TICKET-65's scope discipline.

## Acceptance criteria

- **5 consecutive full-suite runs green.** Isolated-spec runs do **not** satisfy this criterion —
  state that explicitly in the PR and cite TICKET-65's history as the reason: TICKET-65's own
  round-1 delivery passed 5/5 isolated TV-spec runs plus an opus Reviewer APPROVE, and that
  APPROVE was overturned by a single independent full-suite run that found a real failure
  (`host-controls.spec.ts:63`) no isolated run had ever exercised. A gate that only ever runs the
  changed specs in isolation cannot validate a deflake fix of this shape — only a full-suite run
  can, because the failure mode is inter-spec contention (shared room, added per-test load), not a
  property of any one spec run alone.
- `npx tsc --noEmit` clean on all changed files.
- No product source (`app/`, `lib/`, `components/`) touched.

## Not in scope

Any other spec's warm-up pattern not flagged above. If a full-suite run under this ticket's own
verification surfaces contention involving a third spec, treat it as a new finding rather than
silently expanding scope.
