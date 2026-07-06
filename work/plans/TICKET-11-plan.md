# TICKET-11 — Plan: in-app feedback widget

- **Ticket:** TICKET-11 — feedback widget + API + durable store (product side)
- **Branch:** `ticket/11-feedback-widget` · **Worktree:** `.worktrees/ticket-11` · **Port:** 3011
- **Author:** Dev agent · **Date:** 2026-07-05
- **APPROVED-BY:** auto-approved (no plan-gate escalation) — validated downstream by gates + TL merge of PR #11

## Approach

Zero-friction sentiment capture mounted globally via `app/layout.tsx` (SOLE owner in this batch), hidden on `/tv`. Feedback persists on its own keyspace on the TICKET-6 driver-selection pattern (memory / Upstash by env) — a NEW store module, never touching the frozen queue store (`lib/store*`).

### Storage design (own module, own keys)

The frozen `QueueStore` interface is queue-shaped (no generic KV), so per the ticket ("own module, own keys") feedback gets its own store that MIRRORS the #6 driver-selection pattern rather than reusing `QueueStore`:

- `lib/feedback-types.ts` — pure domain types/consts (no `server-only`, no React), importable by client components AND the server route: `Sentiment`, `Category`, `FeedbackStatus`, `FeedbackContext`, `FeedbackRecord`, `SENTIMENTS`, `CATEGORIES`.
- `lib/feedback-store.ts` (`server-only`) — `FeedbackStore` interface + `MemoryFeedbackStore` + `UpstashFeedbackStore` (injectable redis, like `upstash.ts`) + env-selected singleton `feedbackStore`. Same env contract as #6 (`STORE_DRIVER` / `UPSTASH_REDIS_REST_*`).
  - Keys: `feedback:index` (LIST of ids, insertion order), `feedback:item:<id>` (JSON record), `feedback:rl:<uuid>:<window>` (rate counter).
  - Ids are time-sortable (`base36(ms)-rand`) so the admin `since` watermark is a simple lexicographic cursor — idempotent even if the exact cursor item was removed.
  - Rate limit: fixed 1-hour window counter, 5/uuid/hour, server-side + durable. Memory driver is per-process (documented volatility, same honest caveat as the queue memory driver).

### API — `app/api/feedback/route.ts`

- `POST` (public): body-size cap, JSON parse, validate sentiment (required, enum) + optional text (≤1000) + optional category (enum) + context (valid uuid required for rate-limit key; nickname/route/mode/role/locale best-effort sanitized). Server AUGMENTS context with `appVersion` (env git sha / `VERCEL_GIT_COMMIT_SHA`, fallback `dev`), coarse `userAgent` (from header, coarsened), `createdAt` (server time). Rate-limit → 429 friendly pt-BR. Success → 201.
- `GET ?since=<id>` (admin): `Authorization: Bearer <FEEDBACK_ADMIN_TOKEN>` required; token NEVER shipped client-side; if env unset → deny (fail-closed). Returns records after the watermark.
- `PATCH` (admin): `{ id, status, triageRef? }` → the intake status-update write path (`new → triaged`).

### Widget

- `components/FeedbackWidget.tsx` (`use client`) — mounted in layout after `{children}`; `usePathname()` → renders null on `/tv` (and `/tv/*`). Floating pill FAB.
- `components/feedback/FeedbackSheet.tsx` — bottom sheet: 4 sentiment buttons (😍🙂😕😡), optional textarea, optional category chips. **Tapping a sentiment IS the submit action** → sentiment-only send in 2 taps (FAB + sentiment); any typed text/chip already chosen rides along. Confirmation copy states the promise (pt-BR).
- `components/feedback/useFeedbackContext.ts` — reads uuid/nickname from localStorage (`cantai_patron_uuid`, `cantai_nickname`), role/route from `usePathname`, locale from `navigator.language`.
- `components/feedback/FeedbackWidget.module.css` — scoped CSS module using the TICKET-4 design-system palette (plum/pink/amber); does NOT edit shared `globals.css` (avoids PR #8/#9 collision).

### appVersion

Server-derived from env (`GIT_SHA` / `VERCEL_GIT_COMMIT_SHA`, fallback `dev`) — no `next.config.ts` edit (shared file).

## Files touched

New: `lib/feedback-types.ts`, `lib/feedback-store.ts`, `app/api/feedback/route.ts`, `components/FeedbackWidget.tsx`, `components/feedback/{FeedbackSheet.tsx,useFeedbackContext.ts,FeedbackWidget.module.css}`, `__tests__/{api-feedback.test.ts,feedback-store.test.ts}`, `e2e/feedback.spec.ts`.
Edit: `app/layout.tsx` (mount widget), `.env.example` (append `FEEDBACK_ADMIN_TOKEN`).

## Risks

- **Shared `app/layout.tsx`** — SOLE owner in this batch per plan; safe.
- **Design tokens** — `globals.css` still carries the pre-design-system palette; I scope the widget's own tokens in a CSS module to avoid touching a file PR #8/#9 consume.
- **Micro-prompts** (after first song / host session end) — spec says droppable; DEFERRED to a follow-up to keep scope tight; noted in report + a follow-up flag.

## Test strategy

- Unit (`api-feedback.test.ts`): POST validation matrix, rate-limit 6th-rejected + per-uuid isolation, admin GET token guard (401 no/bad token, fail-closed when env unset) + `since` watermark, PATCH status update.
- Unit (`feedback-store.test.ts`): memory + Upstash (injected fake redis) — add/list/get/updateStatus/rate-limit/watermark idempotency.
- E2E (`feedback.spec.ts`): FAB visible on `/`, absent on `/tv`, 2-tap sentiment submit → confirmation.
- Build (`next build`) + full jest suite + e2e locally (memory driver). Evidence screenshots (desktop + 390px).
