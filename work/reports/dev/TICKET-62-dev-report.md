# TICKET-62 — Dev report

**Branch:** `ticket/62-tv-client-hygiene` (cut off `origin/main` @ `46d25cd`)
**Worktree:** `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-62`

## Files changed

| File | Change |
| --- | --- |
| `components/tv/self-heal.ts` | Added `deepEqualJson` + `queueItemsEqual` (pure, node-testable). Documented why `shouldProactivelyReload` must never be called raw. **Zero deleted lines** — the three existing self-heal predicates are byte-identical to `main`. |
| `components/tv/TvScreen.tsx` | Both self-heal layers now go through one marker-guarded `selfHealReload`; marker cleared on a 2xx advance; both `setQueue` writes made if-changed; **plus a new `playerRetryTimerRef`** that explicitly re-arms TICKET-41c's failed-constructor retry, which the if-changed diff would otherwise have silently killed (§3a). |
| `__tests__/tv-self-heal.test.ts` | +41 tests: the clamp (incl. the >20h-ahead clock), the marker clear, and the deep-equal in both directions. Header docblock updated — the file is no longer TICKET-46-only. |

### 3a. A regression the if-changed diff introduced, found and fixed during dev

The player effect's `catch` around `new window.YT.Player(...)` (TICKET-41c) comments that a failed constructor "retries on the next effect run". That retry was never explicit — it rode on the queue poll writing a **brand-new array identity every 3 seconds**, which re-fired the effect for free (`queue` is in its dependency array). Making the poll if-changed silently removes that: on a static queue there is no identity change left, so a half-loaded YouTube API on venue wifi would leave the TV dead with no retry, forever. That is precisely the unattended-kiosk failure this ticket must not create.

Fix: the `catch` now schedules the re-run explicitly — `setPlayerEpoch((n) => n + 1)` after `POLL_INTERVAL` (3s, the same cadence the poll gave it) via a new `playerRetryTimerRef`, cleared on unmount next to `skipNoticeTimerRef` (TICKET-18 one-timer-per-concern hygiene). `playerEpoch` is already the deterministic rebuild channel the watchdog's `recreate` rung uses, so this reuses an existing mechanism rather than adding one.

I swept the component for other behavior that depended on `queue` changing identity every poll and found none: the watchdog effect depends on `[ytReady, skipUnplayable]` (both stable), the mic-call effect on the derived `nowPlayingId`/`nowPlayingIsSing` scalars, and `fetchQueue` on `roomQuery`. The `!nowVideoId` branch's repeated `stopVideo()` and the `currentVideoIdRef !== nowVideoId` guard were already no-ops on an unchanged queue. The reviewer was asked to re-derive this sweep independently rather than take it on trust.

Nothing else touched. `components/tv/config.ts`, `app/(patron)/[room]/tv/page.tsx`, `e2e/*`, `jest.config.ts` are untouched (sibling-owned).

## Implementation notes

### 1. Layer-1 clamp — approach chosen: mirror Layer 2's marker

`TvScreen`'s Layer 1 effect called `shouldProactivelyReload` directly and reloaded on a bare `true`. It now calls the shared `selfHealReload(...)`, which reads the `boraoke-tv-selfheal-reload` marker and delegates to `shouldSelfHealReload` — the combined decision that `self-heal.ts` already documents as "the reactive debounce guards BOTH paths so nothing can storm the page". Layer 2 was refactored into the same function; its decision is bit-identical (`shouldSelfHealReload({ got401: true })` is `shouldReactivelyReload` followed by an unconditional `true`).

**Why not the `tokenAgeMs >= 0` clamp:** the reported failure is a clock running *ahead* of the server, which yields a large **positive** bogus age; a `>= 0` clamp does nothing about it. The clock-*behind* case it would guard is already inert, because `shouldProactivelyReload` tests `tokenAgeMs >= SELF_HEAL_TOKEN_MAX_AGE_MS` and a negative age never satisfies that. Adding the clamp would be dead code shaped like a fix. Instead the negative-age case is now pinned by a regression test, so a future refactor to (say) an absolute-value age cannot silently reintroduce a reload there.

