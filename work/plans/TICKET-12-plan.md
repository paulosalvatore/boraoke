# TICKET-12 — Telemetry baseline: dev plan

- **Date:** 2026-07-06 · **Product:** cantai · **Role:** Dev
- **Branch:** `ticket/12-telemetry` (worktree `.worktrees/ticket-12`, port 3012)
- **Plan gate:** pre-authorized by TM dispatch (full spec + delivery instructions provided at spawn; wave rules from TICKET-19 acknowledged). Recorded here for the record.
- **APPROVED-BY:** auto-approved (TM dispatch pre-authorization; no plan-gate escalation) — validated downstream by gates + TL merge of PR #12

## Approach

Mirror the house driver pattern (`lib/feedback-store.ts`) exactly: memory driver by default (zero credentials), Upstash by env (`STORE_DRIVER` / `UPSTASH_REDIS_REST_URL` auto-detect), `server-only` guard on server modules, injectable Redis-subset interface so tests run both drivers through one Jest `describe.each` conformance suite.

**Core is standalone (wave rule):** TICKET-9 (rooms/QR) runs concurrently and owns the patron/host/room route surfaces. NO one-line `track()` instrumentation lands in others' routes in this PR — the full call-site list is documented below and in the PR body as the final-rebase step after #9 merges (#12 rebases last in wave 2).

## Files (all owned by this ticket per TICKET-19 ownership map)

| File | Purpose |
|---|---|
| `lib/telemetry-types.ts` | PURE (no `server-only`): event-name constants, `TelemetryEvent` schema, props sanitizer, day-bucketed key schema, client-allowed event subset |
| `lib/telemetry-store.ts` | `server-only`; `TelemetryStore` interface + `MemoryTelemetryStore` + `UpstashTelemetryStore` (injectable `TelemetryRedisLike`), driver resolution, singleton |
| `lib/telemetry.ts` | `server-only`; `track()` fire-and-forget emit helper (fail-open, swallow-and-count), server-filled `ts`/`appVersion`, `TELEMETRY_DISABLED` kill switch, `createTracker(store)` for test injection |
| `lib/telemetry-rollup.ts` | PURE rollup computation: `computeRollup(events, week)` → per-room retention/engagement/host/friction tables + markdown rendering (unit-testable, reused by the script) |
| `app/api/t/route.ts` | Tiny POST beacon: strict validation, client-allowed event subset only, body cap, always fail-open (store outage ≠ 5xx) |
| `scripts/telemetry-rollup.ts` | CLI: `--demo-seed` (synthetic week, offline) or Upstash-direct read; writes `work/telemetry/rollups/<YYYY-Www>.md` |
| `work/telemetry/README.md` | What is collected + privacy posture (documentation AC) |
| `work/telemetry/rollups/<week>.md` | Seeded-data sample rollup (evidence AC) |
| `README.md` | Plain-language privacy note (append-only section) — AC5 |
| `.env.example` | Append-only telemetry section (reuses Upstash vars; documents `TELEMETRY_DISABLED`) |
| `__tests__/telemetry-{store,track,rollup}.test.ts`, `__tests__/api-t.test.ts` | Unit tests (both drivers; fail-open explicitly) |
| `e2e/telemetry.spec.ts` | Beacon accepts valid event / rejects garbage |

## Event schema (zero PII by construction)

`{ event, roomId, sessionKey?, uuid?, ts, appVersion, props{small} }` — `props` sanitized to ≤8 keys, scalar values only, strings hard-capped (≤64 chars), free-text impossible at the type/sanitizer level. `appVersion` uses the existing `GIT_SHA → VERCEL_GIT_COMMIT_SHA → NEXT_PUBLIC_GIT_SHA → "dev"` chain (from `app/api/feedback/route.ts`).

## Storage design

Day-bucketed append-only Redis lists: `telemetry:events:<YYYY-MM-DD>` (rpush) + `telemetry:days` set (day registry for discovery/clear). Raw events only — derivable metrics computed at rollup time, never stored. **No cursor/watermark export contract** (opus heads-up from PR #11: id-order ≠ commit-order under concurrent Upstash writes): reads are whole-day-range, ordering is best-effort by `ts` and documented as approximate.

## Events (typed constants) + rebase-time instrumentation map

| Event | Call site (rebase-time, one line each) | Props |
|---|---|---|
| `room_created` | #9's room-creation route | — |
| `patron_joined` | #9's join flow (or `/api/t` beacon) | — |
| `song_queued` | `POST /api/queue` success path | `kind` (search/paste), `mode` |
| `submit_rejected` | `POST /api/queue` cap branch (429) | `reason: "cap"` |
| `song_played` | `POST /api/queue/advance` (promoted entry) | — |
| `song_skipped` | `POST /api/host/skip` | `reason` (host/noshow) |
| `host_action` | `app/api/host/{skip,pause,remove,reorder}` after auth | `action`, `paused` |
| `search_performed` | `GET /api/search` success | `results` (count) |

Friction `search-no-submit` is **derived in the rollup** (search_performed with no song_queued from the same uuid within 10 min) — no client wiring, no extra event stored.

## Risks

- ts-node vs Next's `bundler` moduleResolution + `server-only` for the script → mitigated: script imports only PURE modules (`telemetry-types`, `telemetry-rollup`) and builds its own `@upstash/redis` client directly; verified empirically before commit.
- Concurrent-write ordering (opus class) → no cursor promise, day-range reads only.
- Fail-open regression risk → explicit unit test: store `append` rejects/throws → `track()` resolves, request path returns 2xx.

## Test strategy

Jest conformance suite via `describe.each` over both drivers with a `FakeRedis` (mirrors `__tests__/feedback-store.test.ts`); route tests mirror `api-feedback.test.ts`; pure rollup unit tests; one small Playwright beacon spec. Full suite + build + e2e locally on PORT=3012 before handoff.
