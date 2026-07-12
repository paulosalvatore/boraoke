# TICKET-51 — Dev Report

**Status:** Implemented, self-verified GREEN, pushed. Ready for gates.
**Branch:** `ticket/51-junk-reason-strict-bucket-test`
**Scope:** TEST ONLY (+ ticket doc). No production / non-test source changes.

## Summary

TICKET-47 FU-2 (Reviewer, PR #29): add the missing explicit regression test that a junk / non-allowlisted advance `reason` is charged to the STRICT singer-skip bucket (12/60s), not the generous unplayable bucket (40/60s).

## Investigation — prod behavior verified ALREADY correct

`app/api/queue/advance/route.ts`:
- L12: `const ADVANCE_SKIP_REASONS = new Set(["unplayable"]);` — only `"unplayable"` is allowlisted.
- L56–58: `const skipReason = rawReason && ADVANCE_SKIP_REASONS.has(rawReason) ? rawReason : null;` — any junk / missing reason → `null`.
- L61: `advanceRateLimitOk(roomId, { unplayable: skipReason === "unplayable" })` — with `skipReason=null`, `unplayable=false` → STRICT bucket.

`lib/advance-rate-limit.ts` L81–82: `unplayable ? UNPLAYABLE_MAX(40) : ROOM_MAX(12)`, keyed `unplayable:<room>` vs `room:<room>`.

Conclusion: junk-reason → STRICT bucket is ALREADY the shipped behavior. The new tests pass against unchanged prod code. No behavior change needed (and none made).

## What changed

`__tests__/advance-rate-limit.test.ts` — two new route-level tests in the existing `POST /api/queue/advance rate limiting (route)` block, mirroring the TICKET-47 route tests and reusing the existing `authedAdvance(reason?)` harness:

1. `charges a junk/non-allowlisted reason to the STRICT singer-skip bucket (12/60s) …` — 12× `reason=bogus` succeed (200), 13th 429s `{ reason: "rate" }`. Had junk been routed to the generous bucket, all 13 would pass.
2. `junk-reason advances SHARE the strict bucket with reasonless advances …` — interleaves junk + reasonless advances (same strict bucket): 12 combined succeed, 13th 429s; then proves the unplayable bucket is untouched (a `reason=unplayable` advance in the same room/window still 200s).

`work/tickets/TICKET-51-junk-reason-strict-bucket-test.md` — ticket doc (repo convention).

## Self-verification

- Targeted: `npx jest advance-rate-limit` → **11/11 pass** (incl. the 2 new).
- Full suite: `npm test` → **522/522 pass, 37 suites**.
- Build: `npm run build` → **exit 0, Compiled successfully** (all routes incl. `/api/queue/advance`).
  - Note: the worktree had no `node_modules`; ran `npm install` in the worktree so `next build` could resolve `next-intl/plugin`. `node_modules` is gitignored — not committed.

## Files touched

- `__tests__/advance-rate-limit.test.ts`
- `work/tickets/TICKET-51-junk-reason-strict-bucket-test.md`
- `work/reports/dev/TICKET-51-dev-report.md` (this file)

## For the Reviewer

- Confirm the negative test genuinely asserts the STRICT ceiling (12) for junk reasons, not merely "some limit". It drives exactly `ADVANCE_RATE_ROOM_MAX` successes then the 429 — a generous-bucket misroute would let 13+ through.
- No prod code touched; junk→strict routing was verified already correct.