**Residual (recorded, not hidden):** under a sustained >20h skew the page reloads once per 5-minute debounce window rather than never — a ~300x reduction from once per 60s, still strictly idle-gated. A fully skew-proof version (anchor the age to page-mount time via `performance.now()`, since a just-server-rendered page cannot legitimately observe a 20h-old token) is deliberately not built; it is more machinery than a fault mode that already implies broken TLS earns. See the ticket for the follow-up note.

### 2. Marker clear

`advance()` removes the sessionStorage key when `advanceRes.ok` (2xx). Only on success: a 429 or 5xx says nothing about token validity, so the storm guard must stay armed. Verified this cannot re-open the Layer-1 skew loop: Layer 1 only fires while idle (empty queue), and an idle TV issues no advances, so nothing clears the marker in that state.

### 3. `setQueue` if-changed

Both write sites use `setQueue((prev) => (queueItemsEqual(prev, items) ? prev : items))` — returning `prev` makes React bail out of the render. `advance()` still derives its return value (`items[0]?.videoId`) from the freshly fetched `items`, so callers are behaviorally unchanged whichever branch is taken.

The comparator is a structural deep walk that **fails toward "changed"**, because a false "unchanged" would freeze the TV on a stale queue — far worse than the churn. Rejected alternatives, both recorded in code comments: a hand-listed field compare (silently stops seeing fields added to `QueueEntry` later — exactly the freeze mode) and `JSON.stringify` equality (key-order sensitive, drops `undefined`). Non-plain objects fall back to identity so a key-walk cannot call two different `Date`s equal.

## No behavior change in log mode — the proof

Prod runs with `ADVANCE_AUTH` unset ⇒ log-only mode. Walking each changed path:

1. **Layer 2 is dormant, exactly as before.** In log mode `app/api/queue/advance/route.ts` only 401s under `mode === "enforce"` (verified at the source: `if (!auth.ok) { if (mode === "enforce") return ... 401 }`, otherwise it `console.warn`s and proceeds). Advance never returns 401, so the `status === 401` branch — the only caller of the reactive path — is unreachable. Unchanged.
2. **Layer 1 fires strictly less often, never more.** Old condition: `shouldProactivelyReload(...)`. New condition: `shouldReactivelyReload(marker) && shouldProactivelyReload(...)` — a strict conjunction with the old predicate. It cannot newly reload in any state where the old code did not. The only observable difference is *suppressing* a reload inside the 5-minute window, which in a healthy venue never occurs (legitimate proactive reloads are ~20h apart; pinned by the test `the healthy ~20h cadence is NOT suppressed by the marker`).
3. **The marker clear is log-mode inert.** In log mode the key is only ever written by Layer 1 (Layer 2 being unreachable, per 1), and only after a reload. Removing it can therefore only re-permit a Layer-1 reload that the old code would have permitted anyway (the old code had no marker at all). Strictly closer to the old behavior, never further from it.
4. **The `setQueue` diff is not observable behavior at all.** The state's *contents* are identical in both branches — only the object identity, and therefore whether React re-renders, differs. `nowPlaying`/`upcoming` are derived from `queue`, so the rendered DOM is unchanged; the player effect's `currentVideoIdRef !== nowVideoId` guard already made it a no-op on an unchanged queue, so skipping the re-render removes work, not effects.

Net log-mode delta: **zero**, other than fewer needless re-renders and at most one fewer reload during a >20h-skew storm.

## Dev verification — real observed output

### `npm test` (full suite)

```
PASS __tests__/api-mode.test.ts
PASS __tests__/metadata.test.ts
PASS __tests__/host-stats.test.ts
PASS __tests__/tv-config.test.ts
PASS __tests__/api-queue-rooms.test.ts
PASS __tests__/tv-self-heal.test.ts

Test Suites: 43 passed, 43 total
Tests:       653 passed, 653 total
Snapshots:   0 total
Time:        5.11 s
Ran all test suites.
```

All 43 suites pass. This branch's only test change is `tv-self-heal.test.ts`, which went from 19 to 59 tests (+40) — so the derived pre-branch total is 613. No pre-existing test was modified or skipped.

### `npx jest __tests__/tv-self-heal.test.ts` (the ticket's suite)

