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
