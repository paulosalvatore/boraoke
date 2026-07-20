# Reviewer Report — TICKET-31 (admin analytics dashboard)

**Verdict: APPROVE** (opus pass, D-022; code + security folded).

## What I checked
- Full diff vs `origin/main` (6 source files, 3 test files).
- `lib/analytics.ts` — pure aggregation: day bucketing, top-songs ranking, per-room breakdown.
- `lib/telemetry-rollup.ts` — `countSessions()` extraction.
- `app/api/admin/analytics/route.ts` — GET route, auth, bounds.
- `app/admin/analytics/page.tsx` + CSS — read-only UI.
- `app/api/queue/advance/route.ts` — additive `song_played` props.
- All three test files + full suite run.

## Correctness
- Date bucketing: `inRange` inclusive `day >= from && day <= to` on `ts.slice(0,10)` (UTC), matches `dayRange`/`telemetryKeys` convention. Zero-event days included via `dayRange` iteration; `totalActiveDays` counts only `events > 0`. No off-by-one (verified by tests).
- Top songs: stable tie-break (`playCount desc, videoId asc`); missing `videoId` buckets to `"unknown"`; first-seen title captured. Correct.
- Per-room: sessions reuse `countSessions`; cross-check test proves day-sums == room-sums.
- `countSessions` extraction is byte-identical logic to the inlined rollup loop; rollup tests still green → no behavior change.

## Security (one-line): NOT a new write/attack surface — GET-only, no mutation path, reuses `requireHost(req, DEFAULT_ROOM)` byte-for-byte, fail-closed in prod.
- Auth denies unauthenticated (401, no data leak); garbage cookie 401; prod-lockout 401 — all tested.
- Bounded reads: `MAX_RANGE_DAYS=90` cap, `from>to` 400, `dayRange` self-caps at 366 iterations, `topSongs` clamped 1–50. No unbounded scan reachable.
- Injection: all rendered values (`title`/`videoId`/`roomId`) go through React JSX auto-escaping — no markdown path, `escapeCell()` not needed here. Correct call.
- `song_played` props purely additive; flows through `track()`→`sanitizeProps` (MAX_PROP_KEYS=8/STRING=64); videoId/title non-PII; fail-open preserved. Queue/playback behavior unchanged.

## Boundary (TICKET-26)
Diff touches NONE of `room-memory.ts`/identity/patron-join. `lib/analytics.ts` has only a read-only comment seam noting a future identity enrichment point. No merge hazard.

## Gate
`npm test` → 40 suites, **562/562 passed**. Tests cover empty data, single event, ties, unknown-videoId, per-room sum invariant, no-mutation spy, and the auth-denied paths.

## Non-blocking follow-ups
1. optional: `isValidDay` validates format (`\d{4}-\d{2}-\d{2}`) but not calendar validity — `2026-13-45` passes the regex, yields `Invalid Date`→NaN in the range calc (NaN>90 is false), so it slips the cap but is still bounded (empty/odd result, valid JSON, no crash, no unbounded read). Low severity; consider a real-date parse + 400. Not blocking — no security or DoS impact.
2. optional: `page.tsx` has no explicit way to change `topSongs` from the UI (route supports it); fine for internal tooling.
