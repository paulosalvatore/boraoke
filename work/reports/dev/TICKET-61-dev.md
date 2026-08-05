# TICKET-61 — Dev verification report

Branch `ticket/61-paste-embeddability-warning`, worktree `.worktrees/ticket-61`. Deps installed with `npm ci`. No `.env`, no YouTube API key present — every check below runs against mocks.

## `npm test` (full suite)

```
Test Suites: 43 passed, 43 total
Tests:       637 passed, 637 total
Snapshots:   0 total
Time:        5.099 s
Ran all test suites.
```

637 = 615 pre-existing + 22 new (10 in `__tests__/youtube.test.ts`, 12 in `__tests__/api-queue.test.ts`). Targeted re-run of the two touched suites:

```
PASS __tests__/youtube.test.ts
PASS __tests__/api-queue.test.ts

Test Suites: 2 passed, 2 total
Tests:       51 passed, 51 total
```

Note: the suite prints a pre-existing `console.warn` from `app/api/queue/advance/route.ts:47` (`[advance-auth] would-block ... mode=log`) during `queue-advance-song-played-props.test.ts`. Unrelated to this ticket, present on `main`.

## `npx tsc --noEmit`

**Honest reading: the repo has no clean `tsc` baseline.** `@types/jest` is not a dependency, so every test file already fails to resolve `describe`/`it`/`expect`/`jest`. Measured both sides:

```
baseline (git stash -u, i.e. origin/main state):  2017 error lines
with this branch's changes:                       2116 error lines
errors in app/ , lib/ , components/ :                0
```

The +99 delta is entirely `TS2304: Cannot find name 'jest' / 'expect'` and `TS2582: Cannot find name 'it'` inside my new test blocks — the identical class of error as the 2017 pre-existing ones, caused by the missing `@types/jest`, not by anything this branch introduced. Production code (`app/`, `lib/`, `components/`) typechecks with **zero** errors, and `next build` runs the real type check over it (below). There is no `typecheck` npm script; the project's actual type gate is the build.

One further pre-existing error outside my file list: `e2e/advance-auth.spec.ts(12,60): TS2353 ... 'method' does not exist`. Present on `main`, owned by another ticket.

## `npm run build`

```
 ✓ Compiled successfully in 1514ms
   Linting and checking validity of types ...
...
├ ƒ /api/queue                             176 B         103 kB
...
+ First Load JS shared by all             102 kB
```

Build completed with routes emitted; no errors, no lint failures. The only warning is the pre-existing `Next.js inferred your workspace root` lockfile notice.

## What the new tests actually prove

- `checkEmbeddable` returns `embeddable` / `not-embeddable` for the two real verdicts, and `unknown` for **all seven** failure modes: no key, invalid id (no call made), 403 `quotaExceeded`, 5xx, thrown network/timeout error, malformed JSON, empty `items`.
- It hits `https://www.googleapis.com/youtube/v3/videos` with `part=status`, `id`, `key` as query params, exactly once, with an `AbortSignal`.
- Route level (mocking `global.fetch`, so the **real** `checkEmbeddable` code path executes): non-embeddable paste → 201 + warning + entry actually in the store; embeddable paste → `{ok:true}` exactly; all four fail-open modes → 201, no warning, entry stored; three search-path variants (`source:"search"`, no `source`, unknown `source`) → **zero** outbound calls; a URL-only body is treated as a paste and is checked; a 400-rejected submit spends no quota.
- Response shape is asserted key-by-key: `Object.keys(json).sort() === ["ok","warning"]` — no `patronUuid`, no `entry`, no `videoId`.
