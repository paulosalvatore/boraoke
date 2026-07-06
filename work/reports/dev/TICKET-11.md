# Dev Report — TICKET-11: in-app feedback widget

- **Status:** IMPLEMENTED + security gate M1 folded — build green, **106/106** unit tests green, 3/3 e2e green, evidence captured. PR #11 open, Security PASS-WITH-NOTES.
- **Branch:** `ticket/11-feedback-widget` · **Worktree:** `.worktrees/ticket-11` · **Port:** 3011
- **Product:** cantai · **Wave:** 2 (parallel with TICKET-7 host controls, PRs #8/#9)
- **Author:** Dev agent · **Date:** 2026-07-05

## Picking up from

Fresh start. Pulled latest `main` (TICKET-6 persistence merged). Read the ticket, the authoritative spec (`work/planning/feedback-loop.md` Part A), and explored the codebase (persistence pattern, uuid/nickname source, layout, API pattern, design system, test setup).

## What was built

Zero-friction sentiment capture + durable store + admin read/write API, mounted globally via `app/layout.tsx`, hidden on `/tv`.

### Storage design (own module, own keys)

The frozen `QueueStore` interface (TICKET-6) is queue-shaped — no generic KV — and is off-limits (`lib/store*`). So feedback gets its OWN store that mirrors #6's driver-selection pattern:

- `lib/feedback-types.ts` — pure domain types/consts (no `server-only`, no React) shared by client widget + server route/store (single source of truth for sentiment/category/status enums).
- `lib/feedback-store.ts` (`server-only`) — `FeedbackStore` interface + `MemoryFeedbackStore` + `UpstashFeedbackStore` (injectable redis) + env-selected `feedbackStore` singleton. Same env contract as #6 (`STORE_DRIVER` / `UPSTASH_REDIS_REST_*`).
  - Keys: `feedback:index` (LIST of ids), `feedback:item:<id>` (JSON), `feedback:rl:<uuid>:<window>` (rate counter). Own namespace — never collides with `room:*`.
  - **Time-sortable ids** (`base36(ms)-rand`) → the admin `since` watermark is a clean lexicographic cursor, idempotent even if the cursor item was removed. `list()` sorts by id in both drivers, so ordering is robust regardless of index insertion order.
  - **Rate limit**: fixed 1-hour window counter, 5/uuid/hour, server-side + durable (Upstash `incr`+`expire`; memory bucket with reset).

**Honest volatility note (per ticket):** the memory driver is per-process — feedback under it is NOT durable/shared, exactly like the queue memory driver. Feedback MUST run on Upstash in production; the live app runs memory until Upstash is provisioned. Documented in the module header + `.env.example`.

### API — `app/api/feedback/route.ts`

- `POST` (public): body-size cap → JSON parse → validate sentiment (required, enum) + optional text (≤1000) + optional category (enum) + `context.uuid` (required, uuid regex — keys rate-limiting). Server **augments** context with `appVersion` (env `GIT_SHA`/`VERCEL_GIT_COMMIT_SHA`, fallback `dev`), coarse `userAgent` (from header, truncated), `createdAt` (server time) — never trusts the client for these. Rate-limit → 429 friendly pt-BR. Success → 201.
- `GET ?since=&limit=` (admin): `Authorization: Bearer <FEEDBACK_ADMIN_TOKEN>` — token NEVER shipped client-side, **fail-closed** when env unset. Returns `{ items, watermark }`.
- `PATCH` (admin): `{ id, status, triageRef? }` → intake status-update write path (`new → triaged`).

### Widget (design-system palette, scoped)

- `components/FeedbackWidget.tsx` (`use client`) — mounted in layout after `{children}`; `usePathname()` → renders `null` on `/tv` and `/tv/*` (AC7). Floating pill FAB + overlay/sheet + Escape-to-close + backdrop-click-close.
- `components/feedback/FeedbackSheet.tsx` — 4 sentiment faces (😍🙂😕😡), optional textarea, optional category chips. **Tapping a sentiment IS the submit** → sentiment-only in 2 taps (FAB + face); typed text/chips ride along. Confirmation states the promise (pt-BR): "Um robô supervisionado por humanos lê cada um desses. Fica de olho no changelog."
- `components/feedback/useFeedbackContext.ts` — reads uuid/nickname from localStorage (`cantai_patron_uuid`/`cantai_nickname`), role/route from pathname, locale from `navigator.language`.
- `components/feedback/FeedbackWidget.module.css` — CSS module using the TICKET-4 design-system tokens (plum/pink/amber). Scoped so it does NOT touch shared `globals.css` (avoids PR #8/#9 collision).

### appVersion

Server-derived from env — no `next.config.ts` edit (shared file).

## File ownership compliance

Touched ONLY owned files: `app/layout.tsx` (sole owner this batch), `components/FeedbackWidget.tsx` + `components/feedback/**`, `app/api/feedback/**`, `lib/feedback-store.ts` + `lib/feedback-types.ts`, tests/e2e, `.env.example` (appended one block). Did NOT touch `lib/store*`, `app/page.tsx`, `app/tv/**`, `app/host/**`, `globals.css`.

## Scope decision — micro-prompts DEFERRED

Contextual micro-prompts (after first song / after host session end) are marked droppable in the spec. **Deferred to a follow-up** to keep this PR tight and robust — the core sheet + API + durable store + admin loop consumed the budget. The FAB path already delivers zero-friction capture on every patron/host page. Follow-up should add the 1/session dismissible nudges hooked to those two events.

## Verification (local — CI billing is broken, verified locally with real output)

- **Build:** `npm run build` → ✓ compiled, lint + types clean, `/api/feedback` route registered. (see PR)
- **Unit:** `npx jest` → **Test Suites: 5 passed; Tests: 105 passed** (2 new suites: `feedback-store.test.ts` runs the full contract against BOTH memory + Upstash-via-fake-redis; `api-feedback.test.ts` covers POST validation matrix, rate-limit 6th-rejected + per-uuid isolation, server-augment-not-trust-client, admin GET token guard incl. fail-closed, PATCH status update).
- **E2E:** `npx playwright test` → **3 passed** (existing submit-song + 2 new: 2-tap submit confirmation; no widget on `/tv`).
- **Evidence:** `work/evidence/ticket-11/` — FAB + sheet at desktop (1280) and mobile (390), plus `/tv` no-widget. Verified visually (design-system plum/pink, pt-BR copy, category-chip active state).

## CI note

CI billing is known-broken for this repo; the `gh pr checks` verbatim-green contract can't be satisfied via CI right now. All gates verified locally with real command output (pasted above / in PR). Flagging for the TM per the known-CI-broken condition.

## Security gate (2026-07-05) — PASS-WITH-NOTES, M1 folded

- **M1 (MEDIUM, fixed):** admin token comparison in `app/api/feedback/route.ts` used `===` (timing side-channel). Replaced with `crypto.timingSafeEqual` over equal-length UTF-8 Buffers, length-mismatch rejected up front (leaks only length, never contents — fine for a long random secret). Implemented standalone; did NOT import from TICKET-7's unmerged `lib/host-auth.ts`. New unit test: same-length wrong token still 401 (exercises the timingSafeEqual path). Verified: `npx jest` → **106/106 passed**; `npm run build` → green.
- **L1 (uuid-rotation rate-limit bypass) and L2 (sanitize-at-consumer):** recorded as follow-ups per the gate verdict — no action in this PR.

## Follow-ups filed / suggested

- Micro-prompts (after first song / host session end), 1/session dismissible.
- Provision Upstash so feedback is actually durable in the live app (shared with the queue store's same gap).
- Security L1: mitigate uuid-rotation rate-limit bypass (e.g. secondary IP-based cap).
- Security L2: sanitize/escape feedback text at every consumer (intake reports, future admin UI).
