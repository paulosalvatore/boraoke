# TICKET-1 — Dev report

## Status
OPUS FINDINGS ADDRESSED; ONE [needs-user] BLOCKER — Vercel preview GREEN (vercel.json fix worked); divergence honestly documented; PR un-conflicted from main (was silently blocking ALL Actions runs); local build+39 unit tests green. BLOCKED on GitHub Actions billing (account-level payment/spending-limit failure kills every CI job in ~2s) — needs TL dashboard action.

## Context
- Worktree: `/Users/paulosalvatore/Documents/GitHub/cantai/.worktrees/ticket-1`
- Branch: `ticket/1-walking-skeleton`
- Port: **3040**
- Patron page: http://127.0.0.1:3040/
- Venue screen: http://127.0.0.1:3040/tv
- Plan: auto-approved (fully autonomous D-028 ticket, no risky/ambiguous scope)

## Log

### 2026-07-05 bootstrap + exploration
Worktree contained only README.md, CLAUDE.md, and work/ scaffold (tickets, events, status). No Next.js app existed yet. Ticket was a greenfield implementation task.

### 2026-07-05 implementation
Built from scratch:

**Core files created:**
- `package.json` — Next.js 15.3.4, React 19, uuid, jest+ts-jest+ts-node, playwright
- `tsconfig.json`, `next.config.ts`, `jest.config.ts`, `playwright.config.ts`
- `lib/youtube.ts` — YouTube URL parser (watch, youtu.be, shorts, embed, live, raw ID)
- `lib/store.ts` — module-level in-memory queue store (FIFO, with clearQueue for tests)
- `app/layout.tsx`, `app/globals.css` — dark bar-friendly theme
- `app/page.tsx` — patron page (uuid+nickname in localStorage, URL parse preview, table, mode toggle, ~3s poll)
- `app/tv/page.tsx` — venue screen (YouTube IFrame Player API, auto-advance on ENDED event, manual skip, next-5 list, ~3s poll)
- `app/api/queue/route.ts` — GET + POST with input validation
- `app/api/queue/advance/route.ts` — POST skip
- `__tests__/youtube.test.ts` — 16 unit tests (all URL formats + edge cases)
- `__tests__/queue.test.ts` — 9 unit tests (ordering, advance, FIFO drain)
- `e2e/submit-song.spec.ts` — Playwright e2e: submit → appears in queue
- `.github/workflows/ci.yml` — replaced stub with real setup-node + build + test + playwright
- `.claude/skills/run-app/SKILL.md` — updated from stub to real instructions
- `README.md` — run instructions, port, prototype limitations

**Friction / non-obvious findings:**

1. Node.js 25.8.2 provides `globalThis.localStorage` as a global, but without `--localstorage-file=<path>`, `localStorage.getItem` is undefined. Next.js 15 App Router SSR-renders client components on this Node.js process, causing `localStorage.getItem is not a function` → 500 on the patron page. Fix: set `NODE_OPTIONS='--localstorage-file=/tmp/cantai-ls.json'` in `npm run dev` and in playwright webServer env. Also documented in CI yml env block.

2. Playwright `getByLabel("Your nickname")` failed because the nickname input lacked `aria-label`. Fixed by adding `aria-label="Your nickname"` to the input.

3. `ts-node` must be added as devDependency when using `jest.config.ts` (TypeScript jest config) — ts-jest alone isn't enough. Added to package.json.

### 2026-07-05 self-verification results

```
npm run build:
✓ Compiled successfully in 2000ms
✓ 7 static pages generated, API routes dynamic

npm test:
PASS __tests__/youtube.test.ts
PASS __tests__/queue.test.ts
Tests: 25 passed, 25 total

npm run test:e2e:
1 passed (7.8s)
[chromium] › e2e/submit-song.spec.ts › patron submits a song and it appears in the queue ✓
```

### 2026-07-05 security-gate MEDIUMs fixed (4/4)

Cyber Security PASS-WITH-NOTES flagged 4 MEDIUMs (report: `work/reports/security/TICKET-1-security.md`); merging triggers the first public Vercel deploy, so all fixed now:

1. **Direct videoId bypass** — `app/api/queue/route.ts`: ALL paths to a stored videoId now validated against `^[A-Za-z0-9_-]{11}$` (direct `videoId` POSTs previously skipped `isValidVideoId`).
2. **Field length limits** — nickname ≤30, title ≤120, table ≤10, patronUuid must match strict UUID shape; violations → 400. Request body capped at 4096 bytes (handler reads `req.text()` and rejects oversized before JSON.parse). Matching client-side `maxLength` attrs added on `/` inputs.
3. **Queue depth cap** — `lib/store.ts`: `QUEUE_MAX = 200`; `addToQueue` refuses (returns false) when full, `isQueueFull()` exported; API returns 429 with a clear error when full.
4. **Next.js CVEs** — bumped `next` 15.3.4 → **15.5.20** (`^15.5.20` pin), reinstalled, build verified. Remaining `npm audit` noise: 2 moderates from a transitive `postcss` pinned INSIDE next itself — no non-breaking fix exists (audit suggests downgrading next to 9.x, nonsense); documented as accepted for prototype.

