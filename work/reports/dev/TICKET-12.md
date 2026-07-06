# Dev report — TICKET-12 (telemetry baseline)

- **Branch:** `ticket/12-telemetry` · **Worktree:** `.worktrees/ticket-12` · **Port:** 3012
- **Status:** IMPLEMENTED + self-verified (build ✓, 233 unit ✓, 14 e2e ✓) — draft PR open; instrumentation one-liners deferred to the final rebase after TICKET-9 (wave rule)

## Picking up from

Fresh Dev on a fresh worktree off `main` (a4725f6, TICKET-6/7/8/11/18 merged). No prior work on this ticket.

## Exploration summary

- House driver pattern mirrored from `lib/feedback-store.ts` (memory default / Upstash by env / `server-only` / injectable `RedisLike` subset / singleton). Queue store (`lib/store*`) untouched (frozen).
- Test style: Jest `describe.each` conformance over both drivers with a `FakeRedis` (mirrors `__tests__/feedback-store.test.ts`).
- `appVersion()` chain reused from `app/api/feedback/route.ts` (`GIT_SHA` → `VERCEL_GIT_COMMIT_SHA` → `NEXT_PUBLIC_GIT_SHA` → `"dev"`).
- Wave rule confirmed: TICKET-9 owns the route surfaces concurrently → NO instrumentation lines in others' routes in this PR.

## Implementation log

- `f269ff6` — feat(telemetry): the full foundation:
  - `lib/telemetry-types.ts` — PURE: 8 typed event names, `TelemetryEvent` schema (`{event, roomId, sessionKey?, uuid?, ts, appVersion, props{small}}`), `sanitizeProps` (≤8 keys, scalars only, 64-char cap — free text impossible), day-bucket key schema (`telemetry:events:<YYYY-MM-DD>` + `telemetry:days`), `CLIENT_ALLOWED_EVENTS` beacon subset.
  - `lib/telemetry-store.ts` — `server-only`; `MemoryTelemetryStore` + `UpstashTelemetryStore` (injectable `TelemetryRedisLike`), same driver resolution as #6/#11, singleton. **No cursor/watermark contract** (PR #11 opus lesson: in-list order ≠ commit order under concurrent writes) — whole-day-range reads, best-effort ts sort, documented in the module header.
  - `lib/telemetry.ts` — `track()`: fail-open by contract (never rejects, swallow-and-count via `droppedCount()`), server-filled ts/appVersion, `TELEMETRY_DISABLED` kill switch, `createTracker(store)` for test injection.
  - `app/api/t/route.ts` — POST beacon: client-allowed subset only (data-poisoning guard), 2KB body cap, uuid regex, 202 even on store outage; validation failures 400.
  - `lib/telemetry-rollup.ts` — PURE: ISO-week math, `computeRollup` (sessions via >60min gap split, active days = retention proxy, engagement, host actions by type, search-no-submit derived per uuid within 10-min window, cap rejections, no-show skips), markdown renderer.
  - `scripts/telemetry-rollup.ts` + `npm run telemetry:rollup` — Upstash-direct or deterministic `--demo-seed`; imports pure modules only (no `server-only` under ts-node).
  - Evidence: `work/telemetry/rollups/2026-W27.md` (495 seeded events, 3 venue profiles, all four tables) — AC3.
  - Docs: `work/telemetry/README.md` (exhaustive what-is-collected) + README "Telemetry & privacy" plain-language section (anonymous, no ads, LGPD-friendly) — AC5.
  - `.env.example`: append-only telemetry section (reuses Upstash vars; documents `TELEMETRY_DISABLED`).
  - Tests: 43 new unit (4 suites) + 3 e2e (`e2e/telemetry.spec.ts`).

## Self-verification (local, Node 25)

- `npm run build` — ✓ compiled, `/api/t` registered as a dynamic route.
- `npm test` — **Test Suites: 15 passed, Tests: 233 passed** (was 190 on main; +43).
- `PORT=3012 npm run test:e2e` — **14 passed (18.6s)** (was 11; +3). Playwright managed the server; port 3012 free afterwards (verified via lsof).
- `npm run telemetry:rollup -- --week 2026-W27 --demo-seed` — ✓ wrote the sample rollup.
- Fail-open explicitly tested: store rejecting/throwing → `track()` resolves false; beacon still 202 with `append` mocked to reject (AC2).

## Rebase-time instrumentation list (final step, after TICKET-9 merges)

One-line additive `track(...)` calls (shared-file protocol; never reorder/refactor the host file):

| Event | File / branch point | Props |
|---|---|---|
| `song_queued` | `app/api/queue/route.ts` POST success (after `addEntry` true) | `kind: rawVideoId ? "search" : "paste"`, `mode` |
| `submit_rejected` | `app/api/queue/route.ts` POST cap branch (429) | `reason: "cap"` |
| `song_played` | `app/api/queue/advance/route.ts` POST (promoted entry) | — |
| `song_skipped` | `app/api/host/skip/route.ts` after `store.advance` | `reason: "host"` |
| `host_action` | `app/api/host/{skip,pause,remove,reorder}/route.ts` after auth + op | `action` (`pause` route: `pause`/`resume` from the flag) |
| `search_performed` | `app/api/search/route.ts` GET success | `results: <count>` |
| `room_created` | #9's room-creation surface | — |
| `patron_joined` | #9's join flow (server call if one exists; else the `/api/t` beacon) | — |

Route paths above are the pre-#9 locations — re-resolve them against #9's restructure at rebase time.

