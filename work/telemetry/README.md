# Telemetry (TICKET-12)

Anonymous product events collected from early access onward — the raw data that decides the monetization path later (ads-vs-paid, pro-tier contents, flip timing). Spec: `work/planning/early-access-monetization.md` §"Telemetry we need NOW".

## What is collected (everything, exhaustively)

Every event is exactly this shape — there are no other fields:

```json
{ "event": "song_queued", "roomId": "bar-do-ze", "sessionKey": "…?", "uuid": "…?", "ts": "2026-07-01T21:00:00.000Z", "appVersion": "abc1234", "props": { "kind": "search", "mode": "sing" } }
```

- `uuid` — the patron's random anonymous id (the same one the queue already uses). It is not a name, account, or device id.
- `roomId` / `sessionKey` — which venue room the event belongs to.
- `props` — a small scalar bag (≤8 keys, strings hard-capped at 64 chars, sanitized before storage). Free text is impossible by construction.
- NO names, no free text, no IP addresses, no user agent, no cookies, no client analytics SDK — nothing a consent banner would need to gate.

Event names: `room_created`, `patron_joined`, `song_queued`, `song_played`, `song_skipped`, `host_action`, `search_performed`, `submit_rejected` (`lib/telemetry-types.ts` is the source of truth).

Derivable metrics (sessions/week, session duration, retention, submissions per patron, search-no-submit rate) are computed by the weekly rollup from these raw events and are never stored separately.

## Fail-open contract

Telemetry can never block or slow a queue/playback action: `track()` never throws, storage outages are swallowed and counted (`lib/telemetry.ts`), and the `/api/t` beacon returns 202 even when the store is down. Kill switch: `TELEMETRY_DISABLED=1`.

## Storage & retention

Same store family as the queue (memory default, Upstash Redis by env — no extra provisioning). Keys: `telemetry:events:<YYYY-MM-DD>` append-only lists + a `telemetry:days` registry. No cursor/watermark contract — in-list order ≠ commit order under concurrent serverless writes; reads are whole-day ranges.

Raw events are **not kept forever**: each Upstash day-key gets a **90-day TTL** at first write (`TELEMETRY_RETENTION_DAYS`), so raw events age out after the weekly rollups have captured the aggregates. The memory driver is capped at 10k events (drop-oldest).

## Abuse guards on the beacon

`POST /api/t` is dual-bucket rate-limited (per session key + per IP; generous beacon-grade limits) — over-limit events are **silently dropped with 204**, never an error, so telemetry stays out of the app's way. `roomId`/`sessionKey` are charset-allowlisted at ingest, and rollup rendering escapes every user-influenced markdown table cell (defense in depth for historical data).

## Weekly rollup

```bash
npm run telemetry:rollup -- --week 2026-W27              # live data (Upstash env vars)
npm run telemetry:rollup -- --week 2026-W27 --demo-seed  # offline deterministic sample
```

Writes `work/telemetry/rollups/<YYYY-Www>.md` — per-room retention (the #1 monetization signal), engagement, host-usage, and friction tables, readable straight from the repo. `rollups/2026-W27.md` is a committed demo-seed sample.
