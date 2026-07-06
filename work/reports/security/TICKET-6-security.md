# Security Report — TICKET-6: Durable Persistence (Upstash Redis + Memory Driver)

**PR:** #7 — `ticket/6-persistence`
**Auditor:** Cyber Security agent
**Date:** 2026-07-05
**Verdict:** PASS-WITH-NOTES

---

## Scope

Files changed in this PR that were audited in full:

- `lib/store/types.ts` (new) — interface contract, key schema, shared types
- `lib/store/memory.ts` (new) — in-memory driver
- `lib/store/upstash.ts` (new) — Upstash Redis driver
- `lib/store.ts` (refactored) — driver selector/singleton
- `app/api/queue/route.ts` (modified) — POST/GET handlers, now async
- `app/api/queue/advance/route.ts` (modified) — now async
- `.env.example` (new) — credential documentation
- `package.json` / `package-lock.json` — `@upstash/redis@^1.38.0` added

Blast-radius check: `app/tv/page.tsx` and `app/page.tsx` (client components that import from `@/lib/store`).

---

## CI Status

All required CI checks passed before issuing verdict:

```
Vercel                  pass
Vercel Preview Comments pass
```

Full test suite (78 tests, 3 suites) green locally: `api-queue`, `store`, `youtube`.

---

## Findings

### LOW — Missing `server-only` guard on `lib/store` module tree

**File:** `lib/store.ts`, `lib/store/upstash.ts`

`lib/store` instantiates a process-level singleton that conditionally creates an `UpstashStore` backed by `@upstash/redis`. The `@upstash/redis` client reads `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from `process.env` at construction time.

Neither `lib/store.ts` nor `lib/store/upstash.ts` contains `import "server-only"`, the Next.js mechanism that causes a build-time error if the module is accidentally bundled into a client component.

**Current exposure:** None. Both `app/tv/page.tsx` and `app/page.tsx` import exclusively with `import type { ... }` — TypeScript type imports are erased at compile time and generate no runtime `require`. The `@upstash/redis` client, credentials, and server logic are NOT in the client bundle today.

**Risk:** If a future developer adds a non-type import (e.g. `import { store } from "@/lib/store"`) in a client component, Next.js would silently bundle the Upstash client including the credential-reading code. The `server-only` guard is defense-in-depth that converts a silent mistake into a build-time error.

**Remediation direction:** Add `import "server-only"` as the first import in `lib/store.ts`. The `server-only` package is already available in Next.js projects (it is a peer dependency). This is a one-liner with zero runtime cost.

---

### LOW — Non-atomic read-modify-write in `UpstashStore.removeEntry` and `UpstashStore.reorder`

**File:** `lib/store/upstash.ts:62-72` (`removeEntry`), `lib/store/upstash.ts:82-96` (`reorder`)

Both operations perform: `lrange` → filter/splice in memory → `del` + `rpush`. Under concurrent host invocations (e.g. two simultaneous "remove" calls), a race can cause one removal to be silently overwritten by the stale read of the other.

**Severity clarification:** This is an operational correctness concern, not a security vulnerability — no unauthorized data access or privilege escalation is possible. The dev has correctly acknowledged this in the source comment: "acceptable for a small single-host queue at PMF volume." The atomic fast-path ops (`rpush` for addEntry, `lpop` for advance) are unaffected.

**Remediation direction:** For PMF volume this is acceptable. When scaling, these should be replaced with a Lua script or Redis pipeline (MULTI/EXEC equivalent via Upstash pipeline API) to make them atomic.

---

### INFO — roomId unvalidated in Redis key construction (moot today, pre-audit for TICKET-9)

**File:** `lib/store/types.ts:84-87` (`keys` helper)

Key schema: `` `room:${roomId}:queue` `` and `` `room:${roomId}:paused` ``.

Today both API routes hardcode `DEFAULT_ROOM = "default"` — no user input reaches `roomId`. The Upstash client uses the HTTP REST API, so Redis binary-protocol (RESP) injection is not applicable. There is no exploitable injection path in this PR.

**Pre-audit note for TICKET-9:** When multi-room ships and `roomId` becomes user-supplied, it must be validated against a strict allowlist pattern (e.g. `/^[a-zA-Z0-9_-]{1,64}$/`) before key construction, to prevent cross-room data access via crafted IDs containing colons or other delimiter characters.

---

### INFO — Pre-existing: unauthenticated `/api/queue/advance` endpoint

**File:** `app/api/queue/advance/route.ts`

POST `/api/queue/advance` has no authentication. Any client (patron browser, external script) can skip the current song. This endpoint and its lack of auth were present before TICKET-6 and are not changed by this PR. Noted here for completeness; it should be addressed in TICKET-7 (host controls) when the host auth surface is defined.

---

### INFO — Pre-existing: `postcss` moderate vulnerability in `npm audit`

Two moderate-severity `npm audit` findings exist (`next`/`postcss` — GHSA-qx2v-qp2m-jg93, PostCSS XSS via CSS stringify). Both are pre-existing and not introduced by this PR. The `@upstash/redis@1.38.0` package added by this PR has zero audit findings.

---

## Credential Handling Checklist (handle-secret baseline)

| Check | Status |
|---|---|
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` read via `process.env` only | PASS |
| Credentials never logged, echoed, or printed (no `console.log` in store files) | PASS |
| `.env.example` contains placeholder strings only (all lines commented) | PASS |
| `.gitignore` covers `.env` and `.env.*`, exempts `.env.example` | PASS |
| No `NEXT_PUBLIC_` prefix on any credential env var | PASS |
| Client components import `type` only from `@/lib/store` (zero runtime bundle leakage) | PASS |
| No credential values committed in the diff | PASS |

---

## Input Validation Regression Check

All TICKET-1 protections verified to survive the async refactor:

| Protection | Mechanism | Test |
|---|---|---|
| Body size cap (5000 bytes) | `MAX_BODY_BYTES` check in `route.ts` | `api-queue.test.ts: "rejects an oversized request body"` ✓ |
| `videoId` format (11 chars, allowlist chars) | `isValidVideoId()` | 3 videoId tests ✓ |
| Nickname ≤ 30 chars | `MAX_NICKNAME` | ✓ |
| Title ≤ 120 chars | `MAX_TITLE` | ✓ |
| Table ≤ 10 chars | `MAX_TABLE` | ✓ |
| `patronUuid` UUID format | `UUID_RE` regex | ✓ |
| Queue depth cap (QUEUE_MAX=200) | `addEntry` returns false + 429 | ✓ |

All 11 `api-queue` tests pass. Full suite: 78/78 pass.

---

## Dependency Assessment

| Package | Version | License | Audit | Notes |
|---|---|---|---|---|
| `@upstash/redis` | 1.38.0 | MIT | 0 findings | Official Upstash SDK; well-maintained; standard REST-over-HTTPS client |

---

## Summary

No BLOCKERs. No HIGH-severity findings. Two LOW findings (missing `server-only` guard; non-atomic host ops), two INFOs. The queue store refactor is well-structured, the credential handling is clean, input validation regressions are absent, and the new dependency is safe.

**Verdict: PASS-WITH-NOTES**

The two LOW findings are suitable for a follow-up ticket rather than a block. The `server-only` guard (LOW #1) is the higher-priority of the two and should be filed as a small hardening ticket for before TICKET-9 ships multi-room.