```
PASS __tests__/tv-self-heal.test.ts
  ...
  TICKET-62: Layer 1 proactive path is clamped by the shared marker
    ✓ the raw predicate would loop forever under a >20h-ahead clock (2 ms)
    ✓ routed through shouldSelfHealReload, the first check heals once
    ✓ and every subsequent 60s check inside the window is suppressed (1 ms)
    ✓ a >20h-BEHIND clock (negative age) never reloads at all
    ✓ the healthy ~20h cadence is NOT suppressed by the marker
    ✓ a skewed clock still never reloads mid-song
  TICKET-62: clearing the marker after a successful advance
    ✓ a lingering marker suppresses the next 401 heal (the bug)
    ✓ after the clear (marker absent → null), the same 401 heals immediately
    ✓ clearing does not re-open the storm: the next attempt re-arms the marker
  queueItemsEqual — the NEGATIVE direction (must never miss a change)
    ✓ an ADDED entry is a change
    ✓ a REMOVED entry is a change
    ✓ a REORDER of the same entries is a change (1 ms)
    ✓ a head swap (now-playing changes) is a change
    ✓ a changed id field is a change
    ✓ a changed videoId field is a change
    ✓ a changed title field is a change
    ✓ a changed nickname field is a change
    ✓ a changed patronUuid field is a change
    ✓ a changed table field is a change
    ✓ a changed mode (status change) field is a change
    ✓ a changed submittedAt field is a change (1 ms)
    ✓ a changed graceRequeue flipped on field is a change
    ✓ a graceRequeue flipped false→true is a change (falsy values count)
    ✓ an OPTIONAL field appearing is a change
    ✓ an OPTIONAL field disappearing is a change
    ✓ an explicit-undefined field is NOT equal to a missing field
    ✓ a field the entry shape does not have YET is still compared
    ✓ empty vs non-empty (queue drained / first submission) is a change
    ✓ type-shifted values are a change (string '3' vs number 3, null vs absent) (1 ms)
    ✓ nested-object and nested-array changes are seen
    ✓ an array is never equal to a same-shaped object
    ✓ non-plain objects fall back to identity (never falsely equal)
  ...

Test Suites: 1 passed, 1 total
Tests:       59 passed, 59 total
```

### `npx tsc --noEmit`

The repo has **no `@types/jest` installed**, so a bare `tsc --noEmit` emits ~2029 `TS2582`/`TS2304` "Cannot find name 'describe'/'it'/'expect'" errors across *every* test file and the `e2e/` specs — a pre-existing, repo-wide condition on files this branch does not touch. Filtering that class out, the complete remaining output is pre-existing errors in `advance-rate-limit`, `api-admin-analytics`, `feedback-store`, `host-api`, `host-auth`, `identity-store`, `pending-store`, `screen-token`, `store`, `telemetry-store`, `tv-watchdog`, `youtube-search` and `e2e/advance-auth.spec.ts` — none of them files this branch touches.

```
$ npx tsc --noEmit 2>&1 | grep -E "^(components|app|lib)/"
(none)

$ npx tsc --noEmit 2>&1 | grep -v "TS2582\|TS2304" | grep "tv-self-heal"
(none)
```

Zero errors in `components/`, `app/`, `lib/`, and zero non-baseline errors in the changed test file. (An `it.each` I first wrote produced two new `TS7006` implicit-any errors; it was rewritten as an explicit typed loop, and the re-run above confirms they are gone.)

### `npm run build`

```
   ▲ Next.js 15.5.20

   Creating an optimized production build ...
 ✓ Compiled successfully in 1698ms
   Linting and checking validity of types ...
   Collecting page data ...
   Generating static pages (0/31) ...
   ...
├ ƒ /api/queue/advance                     176 B         103 kB
...
└ ƒ /tv                                    176 B         103 kB
+ First Load JS shared by all             102 kB
```

Green — and `next build`'s "Linting and checking validity of types" step (which uses the project's real type/lint config over the app tree, rather than a bare `tsc` over the whole repo) passed clean.

## Post-review changes (opus reviewer, `work/reports/review/TICKET-62-review.md`)

The reviewer returned **APPROVE-WITH-FOLLOWUPS**. Applied before the PR:

