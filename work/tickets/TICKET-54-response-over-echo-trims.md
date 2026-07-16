# TICKET-54 — Trim response over-echoes (security hardening)

Type: security hardening · Backend-only · Severity: LOW
Filed by: PR #25 opus reviewer (security LOW-1 / LOW-2)
Branch: `ticket/54-response-over-echo-trims` (worktree `.worktrees/ticket-54`)

## Problem

Several API response bodies echoed the full `QueueEntry` — including `patronUuid` and other fields — back to callers that never read them. This is a needless PII / enumeration surface: an unauthenticated submit response handed the caller back the exact `patronUuid` it just sent (and the host-approve response handed the full entry to the host UI). Trimming these bodies to the minimum the clients actually consume removes that surface with zero behavior change, because every consumer either discards the body and refetches via a separate GET, or reads only status / non-PII fields.

## Verification that each trim is safe (no consumer)

Confirmed by direct reads AND an independent Explore sweep across `app/**`, `lib/**`, and all `__tests__/**`:

- **POST /api/queue success body (201 & 202)** — sole caller `app/(patron)/[room]/PatronRoom.tsx` (submit handler). On `!res.ok` it reads `err.error`; on success it reads **nothing** off the body and refetches (`fetchQueue()`, `fetchPending()`). The `p.entry.*` reads in that file come from the separate GET `/api/queue/pending` list, not this POST response.
- **POST /api/host/pending/approve body** — sole caller `app/(patron)/[room]/admin/AdminRoom.tsx` `decidePending()`. On `!res.ok` it sets an error message; on success it reads **nothing** off the body and refetches (`fetchPending()`, `fetchQueue()`).
- **Tests** — no test reads `entry` off any of the three bodies. The 202 moderation test asserts `body.pending` and `body.pendingId` (kept). The 201 tests assert only `res.status` + store/GET contents. The approve tests assert only `.status` + a subsequent GET. No test change was required (re-verified by running the full suite green).

Own-row highlighting is NOT fed by these bodies (it uses the separate GET endpoints), so it is unaffected.

## Exact response-shape changes (before → after)

| Endpoint | Before | After |
| --- | --- | --- |
| `app/api/queue/route.ts` — 202 moderation-pending | `{ entry, pending: true, pendingId }` | `{ pending: true, pendingId }` |
| `app/api/queue/route.ts` — 201 non-moderated success | `{ entry }` | `{ ok: true }` |
| `app/api/host/pending/approve/route.ts` | `{ ok: true, entry: item.entry }` | `{ ok: true }` |

`pending` and `pendingId` are retained on the 202 — non-PII and asserted by the moderation test.

## Out of scope (guardrails honored)

- GET `/api/queue` projection (own-row highlighting) — NOT touched; that is a separate entangled follow-up.
- GET `/api/queue/pending` — NOT touched.
- No other endpoint trimmed. No endpoint had a consumer forcing a "did not trim" exception.

## Test / build results

- `npm test` (jest): **542/542 passed, 37/37 suites** — no test changes needed.
- `npm run build` (next build): **Compiled successfully**, linting + type-checking pass, **0 errors**. (One pre-existing, unrelated workspace-root inference warning.)
