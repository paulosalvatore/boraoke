# TICKET-24a Review — rotation.ts JSDoc + grace-path addEntry-return check

**Verdict: APPROVE** (D-022 merge-counting review, folded with security-angle pass). Merge-ready for a human.
**Reviewer model:** opus (judgment layer). **Branch:** `ticket/24a-rotation-nits` @ `09ee04a`, off `origin/main`.

## Scope of change

Diff limited to the two PR #14 sonnet NITs plus tests, a dev report, and one event-log append:
- `lib/rotation.ts` — comment-only JSDoc correction (NIT-1).
- `app/api/host/skip/route.ts` — grace-requeue `addEntry` boolean check (NIT-2).
- `__tests__/host-api.test.ts` — two new tests.
- `work/reports/dev/TICKET-24a-dev-report.md` — dev report.
- `work/events/2026-07.jsonl` — one auto-committed event row.

No drift into the broader TICKET-24 hardening batch; no moderation code touched. **Scope discipline: clean.**

## 1. Correctness

- **NIT-1 (JSDoc).** Verified the corrected header against the actual `relayQueue` (`lib/rotation.ts:253-258`): it calls `store.rewrite(...)` once with a `snapshot` id-list (merge-on-write), no-op for ≤1 entry. The new JSDoc — "bulk `rewrite` op — one round-trip, merge-on-write `snapshot` so the re-lay is atomic against a concurrent submit (see `relayQueue`)" — matches the implementation exactly. The stale "frozen `reorder` op" claim is gone. Accurate.
- **NIT-2 (silent-drop guard).** The boolean is captured (`const requeued = await store.addEntry(...)`, `route.ts:44`) and branched (`if (!requeued)`, `route.ts:49`). Confirmed the `addEntry` contract returns `Promise<boolean>` in `lib/store/types.ts:51` and both impls return `false` on queue-full: `memory.ts:40` (`length >= QUEUE_MAX`) and `upstash.ts:123` (`llen >= QUEUE_MAX`). So `false` genuinely means "entry removed, not re-added" — the guard correctly prevents the silent drop.
- **Lingering data-loss?** On the `false` branch the singer's entry IS permanently gone (removeEntry already succeeded). The Dev surfaces it via response body + telemetry rather than auto-recovering. Assessed: `removeEntry` frees a slot, so a same-entry re-add fails only when a concurrent submit fills that slot in the window — a rare race, and only reachable at exactly QUEUE_MAX=200. Auto-recovery (retry / restore) would add real complexity for a near-impossible edge, and the entry's content isn't lost to the host (it's echoed to no one, but the failure is now observable). Surfacing over recovering is a reasonable v1 contract.
- **200-with-body vs 500 — judgment call.** Endorsed. The file's convention is fail-open (telemetry is `void track`, never awaited/thrown; see `route.ts:72-73`). Auth passed, the request parsed, and the skip's remove executed — only the soft re-queue was rejected by a capacity condition. A capacity outcome is not a server fault, so 200 + `{ok:false, requeued:false, reason:"queue-full"}` is the right shape and is consistent with how the route already reports outcomes (`{ok, grace, nowPlaying}`). A 500 would misclassify a full queue as an error. Sound call.

## 2. Security

Route is host-token guarded upstream of the changed code (`requireHost`, `route.ts:25`) and room-scoped (`roomIdFromRequest`, 400 on bad id). The change lives entirely inside the already-authorized `grace && sing-head` branch.
- **No new unauthenticated surface** — the new branch is reached only after the existing auth+room gates.
- **No new external input** — `requeueFailed:"queue-full"` and `reason:"queue-full"` are hardcoded constants, not caller-derived.
- **No info disclosure** — the response body echoes only a fixed reason string plus `nowPlaying` (already returned on the happy path). Nothing sensitive added.
- **No abuse vector** — the failure branch does no extra store writes; it cannot be used to amplify load or bypass the queue cap (it is the cap firing). Telemetry stays fire-and-forget.

**Security: no concerns.**

## 3. Tests

- Happy path: `re-queues the head with graceRequeue` — asserts `status 200`, `requeued:true`, and that entry `a` survives with `graceRequeue:true`. Meaningful.
- **False-return branch exercised:** `surfaces a failed grace re-queue instead of silently dropping the singer` forces `jest.spyOn(store, "addEntry").mockResolvedValueOnce(false)` and asserts `ok:false`, `requeued:false`, `reason:"queue-full"` AND that `telemetry.track("host_action", ...)` fired with `requeueFailed:"queue-full"`. This directly covers the regression the NIT targets — not just the happy path. Assertions are specific and load-bearing.
- Ran `npx jest __tests__/host-api.test.ts` locally: **24/24 pass**, including both new cases.

## 4. Dev report

`work/reports/dev/TICKET-24a-dev-report.md` matches the diff: status line current, both NITs described accurately, the judgment call documented and consistent with what I found, verification (462/462 full suite, build green) recorded.

## Findings

None blocking. One optional note:

- **optional / NIT:** The happy-path response now additively returns `requeued:true`; callers relying on the old `{ok, grace, nowPlaying}` shape are unaffected (additive). No action needed — flagged only for completeness.

## Merge-readiness

Comment-only + a bounded, well-tested route guard; security-clean; scope-disciplined. **Merge-ready for the human.** Per the ticket, the TM will NOT auto-merge — boraoke.com is a live Vercel-auto-deploy site, so this PR is delivered open for the human to merge.

*Note: the ticket-supplied verdict is based on local diff/source reads and a local `jest` run of the affected suite. The full local-Docker `verify-green-local.sh` GREEN gate is the framework-repo gate; this product PR's merge-blocking CI is the product's own `npm test`/build, which the dev report records as green (462/462, build clean) and which I re-confirmed for the touched suite.*
