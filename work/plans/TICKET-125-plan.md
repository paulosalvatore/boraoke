# TICKET-125 — plan

**APPROVED-BY:** TM dispatch brief 2026-10-14 (the brief is the approved design; no separate plan gate requested). Validated downstream by gates + merge.

## Approach

1. **Server: an explicit live permission (`app/api/search/route.ts`).** A first-page request is **index-only by default**: it is answered from the free tiers (cache → karaoke index) and, when neither answers, returns `200 { results: [], liveRequired: true }` without touching the key, the daily budget or Google. A request may bill only when it carries `live=1` (Enter, idle, "search again") or a `pageToken` (a deliberate "load more" tap, including the `IDXLIVE` escape). Fail-closed: an old or naive client that sends nothing cannot bill.
2. **Server: a per-uuid live cooldown (`lib/live-search-gate.ts`).** Immediately before the daily-budget reservation, a uuid that already made a billed attempt in the last 2 s gets `200 { results: [], deferred: "live-cooldown", retryAfterMs }`. A modified client that sends `live=1` on every keystroke therefore gets at most one billed call per 2 s per uuid; uuid rotation stays bounded by the existing per-IP bucket and the TICKET-87 platform daily cap.
3. **Server: separate, generous rate buckets for index-only requests** (`lib/youtube-search.ts`). They cost nothing billed, and the existing strict 5 per 10 s per-uuid bucket would trip on normal as-you-type lookups.
4. **Client trigger logic as a pure, timer-injected module (`lib/search-trigger.ts`)**: `LiveSearchTrigger` (idle timer, once-per-text guard, late-miss handling, Enter) and `isSearchKey` (Enter, not during IME composition). Unit-testable with jest fake timers in the node test env.
5. **`components/SongSearch.tsx`**: as-you-type fetches become index-only (debounce unchanged); an index miss shows a subtle trilingual hint and arms the idle timer; Enter / the phone search key fires a live-allowed request immediately; `enterKeyHint="search"`, `inputMode="search"`; the `deferred` reply is retried once after `retryAfterMs` if the text is unchanged.
6. **Measurement (`work/measurements/ticket-125/replay.ts`)**: the TICKET-124 replay with a timing model. Traces carry no timestamps, so each intermediate trace element (a pause ≥ 400 ms in production) fires the idle search with probability S(N) = P(pause ≥ N | pause ≥ 0.4 s) under a stated pause model, swept over S; the final element always settles (Enter or idle). Monte Carlo with a fixed seed; controls: S = 1 must reproduce PR #88's 26 billed / 1.22 exactly.

## Idle value

Chosen from the replay's S-sweep plus the stated pause model (phone typing cadence, bar context, cost of a wasted billed call = 1% of the platform's daily search budget). Justification recorded in `lib/search-trigger.ts` and the PR.

## Risks

- **Deploy skew:** a browser still running the pre-#125 bundle sends no `live=1`, so on an index miss it gets an empty list until reload (its "load more" escape still works). Disclosed in the PR for the TM.
- No real keystroke timing exists; the timing model is an assumption and is labelled as such.
- The cooldown is per instance (in-memory), like the existing rate limiter; the cross-instance hard cap remains the TICKET-87 budget.

## Test strategy

Jest: trigger unit tests with fake timers (idle fires once at N, not before; re-arms after an edit; Enter fires immediately and cancels idle; index hit never fires; late miss after the idle deadline fires); route tests (index-only never fetches Google or reserves budget, `live=1` bills, pageToken bills, cooldown defers, separate rate buckets). Mutation pass on the idle constant, the once-guard, the Enter key check and the server's default. e2e (Playwright `page.clock`): index miss → hint, no live call; Enter → one `live=1` call; idle → exactly one live call after N, none before, none repeated; index hit → no live call; `enterkeyhint="search"`.
