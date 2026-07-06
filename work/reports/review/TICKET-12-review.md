# Review report — TICKET-12: telemetry foundation (PR #12)

- **Reviewer:** Reviewer agent (D-011)
- **Date:** 2026-07-06
- **Branch:** `ticket/12-telemetry` · reviewed tip: `528760a` (diff `b82c494..origin/ticket/12-telemetry`, read locally per git-local-first)
- **Verdict:** **APPROVE** (with one rebase-time condition + nits, below)

## Preconditions verified

- App Tester: TM-waived N/A (server-side only, no UI files changed; e2e in CI). Security gate concurred (I2 in security report). Waiver record accepted.
- Security: PASS-WITH-NOTES (`work/reports/security/TICKET-12-security.md`, audited f152db8). All 3 MEDIUMs + 2 LOWs subsequently folded in on-branch at `e0e30ee` — verified in code, not just in the dev report (see below).
- CI terminal-green on the tip (S1): run **28798857632** on `528760a` — build ✓, unit tests ✓, Playwright e2e ✓; Vercel pass, Vercel Preview Comments pass. (Dev report cites earlier green run 28798699298 at `e0e30ee`; the doc-only commits after it re-ran CI, also green.)

## Own verification (ran locally in the ticket worktree, Node 25)

- `npm ci` — clean.
- `npm test` — **Test Suites: 15 passed, Tests: 243 passed** (matches Dev claim exactly; +53 vs main's 190).
- `npm run build` — ✓ compiled; `/api/t` registered as dynamic route.
- `PORT=3012 npx playwright test e2e/telemetry.spec.ts` — **3 passed (8.3s)** (the new suite; the full 14/14 e2e is confirmed by the green CI run on the tip).
- `npm run telemetry:rollup -- --week 2026-W27 --demo-seed` — regenerated `work/telemetry/rollups/2026-W27.md`; `git status` clean afterwards → **byte-identical, determinism confirmed** (AC3).

## Fail-open contract (spec AC2) — verified

- `lib/telemetry.ts` `createTracker().track()`: the entire body (including the kill-switch read and record construction) is inside try/catch; **never rejects**, swallow-and-count via `droppedCount()`. Explicitly tested for sync throw, async reject, and recovery (`telemetry-track.test.ts`).
- Beacon route: store outage → still 202 (`api-t.test.ts` mocks `append` to reject). Over-limit → **silent 204, nothing stored**. `TELEMETRY_DISABLED=1` no-ops (and correctly does not count as "dropped").
- No `await track()` exists in any user-path route — instrumentation is deferred to the post-#9 rebase by design. The `await track(...)` inside `/api/t` itself is fine (it IS the telemetry path and track never rejects). E2E confirms the patron page + queue API work independently of beacon garbage.

## Monetization-signal assessment (telemetry-now list vs the 8 events)

Mapping against `work/planning/early-access-monetization.md` §"Telemetry we need NOW":

1. **Venue lifecycle** — covered: `room_created` (event defined; emission lands with #9), session duration + sessions/room/week derived in rollup (gap-split sessions, active days). *Gap (nit N1):* **concurrent sessions per venue (multi-room demand)** is listed in the spec as a derivable but the rollup v1 renders no cross-room concurrency metric. Derivable later from stored raw events (nothing lost), but it isn't in the tables yet.
2. **Patron engagement** — covered: `patron_joined`, `song_queued` (kind/mode), `song_played`, `song_skipped`; patrons, subs/patron, kind/mode splits all in the Engagement table.
3. **Host behavior** — covered: `host_action` by type → Host usage table (priority-tools demand proxy).
4. **Friction** — covered: search-no-submit (per-uuid 10-min window, unit-tested), cap rejections, no-show skips.
5. **Feedback correlation** — explicitly out of scope (ticket: rollup v2). Consistent.
6. **Weekly rollup doc** — delivered + seeded sample committed.

**Retention measurability pre-#9 (honest flag):** today the app has a **single default room** — every event will carry `roomId: "default"` (or "unknown"), so the per-room Retention table (the #1 signal) collapses to one aggregate row. **Per-venue retention is NOT meaningfully measurable until TICKET-9 rooms merge.** This is acceptable, not a defect: (a) instrumentation itself is deferred to the post-#9 rebase, so essentially no pre-#9 data will exist; (b) the schema keys (roomId/sessionKey) are already right, so day one of multi-room = day one of real retention data; (c) PR #13 (multi-room) is delivered and CI-green, so the window is days, not weeks. No early-access data is being lost by this sequencing.

## Rollup correctness — verified on the golden fixtures

- ISO-week math: year-boundary cases (2027-01-01 → 2026-W53), round-trip week↔range, malformed-week rejection.
- Sessions: >60min gap split + duration math asserted (120+30 min case); retention active-days asserted.
- search-no-submit: within-window submit, never-submit, and after-window submit all asserted.
- Escaping (M2 render side): golden test injects `|`, newlines, and leading `#` **built directly into stored events** (modelling pre-fix historical data) — asserts exactly 4 real `##` sections survive, pipes escaped, table rows keep leading/trailing pipes. `escapeCell` unit-covered incl. empty/`###`→`(empty)`. Ingest side additionally allowlists `ROOM_ID_RE` at the beacon.

## Store driver fidelity — verified

- `server-only` in both `lib/telemetry.ts` and `lib/telemetry-store.ts`; rollup lib + script import pure modules only.
- One `describe.each` conformance suite over MemoryTelemetryStore and UpstashTelemetryStore(FakeRedis): append/read sorted, inclusive day-range, limit, full-payload round-trip, listDays, clear, UTC bucket boundaries.
- **No cursor/watermark contract** — module header documents the PR #11 opus lesson verbatim (whole-day reads, best-effort ts sort); nothing in the code builds on list positions.
- TTL-at-first-write (M3): asserted via FakeRedis `expireCalls` — exactly one `expire` per day-key at `rpush len === 1`, 90-day constant. Memory cap (L1): drop-oldest across day buckets tested, incl. emptied-bucket removal from listDays.
- Driver resolution mirrors the house pattern (explicit STORE_DRIVER, else Upstash creds present, else memory).

## Beacon route — verified

- Validation order: body size (2KB) → JSON → event ∈ CLIENT_ALLOWED_EVENTS (data-poisoning guard, server-observable names 400) → roomId allowlist → uuid regex → sessionKey shape → **rate limit** → track. Validation failures 400 (caller bug ≠ outage) — correct semantics.
- Silent-drop: over-limit → 204 with no body, nothing stored; dual-bucket (session 60/min + IP 300/min via first XFF hop) with LRU-capped bucket map and the correct always-charge-IP-bucket behavior (rotation can't dodge accounting) — all unit-tested (trip, rotation cap, session isolation).
- No response-time oracle concern: the 202/204/400 distinctions are intentional, documented semantics, not a leak. `ts`/`appVersion` server-filled; client values ignored (tested).

## Rebase-time instrumentation list — sane, one condition

The event→file→props table in the dev report matches the actual routes on main (`app/api/queue/route.ts`, `queue/advance`, `host/{skip,pause,remove,reorder}`, `api/search`), with the #9 re-resolution caveat noted. Two things to hold at rebase:

- **Condition C1 — `song_played` single-source:** `song_played` is in `CLIENT_ALLOWED_EVENTS` (beaconable) **and** in the rebase list as server-emitted from `queue/advance`. If both land, plays double-count (and a client can inflate the venue's engagement numbers on a server-counted metric). At rebase, pick ONE source — either drop it from `CLIENT_ALLOWED_EVENTS` (preferred: advance is server-observable) or don't instrument advance. Non-blocking now (no instrumentation exists yet), binding at the rebase step.
- Instrumentation calls must be `void track(...)` / un-awaited per the module's own contract — the rebase list should follow it (track never rejects, but awaiting still adds store latency to the response path).

## Scope / ownership discipline — clean

Diff touches only owned new files (`lib/telemetry*`, `app/api/t/`, `scripts/telemetry-rollup.ts`, `work/telemetry/**`, 4 new test suites, `e2e/telemetry.spec.ts`) + sanctioned appends (`.env.example` telemetry section, README privacy note — AC5 present and plain-language, `package.json` one script). `lib/store*`, UI, `packages/rotation-engine` untouched. Zero instrumentation lines in others' routes (wave rule honored). Rebase surface vs current main: branch already merged main at `f152db8` (events jsonl = union); remaining conflict surface is the append-only events log + the deliberate post-#9 rebase.

## Nits (non-blocking)

- **N1:** concurrent-rooms/multi-room-demand metric absent from rollup v1 tables (spec telemetry-now item 1). Derivable from stored raw events at any time — suggest rollup v2 alongside feedback correlation.
- **N2:** `MemoryTelemetryStore.append` re-sorts bucket keys on every over-cap eviction (O(days log days) per append past cap) — fine at 10k cap, just noting.
- **N3:** dev report's CI section cites the run at `e0e30ee`; tip `528760a` has its own green run 28798857632 (doc-only delta). Not stale in substance.

## Verdict

**APPROVE** — evidence: own 243/243 unit + build + e2e run, deterministic rollup regeneration, CI green on the exact tip, and the code reads above. Condition C1 (song_played single-source) binds at the post-#9 rebase; the TM should hold the final rebase to it before merge.

---

# Opus merge-counting pass (D-022 second tier) — final post-rebase state

- **Reviewer:** Reviewer agent, opus tier (D-011 / D-022 merge-counting pass)
- **Date:** 2026-07-06
- **Reviewed tip:** `8335ace` (branch `ticket/12-telemetry`; code tip `905e2e9`, `8335ace` is the events-jsonl auto-commit on top). Diff read locally per git-local-first: `git diff 1d08b0a..origin/ticket/12-telemetry` (base = merge-base with origin/main, which is the TICKET-9 merge commit). This pass was deliberately held until after the post-#13 rebase and reviews the true final state including instrumentation.
- **Verdict:** **APPROVE (merge-counting)** — with the non-blocking findings below for the TM and #16.

## C1 — song_played single-source: VERIFIED, airtight

- `lib/telemetry-types.ts:47`: `CLIENT_ALLOWED_EVENTS = ["patron_joined"]` — song_played removed, with an explicit C1 comment explaining why (lines 42–45).
- One and only one emitter in the tree: `grep -rn 'track("song_played"' app/ lib/` → exactly `app/api/queue/advance/route.ts:18`, guarded `if (next)`, carrying the promoted entry's real `roomId`/`patronUuid`/`mode`.
- Beacon rejection tested at both tiers: `__tests__/api-t.test.ts:72` asserts 400 + nothing stored for `song_played` (and all server-observable names); `e2e/telemetry.spec.ts` re-proves the poisoning guard against the real server. `__tests__/telemetry-instrumentation.test.ts` ("the ONE song_played source") asserts exactly one event emitted on advance and zero on empty-queue advance. **C1 resolved.**

## Fail-open invariant under instrumentation: VERIFIED

**track() itself never rejects — by construction, not just by test.** In `lib/telemetry.ts:69–94` the *entire* body — kill-switch read, record construction (`String(input.roomId ?? "")` coercions), `sanitizeProps`, and the awaited `store.append` — sits inside one try/catch that swallows sync and async failures alike and returns `false`. Nothing executes outside the try. `track` is exported as a plain unbound closure (no `this`), so `void track(...)` at a call site can produce neither a synchronous throw from inside track nor an unhandled promise rejection. The dead-store unit test (`telemetry-instrumentation.test.ts:74–81`, `append` mocked to reject; route still 201) confirms it end-to-end.

**Per-route synchronous argument-construction audit (the real remaining risk — a throw while *building* track's arguments happens before track's catch).** All 8 instrumented routes audited; every argument expression is safe in scope:

| Route | Emit | Arg-construction risk | Safe because |
|---|---|---|---|
| `queue/route.ts` (×2) | submit_rejected, song_queued | `entry.patronUuid`, `typeof rawVideoId` | `entry` is a locally constructed object in scope at both sites; `typeof` never throws and `rawVideoId` is declared earlier (lines 63/79) |
| `queue/advance/route.ts` | song_played | `next.patronUuid`, `next.mode` | guarded `if (next)` |
| `host/skip/route.ts` (×2) | song_skipped, host_action | static literals + `roomId` | `roomId` validated before (401 path returns first) |
| `host/pause/route.ts` | host_action | `paused ? ... : ...` | `paused` is a validated local boolean |
| `host/remove/route.ts` | host_action | static | guarded `if (removed)` |
| `host/reorder/route.ts` | host_action | static | guarded `if (moved)` |
| `rooms/route.ts` | room_created | `created.room.id` | guarded — `if (!created)` returns 503 first |
| `search/route.ts` (×2) | search_performed | `params.get("room") ?? ""`, `uuid`, `.length` | `params`/`uuid` in scope (`uuid = rawUuid \|\| "anon"`, line 62); `cached`/`results` non-null in their branches |

The `req.nextUrl`-on-plain-`Request` class of bug the dev caught: no remaining instances — no track call site reads `req.*` at all; the only header read feeding telemetry is `clientIp()` inside `/api/t`, which uses null-safe `headers.get(...)?.trim() ?? ""`. The one `await track(...)` in the tree is inside `/api/t` itself (line 113) — correct there (it IS the telemetry path and track never rejects); zero awaits in user routes.

## Event-quality judgment (will the rollup be honest?)

- **song_played first-song undercount** — documented in the dev report (line 105) and flagged for #16. Acceptable: a consistent proxy (undercounts each session by ≤1); the alternative (instrumenting play-start in the TV client) is UI-owned, outside this ticket.
- **search_performed on cached hits** — correct, not a double-count: the cached branch returns before the API branch, so exactly one emit per user search request. Counting cached searches is right — search-no-submit friction is about user intent, not YouTube quota.
- **host skip dual emit** (song_skipped + host_action) — intentional and non-overlapping: the rollup consumes song_skipped in Engagement/Friction and host_action in the demand-proxy table; no metric double-counts.
- **Finding F2 — `noshow` is a dead column.** `song_skipped` props document reason `"host" | "noshow"` and the rollup renders a "No-show skips" column, but nothing in the tree ever emits `reason: "noshow"` — the TV auto-advance path goes through `/api/queue/advance`, which emits `song_played` for the *next* entry and nothing for a skipped-over no-show. The column will read 0 forever until an emitter exists. Non-blocking (schema is right, data is merely absent), but **#16 should either wire a noshow signal into the advance/TV path or drop the column** so the rollup doesn't imply a measurement it isn't making.

## patron_joined gap — acceptable, with a hard requirement on #16

Beacon-only, zero client wiring → **zero patron_joined events at merge**. Judged against the PO's telemetry-now intent, this does NOT hollow out retention: the Retention table (active days, sessions, session minutes) derives from *all* server-emitted events, and `uniquePatrons`/subs-per-patron derive from uuids on song_queued/search — every *participating* patron is counted from day one. What stays dark until #16: (a) pure lurkers (patrons who join but never search/queue) and (b) the join→first-submit conversion funnel. Plainly: **#16 must add the one-line client beacon on room-page mount — fire once per patron session, with the patron uuid, to `/api/t` — or audience-size and conversion metrics never light up.** The beacon side is fully built, validated, rate-limited, and e2e-tested; the remaining work is one client call.

## Merge-order interactions (#13) — checked

Post-#9 route surface swept: `rooms` POST instrumented (room_created with the real created id — tested); patron join has no server surface post-#9 (join = client page landing → the deliberate beacon design above); `/api/host/session` is an auth probe/logout, not a spec event — correctly uninstrumented; `queue`/`advance`/`search` all carry real multi-room `roomId`s. No spec-expected event lost to the merge order.

## Own verification on the exact tip (S1) — and one CI process finding

- `npx jest` on `8335ace`: **20 suites, 292/292 passed** (matches Dev claim).
- `npx next build`: clean; all instrumented routes + `/api/t` compile as dynamic routes.
- `npx playwright test`: **17/17 passed (34.2s)** including the 3 telemetry beacon specs.
- **Finding F1 — CI never ran on the instrumented commits.** The last GitHub Actions build-and-test run (28811050541, success) is on `edfaf14` — the pre-rebase, pre-instrumentation state. The tip `8335ace` carries only Vercel checks. The branch is unprotected so nothing is formally required-and-pending (S1's letter is satisfied: all present checks terminal-green), and my local build+unit+e2e on the exact tip substitutes as evidence — but the App-Tester waiver leaned on "e2e in CI", so the gap matters. **It self-heals:** mergeStateStatus is CONFLICTING (F4), so the TM must push a conflict-resolution commit anyway, which re-triggers CI — **TM: confirm that CI run green before merging.**
- **Finding F4 — merge conflict is benign:** the only file both sides touched since base is `work/events/2026-07.jsonl` (append-only event log; no `.gitattributes` merge=union in this repo). Resolve as the union of both sides.
- **F5 (nit):** dev report's status line still says "233 unit ✓, 14 e2e ✓" from the pre-rebase state; the final-rebase section below it is current. Substance intact.

## Verdict (merge-counting)

**APPROVE.** C1 verified resolved in code and tests; the fail-open invariant holds by construction at track() and at all 8 instrumented call sites (no synchronous-throw or unhandled-rejection path found); event semantics will feed an honest rollup with the documented undercounts; the patron_joined gap is an acceptable, well-fenced deferral with a crisp #16 requirement. Verified myself on tip `8335ace`: 292/292 unit, clean build, 17/17 e2e. Conditions for the TM at merge time (not on the Dev): resolve the events-jsonl conflict as union and confirm the resulting CI run green (F1/F4). File F2 (noshow emitter-or-drop) and the patron_joined client beacon into #16.
