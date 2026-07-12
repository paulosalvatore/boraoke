# TICKET-51 — Route-level negative test: junk/non-allowlisted `reason` is charged to the STRICT advance rate-bucket

**Type:** test-only / regression hardening
**Priority:** LOW
**Source:** TICKET-47 FU-2, filed by the Reviewer on PR #29 (the TICKET-47 dual-bucket advance rate-limiter split).

## Problem

TICKET-47 split the per-room advance rate limiter (`lib/advance-rate-limit.ts`) into two buckets, selected by the advance request's `reason` field:

- **STRICT singer-skip bucket** — 12 / room / 60s (`ADVANCE_RATE_ROOM_MAX`). The anti-grief limit that must not weaken.
- **GENEROUS unplayable-watchdog bucket** — 40 / room / 60s (`ADVANCE_RATE_UNPLAYABLE_ROOM_MAX`).

The advance route (`app/api/queue/advance/route.ts`) allowlists reasons to `"unplayable"` only (`ADVANCE_SKIP_REASONS = new Set(["unplayable"])`); any non-allowlisted / junk / missing `reason` resolves to `skipReason = null` and is therefore charged to the STRICT bucket via `{ unplayable: false }`. This fail-safe means a forger cannot bypass the throttle by sending a junk reason.

That fail-safe routing was **not covered by an explicit test**. This ticket adds the regression test.

## Scope — TEST ONLY

No production behavior or non-test source file changes. The prod code already routes junk reasons to the strict bucket correctly (verified — see below).

## What was added

Two route-level tests in `__tests__/advance-rate-limit.test.ts`, in the existing `POST /api/queue/advance rate limiting (route)` describe block, mirroring the existing TICKET-47 two-bucket route tests:

1. **`charges a junk/non-allowlisted reason to the STRICT singer-skip bucket …`** — drives 12 `reason=bogus` advances (all 200), then asserts the 13th 429s with `{ reason: "rate" }`. If junk reasons were mis-routed to the generous bucket, all 13 would succeed.
2. **`junk-reason advances SHARE the strict bucket with reasonless advances …`** — interleaves junk-reason and reasonless advances, proving they charge the SAME strict bucket (12 combined succeed, 13th 429s), and that the unplayable bucket is untouched (a `reason=unplayable` advance in the same room/window still succeeds).

## Verification of prod behavior (already correct)

`app/api/queue/advance/route.ts` lines 56–61:

```ts
const rawReason = req.nextUrl.searchParams.get("reason");
const skipReason =
  rawReason && ADVANCE_SKIP_REASONS.has(rawReason) ? rawReason : null;
if (!advanceRateLimitOk(roomId, { unplayable: skipReason === "unplayable" })) { ... }
```

A junk `reason` → `skipReason = null` → `{ unplayable: false }` → STRICT bucket. Confirmed already correct; the new tests pass against unchanged prod code.

## Acceptance criteria

- [x] A route-level test asserts a non-allowlisted `reason` is counted against the STRICT (12/60s) bucket, not the generous (40/60s) one.
- [x] Test proves it by driving junk-reason requests past the strict threshold and asserting the 429 at the strict limit.
- [x] Full unit suite and `npm run build` green.
- [x] No production / non-test source changes.

## Files

- `__tests__/advance-rate-limit.test.ts` — two new route-level negative tests.
- `work/tickets/TICKET-51-junk-reason-strict-bucket-test.md` — this ticket.
