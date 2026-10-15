# TICKET-125 — Search on Enter, plus an idle auto-search

**Filed:** 2026-10-14, by the boraoke Tech Manager (Global TM search-strategy follow-up).
**Priority:** HIGH — billed `search.list` calls are still the binding daily limit on the core patron flow.
**Type:** Feature / quota
**Size:** M
**Stacks on:** TICKET-124 (PR #88, karaoke index as the primary tier, not merged yet). This branch is cut from `ticket/124-index-primary` and its PR targets that branch until #88 merges.

## Tech Lead (verbatim)

> Search on enter, but consider searching if person isnt typing for 3-5 sec.

## Goal

Stop billing live YouTube searches while the patron is still typing. Free lookups (cache and the karaoke index) stay instant as you type; a billed live search happens only when the patron asks for it (Enter / the phone keyboard's search key, "load more", "search again") or after they stop typing for a few seconds.

## Scope

1. **Enter fires a live search immediately.** On a phone that is the keyboard's "search"/"go" key: set `enterKeyHint` / `inputMode` on the input.
2. **Idle auto-search.** Otherwise, auto-search ONCE after N seconds of no typing, N in 3-5 s. Pick a value and justify it. "Once" means no repeat for the same query text; a new idle period after further edits may fire again.
3. **Index-tier lookups stay instant as you type** (they are free). Only BILLED live calls follow the Enter/idle rule.
4. **Server enforcement.** The server must tell an index-only request from a live-allowed one, and a client must not be able to bypass this to get billed calls per keystroke. Document how.
5. **Copy.** Any new patron copy (e.g. a subtle "press Enter to search YouTube" hint) is trilingual (en/es/pt-BR) and minimal.
6. **Measurement.** Replay the TICKET-108/124 production traces with simulated timing; report billed calls per queued song BEFORE (PR #88: 1.22) → AFTER, with the timing assumption stated. hit@10 must not regress.

## Constraints

- No deploy, no production writes, no `search.list` spend during development.
- e2e: `workers: 1`, one suite at a time, check machine load first and that no other playwright/next process runs; `e2e/_canary` failing voids a run. Use fake timers / clock control for the idle behaviour, not real multi-second sleeps.
- TICKET-83's no-fetch-on-mode-flip, TICKET-87's fail-closed daily budget and TICKET-108's local narrowing must keep holding.

## Acceptance

Draft PR (base `ticket/124-index-primary`) with: the chosen idle value and its justification, calls-per-song BEFORE → AFTER with the timing assumption, hit@10, how the server enforces index-only vs live, tests with a prove-can-fail mutation of the idle timer and the Enter handler, jest + e2e results with run conditions.
