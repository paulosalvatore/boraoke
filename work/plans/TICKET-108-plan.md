# TICKET-108 — Plan: stop billing a `search.list` call per keystroke

**Branch:** `ticket/108-keystroke-billing` · **Worktree:** `.worktrees/t108-keystroke-billing`
**Status:** implemented, gates run. Measurement decided the design, so this plan records the design that the measurement selected rather than one written ahead of it (see "Sequencing" below).

## Sequencing, stated honestly

This ticket is measurement-first by construction: the guardrail it carries ("if quality measurably degrades, stop and report up") makes the measurement the thing that chooses the design, not a check applied afterwards. So the order of work was: build the oracle → build the replay harness → measure every candidate policy → implement the one variant that holds quality. The plan below is the outcome of that, and the alternative it rejected is documented with the number that rejected it rather than with an argument.

## Approach

A pure planner, `lib/search-prefix.ts`, decides per keystroke whether the app must spend one of the platform's 90 daily `search.list` calls:

| Situation | Decision |
|---|---|
| nothing held | `fetch` (`no-held-results`) |
| the query folds to the same string as the held one (`mana` → `maná`) | `filter`, held rows handed back untouched |
| not an extension of the held query (unrelated query, or a backspace) | `fetch` (`not-an-extension`) |
| an extension, and ≥ `MIN_LOCAL_MATCHES` held rows still match | `filter` — narrow locally, **zero calls** |
| an extension, but narrowing leaves fewer than that | `fetch` (`local-matches-starved`) |

The last row is the whole reason this is a decision function rather than the ticket's simpler "an extension never refetches". A short prefix's real top-50 may not contain the song at all, and blindly narrowing it makes results worse while the quota graph looks excellent. Starvation is positive evidence the held page is the wrong page.

`components/SongSearch.tsx` consults the planner **before** scheduling the debounce, and the `filter` branch applies immediately with no debounce at all — there is nothing to amortise when no call is being made, so narrowing feels instant.

## Files touched

- `lib/search-prefix.ts` — new. `normalizeQuery`, `queryTokens`, `isExtensionOf`, `filterResults`, `MIN_LOCAL_MATCHES`, `planSearch`. Pure, no React, no `server-only` (jest here is node-env).
- `components/SongSearch.tsx` — held-page state (`heldRows` + a `heldRef` mirror) separated from displayed rows; `filterQuery` separated from `resultsQuery`; `MIN_CHARS` 3 → 4; `loadMore` appends to the held pool and re-applies the narrowing.
- `__tests__/search-prefix.test.ts` — new unit suite, including a replay of the real production ladder against the real production pages.
- `e2e/search.spec.ts` — three new call-COUNT tests that type in chunks with pauses past the debounce.
- `work/measurements/ticket-108/` — the oracle fixture, the graded query set, the replay harness, and its captured output.
- `package.json` — `measure:t108` script.

## Risks, and how each is handled

- **The false win (the ticket's central risk).** Handled by the starvation guard and *measured*: the naive variant is control C1 in the harness and drops hit@10 from 79% to 36%.
- **Breaking TICKET-83's "a mode flip can never re-trigger a fetch".** The held page is read through a **ref** inside the search effect, exactly as `modeRef` is, so landing a fetch does not change the effect's dependencies. The effect stays keyed on `[input, runSearch]`. The existing e2e assertion for this still passes.
- **Self-filtering a fresh page.** YouTube legitimately returns rows whose titles do not contain the query (production: "escurinho do cinema" surfaces Rita Lee's "Flagra", a lyric match). A freshly-fetched page is therefore rendered untouched; narrowing is only ever applied to a strict extension.
- **`load more` pairing a narrowed query with the held page's cursor** — a guaranteed cache miss and a wasted daily call. `queryDirty` is re-keyed to `filterQuery`, and a new e2e test asserts the deep request carries the HELD query.
- **Pasted YouTube links must stay call-free.** The paste branch clears the held pool and never becomes one; the existing AC2 e2e coverage still passes.

## Test strategy

Unit suite on the planner (mutation-proofed, 8/8 mutants killed) plus a replay of the real ladder; e2e call-count tests that pause past the debounce, so they fail on the pre-fix code. Both instruments of `prove-your-test-can-fail` are run and their verbatim output is in the dev report.

## Nothing needed from the Tech Lead to ship this

Quality holds, so the ticket's own rule says ship. What the measurement *does* surface for him is separate and is written up at the end of the dev report: the safe fix buys 40%, not the 4x the spike's framing hoped for, and the remaining gap is exactly the as-you-type-vs-on-submit feel decision this ticket deliberately refused to take on his behalf.
