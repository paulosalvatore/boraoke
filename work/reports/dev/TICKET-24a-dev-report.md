# TICKET-24a — rotation.ts JSDoc + grace-path addEntry-return check

**Status:** IMPLEMENTED — build green, 462/462 unit tests pass, lint clean. Committed & pushed to `ticket/24a-rotation-nits`. Ready for gates.

Two bounded PR #14 sonnet NITs (LOW). No scope expansion into the rest of the TICKET-24 hardening batch.

## Changes

### NIT-1 — `lib/rotation.ts` (comment-only)

Module-header JSDoc claimed the re-lay happens "using only the frozen `reorder` op". Stale — `relayQueue` uses the store's bulk `rewrite` op with merge-on-write `snapshot`. Rewrote the header bullet to describe the current mechanism: bulk `rewrite`, one round-trip, merge-on-write atomic against concurrent submit (cross-referencing `relayQueue`). No behavior change.

### NIT-2 — `app/api/host/skip/route.ts`

`store.addEntry(...)` returns `Promise<boolean>` (false when rejected, e.g. queue at QUEUE_MAX=200). On the no-show grace path the return was discarded — if false, the singer's entry was already `removeEntry`'d and never re-added, silently dropped.

Fix: capture the boolean into `requeued`. On `false`:
- emit `void track("host_action", { roomId, props: { action: "skip", grace: true, requeueFailed: "queue-full" } })` — fire-and-forget, fail-open, mirroring the existing TICKET-12 telemetry style in this file.
- return `{ ok: false, grace: true, requeued: false, reason: "queue-full", nowPlaying }` so the caller can act on the failed re-queue.

Happy path unchanged in behavior; additively now also returns `requeued: true`.

### Tests — `__tests__/host-api.test.ts`

Added a `no-show grace re-queue (TICKET-10 / TICKET-24a NIT-2)` describe block, matching the existing real-memory-store style (no route mocking; uses `store` + session cookie helpers already in the file):
1. Happy grace path re-queues the head with `graceRequeue: true` and returns `requeued: true`.
2. Forces `addEntry` to return false via `jest.spyOn(store, "addEntry").mockResolvedValueOnce(false)` and spies `telemetry.track`; asserts the response reflects the failure (`ok:false`, `requeued:false`, `reason:"queue-full"`) AND the `host_action` track fired with `requeueFailed: "queue-full"` — i.e. the false return is no longer silently ignored.

Added `import * as telemetry from "@/lib/telemetry"` for the spy; ts-jest's CommonJS transform routes the route's `import { track }` call through the namespace object, so the spy intercepts (verified passing).

## Judgment call — NIT-2 response shape

Chose **200 with a body signal** (`ok:false`, `requeued:false`, `reason:"queue-full"`) over a 500. Rationale: the route's convention is fail-open (telemetry is `void track`, never awaited/thrown), auth passed, and the request itself did not error — the skip semantics executed, only the soft re-queue was rejected. A structured body flag the caller can branch on matches how the route already reports outcomes (`{ ok, grace, nowPlaying }`) and avoids turning a capacity condition into a server error. The key requirement — a false return is surfaced, not silently swallowed — is met via both the telemetry signal and the response body.

## Verification

- `npm ci` — clean install.
- `npm test` — **462/462 unit tests pass, 32 suites**.
- `npm run build` — **Compiled successfully; Linting and checking validity of types passed** (only warning: pre-existing multi-lockfile workspace-root notice, unrelated).

## Files touched
- `lib/rotation.ts`
- `app/api/host/skip/route.ts`
- `__tests__/host-api.test.ts`
- `work/reports/dev/TICKET-24a-dev-report.md` (this report)