- **Finding 5 (NIT), applied.** `deepEqualJson`'s key-set check was count + one-way `hasOwnProperty` over `a`'s keys, which a non-enumerable own property on `b` defeats (equal counts, `b`'s extra enumerable field never compared → a false "unchanged"). Unreachable from a `JSON.parse`-derived payload, but the module's contract is fail-toward-changed *unconditionally*, and both-direction containment costs nothing. Now checked both ways, with a test that constructs the exact `Object.defineProperty` shape.
- **Finding 8 (NIT), applied.** Test-file header docblock rewritten — it claimed to be TICKET-46 self-heal tests while ~45% of the file is now comparator tests.
- **Finding 1 (SHOULD-FIX), recorded in the ticket.** Sharing one marker between layers means every Layer-1 reload also arms Layer 2's debounce, so a genuine 401 within 5 minutes of a proactive reload is now suppressed where it previously was not (enforce-only, bounded at 5 min). Accepted deliberately — a page that just reloaded holds a freshly minted token, so an immediate 401 signals bad config, exactly the storm case the debounce exists for — and written into the ticket's residual section rather than left to be discovered later.
- **Finding 7 (NIT), applied:** this report now describes the shipping diff (§3a and the file table above).
- **Findings 2 and 3 (SHOULD-FIX), deferred as follow-up cards**, listed under the ticket's out-of-scope section: (2) the mount-anchored skew-proof token age; (3) a jsdom jest project plus a `TvScreen` wiring test — 15 of the new tests would pass verbatim against `origin/main`, so the *wiring* fixes carry no regression protection. That is a structural limit: `jest.config.ts` is node-env and `.test.ts`-only, and it is a sibling-owned forbidden file on this ticket.
- **Finding 6 (NIT), no action, agreed.** `deepEqualJson` recurses without a depth guard and would stack-overflow on a cyclic input — unreachable, since both operands are always `JSON.parse` output or the initial `[]`. Worth knowing that the throw would land in React's updater rather than inside `fetchQueue`'s `try`, so it would white-screen rather than be swallowed; the note is in the ticket for whoever grows the entry shape.
- **Finding 4** is the regression I found and fixed during dev (§3a); the reviewer derived it independently and verified the fix.

### Re-verification after those edits

```
Test Suites: 43 passed, 43 total
Tests:       654 passed, 654 total
Snapshots:   0 total

 ✓ Compiled successfully in 1837ms
   Linting and checking validity of types ...
 ✓ Generating static pages (31/31)
```

(654 rather than 653: the finding-5 non-enumerable-property test.)

## Gates

- **Dev verification:** PASS (above).
- **App Tester gate:** **PASS.** Idle poster rendered; 13 `/api/queue` polls over ~40s at a consistent ~3s cadence; **no spurious reload** over 52s idle (sentinel `window.__t62` unchanged at `1785967081155`, navigation type `"navigate"` never `"reload"`, `sessionStorage['boraoke-tv-selfheal-reload']` `null` throughout); a submitted song appeared on the TV within one poll cycle (proving the if-changed diff does not freeze on a stale queue); skip advanced to the second song with the marker still `null`. `e2e/tv.spec.ts` **4/4 passed** — the known TICKET-65 flake did not reproduce. Console showed only YouTube ad-pixel CORS noise. Evidence under `work/evidence/TICKET-62/` (commit `b8d4a11`).
- **Reviewer gate (opus, clean context):** **APPROVE-WITH-FOLLOWUPS** → all gating items applied above. `work/reports/review/TICKET-62-review.md`.

## Out of scope

The **double-advance guard** (player `ENDED` and the watchdog skip can both fire an advance) is a known follow-up, deliberately serialized after this ticket because it touches `TvScreen.tsx`. Not implemented here. One observation that bears on it: `advance()` remains un-serialized — there is no in-flight flag on it (unlike `skipUnplayable`, which has `skippingRef`), so the `onStateChange` ENDED handler and the watchdog's `advance` rung can genuinely overlap. Both now share the single `selfHealReload` path, which is idempotent under concurrency (the marker write is last-writer-wins and a reload ends the page anyway), so this diff neither creates nor worsens the double-advance race — but it does not fix it either.