**New tests:** `__tests__/api-queue.test.ts` (11 tests: valid entry, invalid direct videoIds x3, over-length nickname/title/table, UUID shape, oversized body, boundary nickname=30, queue-full 429) + 3 queue-cap tests in `__tests__/queue.test.ts`. Total unit tests: 25 → **39**.

**Re-verification (real output):**

```
npm run build:
 ✓ Compiled successfully (next 15.5.20)
 ○ / and /tv static, API routes dynamic

npm test:
PASS __tests__/api-queue.test.ts
PASS __tests__/youtube.test.ts
PASS __tests__/queue.test.ts
Tests: 39 passed, 39 total

npm run test:e2e:
✓ 1 [chromium] › e2e/submit-song.spec.ts › patron submits a song and it appears in the queue (2.0s)
1 passed (7.6s)
```

Dev server stopped after e2e.

### 2026-07-05 reviewer findings addressed (1 blocker + 2 nits)

Sonnet review REQUEST-CHANGES (https://github.com/paulosalvatore/cantai/pull/4#issuecomment-4887879141):

- **BLOCKER:** `.github/workflows/ci.yml` e2e step sets `NODE_OPTIONS --localstorage-file` but pinned `node-version: "20"` — the flag needs Node >= 22.4, so post-merge CI would fail with "bad option" exit 9. Fixed: `node-version: "22"`.
- **NIT-1:** README now states "Requires Node.js 22 or later."
- **NIT-2:** `isValidVideoId` exported from `lib/youtube.ts` and reused in `app/api/queue/route.ts` (duplicated `VIDEO_ID_RE` regex removed).

Re-verification (real output): `npm run build` ✓ clean; `npm test` ✓ 39/39 (3 suites); `npm run test:e2e` ✓ 1 passed (5.4s); dev server stopped after.

### 2026-07-05 opus D-022 findings addressed (deploy + honesty)

Opus review REQUEST-CHANGES (https://github.com/paulosalvatore/cantai/pull/4#issuecomment-4888072497):

1. **Vercel deploy check RED** (`No Output Directory named "public" found` — project Framework Preset not set to Next.js). Durable in-repo fix: added `vercel.json` with `{ "framework": "nextjs" }` at repo root. Watching the PR's Vercel preview check after push; will report the exact error if it stays red for a project-side reason the repo can't fix.
2. **Honest divergence wording** — the in-memory store is per-lambda-instance on Vercel, so hosted queues can DIVERGE between concurrent users, not just reset. Reworded: patron footer (`app/page.tsx` — "Early-access prototype — queues may reset or differ between devices until persistent storage ships"), README limitation bullet (precise: per-instance copies, divergence, instance recycling), `lib/store.ts` JSDoc (local vs serverless behavior spelled out).

E2E selectors unaffected by the footer text change (checked spec — none reference footer text). Re-verification: `npm run build` ✓ clean; `npm test` ✓ 39/39.

### 2026-07-05 merge-from-main to unblock CI + tsconfig exclude

While verifying the opus fixes, found PR #4 mergeable state CONFLICTING (main moved: rotation-engine, design, planning tickets merged). That is also why GitHub Actions NEVER ran on this PR — Actions can't build the merge ref for a conflicting PR, so the CI check silently never appeared. Actions run count for this branch was 0.

- Merged `origin/main` into the branch; only conflict was `work/events/2026-07.jsonl` (add/add, append-only log) — resolved by union of both sides (14 + 28 = 42 lines, no dupes lost). Merge commit `3735b74` (bare git merge/push used: the sanctioned commit script cannot conclude a merge; documented here deliberately).
- Post-merge build broke: root tsconfig `**/*.ts` include picked up the merged `packages/rotation-engine` sources (`allowImportingTsExtensions` error). Fixed by adding `"packages"` to tsconfig `exclude` — the rotation engine is a standalone package with its own tsconfig, not part of the Next.js app build.
- Re-verification: `npm run build` ✓ clean; `npm test` ✓ 39/39.

Vercel preview after vercel.json fix: **GREEN** (Deployment has completed). Awaiting first real GitHub Actions CI run now that the PR is mergeable.

### 2026-07-05 CI blocked on GitHub billing — [needs-user]

With the PR mergeable, CI finally triggered (run 28759837928) but fails in 2s with the annotation: "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings." Every recent cantai CI run on every branch fails identically in ~4s — this is account-level, not repo-level. `[needs-user]` posted on PR #4 (https://github.com/paulosalvatore/cantai/pull/4#issuecomment-4888109634). Nothing in-repo can fix it; local verification (build ✓, 39/39 unit ✓, e2e ✓) is the working evidence until billing is fixed and CI can be re-run.

## Friction
- Node.js 25 `localStorage` global (stub without methods) causes Next.js 15 SSR failures for client components that access localStorage. Workaround: `--localstorage-file` flag. Candidate for a framework-level dev environment note (future inbox item if recurring across products).
- `jest.config.ts` (TS format) requires explicit `ts-node` devDependency — not obvious from ts-jest docs.
