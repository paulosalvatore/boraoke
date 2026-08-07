# TICKET-62 — TV kiosk client hygiene (reload clamp, marker clear, setQueue if-changed diff)

**Source:** three recorded nits from prior opus reviews of TICKET-46 / the TV work. All three land in the same two files (`components/tv/self-heal.ts`, `components/tv/TvScreen.tsx`), so they ship together.

**Context:** `/tv` is a kiosk screen running unattended in venues. A regression there cuts a singer off mid-song, so correctness beats cleverness throughout.

## Nit 1 — Layer-1 proactive-reload clamp

**Observed:** `TvScreen`'s Layer 1 effect called `shouldProactivelyReload({ tokenAgeMs, isPlaying })` **directly** and reloaded on a bare `true`, bypassing the `sessionStorage` one-shot marker that Layer 2 uses. `tokenAgeMs` is computed client-side as `Date.now() - screenTokenMintedAt`, so a kiosk whose browser clock runs **more than 20h ahead** of the Vercel server computes a permanently-bogus "old" token. Worse, a reload cannot cure it: the re-minted token carries the *server's* clock, so it reads as 20h+ old again the instant the page comes back. The 60-second re-check then reloads forever.

**Severity: genuinely low.** It needs ~a full day of clock skew (which would already break TLS), and the path is strictly idle-gated (`isPlaying` false), so it can never cut off a live singer. It is a fix, not a firefight — do not over-engineer it.

**Fix chosen: mirror Layer 2's marker onto Layer 1 (route both layers through `shouldSelfHealReload`).**

Justification, and why the alternative was rejected:

- **`tokenAgeMs >= 0` clamping does not fix the reported bug.** The failure is a clock running *ahead*, which produces a large **positive** bogus age. A `>= 0` clamp only guards the clock-*behind* case, and that case is already inert — `shouldProactivelyReload` tests `tokenAgeMs >= SELF_HEAL_TOKEN_MAX_AGE_MS`, and a negative age never satisfies it. Adding the clamp would be dead code that reads like a fix. (A regression test now pins the negative-age case instead, so a future refactor to e.g. an absolute-value age cannot silently reintroduce a reload there.)
- **The marker approach adds zero new concepts.** `self-heal.ts` *already* declares this intent — `shouldSelfHealReload`'s body carries the comment "The reactive debounce guards BOTH paths so nothing can storm the page." The combined function was written for exactly this and then never wired up; `TvScreen` reached past it to the raw predicate. So the defect is purely a wiring bug, and the fix is to use the module's own combined decision: no new constant, no new storage key, no new state.
- **It does not cost the feature its job.** A legitimate proactive reload lands on a *fresh* token, so the next legitimate one is ~20h away — orders of magnitude outside the 5-minute debounce window. Pinned by a test.

**Second-order effect of sharing one marker (raised by the reviewer, recorded here):** because both layers now draw on the same debounce budget, every Layer-1 reload — legitimate or skew-driven — arms the marker, so a genuine 401 arriving within 5 minutes of a proactive reload is suppressed where previously it was not. Under sustained skew that becomes a standing condition. It is bounded at 5 minutes, only reachable under `ADVANCE_AUTH=enforce`, and defensible on its own terms (a page that *just* reloaded already holds a freshly minted token, so an immediate 401 indicates a bad config rather than an aged token — precisely the case the debounce exists to stop storming). Accepted deliberately, not overlooked.

**Residual, recorded honestly:** under a sustained >20h skew the page still reloads once per 5-minute debounce window rather than never. That is a ~300x reduction from once per 60s, it stays idle-gated, and it is proportionate to a fault mode that already implies broken TLS. A fully skew-proof version would anchor token age to page-mount time (using `performance.now()` for the monotonic elapsed part, since a page that was *just* server-rendered cannot legitimately observe a 20h-old token) — deliberately **not** built here; it is more machinery than the severity earns. Noted as a possible follow-up.

## Nit 2 — Clear the self-heal marker on success

