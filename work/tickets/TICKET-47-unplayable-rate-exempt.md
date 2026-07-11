# TICKET-47 — Exempt `reason=unplayable` advances from the anti-grief rate charge (F2)

**Type:** hardening / UX-reliability follow-up
**Priority:** LOW
**Source:** PR #26 opus review finding **F2** (TICKET-45 advance-auth). Filed on BOARD.md "Follow-ups".
**Autonomy:** backend-only. NOT auto-mergeable — any merge to `main` triggers a boraoke.com prod deploy (Vercel auto-deploy); deliver the PR to the TL.

## Problem

The per-room advance rate limiter (`lib/advance-rate-limit.ts`, 12 advances / room / 60s) is a defense-in-depth backstop against a scraped screen token spamming skips. But it charges **every** advance — including the legitimate watchdog skips the TV fires with `reason=unplayable` (`app/api/queue/advance/route.ts`, TICKET-41 watchdog: `onError` 2/5/100/101/150 or a stalled player).

Failure mode (the "12-instafail → 60s TV wedge"): when a run of consecutive queue entries are **instantly** unembeddable/unplayable, the watchdog fires `advance?reason=unplayable` in rapid succession (instant `onError`, no 12s stall ladder to pace it). After 12 such skips in a minute the 13th advance is `429`'d, so the TV **wedges on an unplayable video for up to 60s** until the sliding window frees — exactly the recovery the watchdog exists to provide is blocked by the anti-grief throttle.

## Goal

Remove the wedge **without weakening the anti-grief throttle** on the operation it actually protects — a scraped-token caller skipping the *current playing singer* (a normal, non-`unplayable` advance).

## Approach (implement this; Reviewer to scrutinize the security tradeoff)

Split the throttle into two buckets in `lib/advance-rate-limit.ts` so the anti-grief limit on singer-skips is **unchanged**, and legitimate unplayable-drains get their own generous-but-bounded ceiling:

1. **Non-unplayable advances** (`reason` absent/other) — the singer-skip path — keep the existing **12 / room / 60s** anti-grief limit, byte-for-byte unchanged. This is the throttle the opus finding says must not weaken.
2. **`reason=unplayable` advances** — the watchdog-drain path — charge a **separate, more generous** per-room bucket (propose **40 / room / 60s**; a real bad-run of instantly-unplayable videos rarely exceeds ~20 in a row, so 40 clears the wedge, while still bounding a runaway/forged loop rather than removing the backstop entirely). Do not let unplayable skips consume the singer-skip bucket, and do not let the singer-skip bucket block an unplayable skip.

Rationale for keeping a bounded unplayable bucket rather than a full exemption: `reason` is caller-supplied and forgeable, and the advance path's only other guard (the screen token) is scrapeable per `screen-token.ts`. A full exemption would let a forger set `reason=unplayable` and bypass the throttle completely. A separate higher bucket preserves a hard ceiling on *any* advance while unwedging the legitimate case. **Reviewer: confirm this tradeoff is sound and the chosen ceiling is defensible; if a cleaner design exists (e.g. server-verified playability), note it.**

Wire the reason through in `app/api/queue/advance/route.ts`: the `skipReason` is already computed (allowlisted to `"unplayable"`) — pass it into the rate-limit call so the limiter picks the correct bucket. Keep the 400/401 (auth) ordering unchanged; only the rate-limit charge changes.

Preserve the existing public API of `advanceRateLimitOk` where practical (add an optional param, e.g. `advanceRateLimitOk(roomId, { unplayable }, now)` or a second exported fn), the LRU heap-growth guard, and the `_resetAdvanceRateLimit()` test helper. Keep the exported constants; add constants for the new bucket.

## Acceptance criteria

- [ ] A run of ≥13 consecutive `reason=unplayable` advances in <60s no longer 429s until the new higher ceiling — the TV can drain a bad instafail run without wedging.
- [ ] The singer-skip (non-`unplayable`) anti-grief limit is **exactly 12 / room / 60s**, unchanged — a 13th non-unplayable advance in the window still 429s.
- [ ] The two buckets are independent: exhausting one does not affect the other.
- [ ] Unit tests in `__tests__/advance-rate-limit.test.ts` cover: unplayable-bucket ceiling, non-unplayable ceiling unchanged, bucket independence, and (route-level or lib-level) that a `reason=unplayable` call is charged to the unplayable bucket. All existing tests stay green.
- [ ] `npm run build`, typecheck, lint, and the full unit suite are green.
- [ ] No change to auth ordering, telemetry events, or the `429` response shape for the non-unplayable case.

## Out of scope

- The Layer-1 self-heal debounce nits (TICKET-46 PR #28) — different code path.
- Moving rate buckets onto Upstash / cross-instance (separate filed follow-up).
- Any change to `ADVANCE_AUTH` enforce/log rollout.

## Files (expected)

- `lib/advance-rate-limit.ts` — two-bucket split.
- `app/api/queue/advance/route.ts` — pass the resolved `skipReason` into the limiter.
- `__tests__/advance-rate-limit.test.ts` — new/updated coverage.