## Friction

None blocking. Note: `ts-node` needs `--compilerOptions '{"module":"commonjs","moduleResolution":"node"}'` because the app tsconfig uses `bundler` resolution — encoded in the npm script so nobody rediscovers it.

## Security gate follow-up (2026-07-06, PASS-WITH-NOTES findings folded in)

All 3 MEDIUMs + 2 LOWs from `work/reports/security/TICKET-12-security.md` resolved on-branch:

- **M1 (no rate limit on /api/t):** new `lib/telemetry-rate-limit.ts` — house dual-bucket sliding-window limiter (per session key 60/min + per IP 300/min via first `x-forwarded-for` hop, LRU-capped bucket map, standalone implementation of the TICKET-8 pattern). Over-limit → **silent 204 drop, nothing stored** — telemetry stays fail-open.
- **M2 (stored markdown injection into rollups):** render-side `escapeCell()` in `lib/telemetry-rollup.ts` (escapes `|`, flattens newlines, strips leading markdown control chars — covers historical data) PLUS ingest tightening: `ROOM_ID_RE = [A-Za-z0-9._-]{1,64}` enforced at the beacon.
- **M3 (no TTL):** `expire` added to `TelemetryRedisLike`; Upstash driver sets a 90-day TTL (`TELEMETRY_RETENTION_DAYS`, documented) on each day-key at first write (rpush len === 1). Retention noted in both privacy docs.
- **L1 (unbounded memory driver):** `MemoryTelemetryStore` capped at 10k events (`MEMORY_MAX_EVENTS`, injectable for tests), drop-oldest.
- **L2 (sessionKey shape):** `SESSION_KEY_RE = [A-Za-z0-9._-]{1,64}` enforced at the route (400 on mismatch).

Verification after fixes: `npm test` — **Test Suites: 15 passed, Tests: 243 passed** (+10 new: rate-limit trip → silent 204 + IP-bucket rotation cap + session isolation; escaping golden test with `|`/newline payloads + escapeCell unit; TTL-on-first-write via FakeRedis expire recording; memory cap ×2; sessionKey/roomId charset rejections). `npm run build` — ✓.

## CI-verified-green (S1 contract, post-security-fixes)

Verbatim `gh pr checks 12` at `e0e30ee`:

```
Vercel	pass	0	https://vercel.com/paulosalvatores-projects/cantai/9trVxKvfhCh9NMoratZ9wDWDBAAZ	Deployment has completed
Vercel Preview Comments	pass	0	https://vercel.com/github	
build-and-test	pass	1m33s	https://github.com/paulosalvatore/cantai/actions/runs/28798699298/job/85395921264	
```

All required checks terminal-green. Earlier conflicting-PR state (append-only `work/events/2026-07.jsonl` vs main) resolved via merge `f152db8` (events = union; `.env.example` = main first + telemetry section appended; branch files unchanged).

## Final rebase step (2026-07-06, post-TICKET-9 merge)

Merged `origin/main` (TICKET-9 rooms/QR in): events jsonl = union (111 lines), `.env.example` = main first + telemetry section appended last (merge `e8ee22c`).

**Instrumentation landed (additive `void track(...)` one-liners, never awaited — fail-open):**

| Event | Route (current, post-#9) | Notes |
|---|---|---|
| `song_queued` | `app/api/queue/route.ts` POST success | real `roomId`, `uuid`, `props {kind: search/paste, mode}` |
| `submit_rejected` | `app/api/queue/route.ts` cap branch (429) | `props {reason: cap}` |
| `song_played` | `app/api/queue/advance/route.ts` (promoted entry only) | **C1: the ONE source** — removed from `CLIENT_ALLOWED_EVENTS`; beacon now rejects it (test added) |
| `song_skipped` + `host_action{skip}` | `app/api/host/skip/route.ts` after auth+advance | |
| `host_action{pause/resume}` | `app/api/host/pause/route.ts` | action from the `paused` boolean |
| `host_action{remove}` | `app/api/host/remove/route.ts` | only when `removed` true |
| `host_action{reorder}` | `app/api/host/reorder/route.ts` | only when `moved` true |
| `search_performed` | `app/api/search/route.ts` (cached + fresh success) | `props {results: n}`; roomId from optional `?room=` param |
| `room_created` | `app/api/rooms/route.ts` POST success | real created room id |
| `patron_joined` | `/api/t` beacon only | no server-side join surface exists post-#9 (join = client page landing); client beacon wiring is a follow-up outside this ticket's ownership (must-not-touch UI) |

**Fail-open incident caught by tests:** first cut of the search instrumentation used `req.nextUrl` — the search unit tests pass a plain `Request`, so the line THREW inside the route's try and degraded the response (exactly the failure class the fail-open contract forbids). Fixed to the route's own plain-Request-safe `params`; `__tests__/api-search.test.ts` green again. New `telemetry-instrumentation.test.ts` also asserts a dead telemetry store never changes a route's response.

**Known undercount (documented):** `song_played` counts queue-head promotions via `/api/queue/advance`; the first song of a session (played without an advance) is not counted. Acceptable proxy for the rollup; noted for #16.

Verification: `npm test` — **20 suites, 292 tests passed** (+49 vs pre-rebase incl. `telemetry-instrumentation.test.ts` and main's new #9 suites). `PORT=3012 npm run test:e2e` — **17 passed** (main gained 3 specs). `npm run build` — ✓. Server stopped after.