**Observed:** the `boraoke-tv-selfheal-reload` sessionStorage marker was written on a heal attempt and never removed, so it lingered for the whole kiosk session. TICKET-46's own spec asked for this ("Clear/re-evaluate the marker on a successful advance") and it was not implemented. Benign as shipped, but a stale marker suppresses the *next* genuine 401 heal for up to 5 minutes.

**Fix:** `advance()` removes the key when the advance response is 2xx (`advanceRes.ok`). A success proves the current token is accepted, so the storm guard has done its job. Cleared only on success — a 429 (rate limit) or 5xx says nothing about the token, so the marker stays.

**Checked for a re-opened storm:** clearing cannot resurrect the Layer-1 skew loop. Layer 1 only fires while idle (empty queue), and an idle TV issues no advances, so there is nothing to clear the marker.

## Nit 3 — `setQueue` if-changed diff

**Observed:** the 3s `/api/queue` poll (and the post-advance refetch) wrote the fetched items into state unconditionally. A kiosk therefore re-rendered the entire TV ~20x/minute forever, even with a completely static queue.

**Fix:** `setQueue((prev) => (queueItemsEqual(prev, items) ? prev : items))`. Returning `prev` from the updater makes React bail out of the render entirely.

**The dangerous direction is a false "unchanged"** — that would freeze the TV on a stale queue, far worse than the churn being fixed. So the comparison is built to **fail toward "changed"**:

- Structural deep walk (`deepEqualJson`), **not** a hand-listed field compare: a field-list comparison silently stops seeing any field added to `QueueEntry` later, which is precisely the freeze failure mode. A structural walk covers shape growth for free.
- **Not** `JSON.stringify(a) === JSON.stringify(b)`: stringify is key-order sensitive (noisy) and drops `undefined` values (subtly wrong).
- `Object.is` fast path — `NaN` equals `NaN`; `0`/`-0` count as changed.
- Differing key **sets** are unequal, so `{ title: undefined }` ≠ `{}` (a field appearing/disappearing is a real change).
- Arrays are order-sensitive — a queue reorder IS a change.
- Non-plain objects (`Date`, `Map`, class instances) fall back to identity, so a naive own-key walk cannot call two different `Date`s equal. These cannot appear in a JSON queue payload, but the guarantee must hold regardless.

Inputs come from `JSON.parse`, so cycles are impossible and no depth guard is needed.

## Acceptance criteria

- **No behavior change in log mode** (prod runs `ADVANCE_AUTH` unset ⇒ log-only). Proven in the dev report.
- `__tests__/tv-self-heal.test.ts` covers the clamp (including the >20h-ahead clock case) and the marker clear.
- A poll returning an identical queue causes no re-render; a poll returning **any** real change (reorder, add, remove, field change, status change) still re-renders. Both directions tested.

## Out of scope

- **The double-advance guard** (player `ENDED` and the watchdog skip can both fire an advance) is a known related follow-up, deliberately serialized *after* this ticket because it touches the same file. Not implemented here.
- The mount-anchored, fully skew-proof token age described under Nit 1. **Follow-up card to file** (reviewer finding 2: it must not survive only as prose in a closed ticket).
- **A jsdom jest project + a `TvScreen` wiring test.** Reviewer finding 3: the nit-1/nit-2 defects were *wiring* bugs in `TvScreen.tsx`, but `jest.config.ts` is `testEnvironment: "node"` / `testMatch: ["**/__tests__/**/*.test.ts"]`, so no component test can run — and `jest.config.ts` is a sibling-owned, forbidden file on this ticket. Consequently 15 of the new tests characterize decision semantics that were already correct and would pass against `origin/main`; a revert of the wiring would go undetected. `@testing-library/react` and `@testing-library/jest-dom` are already devDependencies, so this is a small lift. **Follow-up card to file.**
- `components/tv/config.ts`, `app/(patron)/[room]/tv/page.tsx`, `e2e/*`, `jest.config.ts` — owned by sibling tickets.
