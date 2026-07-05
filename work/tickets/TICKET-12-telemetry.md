# TICKET-12 — Telemetry baseline (anonymous product events)

- **Date:** 2026-07-05 · **Product:** cantai · **Author:** Product Owner (TICKET-19 batch)
- **Wave:** 2 (after TICKET-6 merges — events need the durable store)
- **Depends on:** TICKET-6 (durable store). TICKET-7 for the `app/api/host/**` instrumentation specifically — those routes don't exist until #7 merges; core telemetry (lib, store, beacon, queue/search events) is buildable before that, host events land at the final rebase. Soft-coordinates with wave-2 siblings (instrumentation lines in shared API routes — see ownership; #12 rebases/merges last in wave 2). Blocks: the monetization flip decision (data), #16 analytics.
- **Sizing:** S

## Goal

Start collecting NOW the anonymous usage data that decides ads-vs-paid and pro-tier contents later — the early-access window doesn't come back (merged monetization spec: "retrofitting loses the early-access window forever").

## Spec source (authoritative)

`work/planning/early-access-monetization.md` §"Telemetry we need NOW" (merged). Event families to implement in this ticket:

1. **Venue lifecycle:** room/session created, session duration proxy (first→last activity), sessions per room per week (derivable), concurrent-room counts (derivable).
2. **Patron engagement:** join, song queued (with `kind`, mode active), song played, song skipped, submissions per uuid (derivable).
3. **Host behavior:** each host-control use by type (skip/remove/reorder/pause) — proxies priority-tools demand.
4. **Friction markers:** search-with-no-submit (search issued, nothing queued within the session step), submit rejections by cap, no-show skips.

Derivable metrics are NOT stored — store raw events; the weekly rollup computes aggregates.

## Design constraints (binding, from the spec's ACs)

- **Fail-open:** a telemetry write must never block or slow a queue/playback action — fire-and-forget with a swallow-and-count error path.
- **Zero PII:** event schema = `{ event, roomId, sessionKey?, uuid?, ts, appVersion, props{small} }`; uuid/roomId are the anonymous keys; no free text, no names, no user agent beyond coarse device class.
- Server-side emission only (from API routes/server actions) — no client analytics SDK, no cookies, nothing for a consent banner to gate. Client-only moments (e.g. search-no-submit) are inferred server-side or emitted via a single tiny `POST /api/t` beacon with the same schema.
- Weekly rollup: implement as `scripts/telemetry-rollup.ts` (run manually / by the house on cadence) writing `work/telemetry/rollups/<YYYY-Www>.md` — human-readable per-room retention/engagement/host-usage tables. No BI stack.
- README/docs plain-language privacy note (spec AC5): anonymous, no ads, LGPD-friendly.

## Scope — in

`lib/telemetry.ts` (emit helper + event names as typed constants), event storage module on the TICKET-6 client (own keys, append-oriented), the beacon route, instrumentation calls at the listed touch points, the rollup script + one seeded-data sample rollup committed as evidence, unit tests (fail-open behavior explicitly tested — store down ≠ request fails).

## Scope — out

Dashboards/analytics UI (#16), feedback correlation joins (rollup v2), the "powered by cantai" TV footer + config flag (spec AC4 — assigning it to TICKET-18's TV pass; noted there), retention math beyond the rollup tables.

## File ownership (parallel-dev boundaries)

- **Owns:** `lib/telemetry.ts` (new), `lib/telemetry-store.ts` (new), `app/api/t/route.ts` (new), `scripts/telemetry-rollup.ts` (new), `work/telemetry/**`, its tests.
- **Shared-file protocol (the batch's one sanctioned overlap):** instrumentation is ONE-LINE `track(...)` calls inside routes owned by others (`app/api/queue/*` post-#6, `app/api/host/*` from #7, `app/api/search` from #8). Rule: additive single lines only, never reordering or refactoring the host file; if the owning ticket is still open, land after it merges (wave-2 sequencing: #12 rebases last among wave 2).
- **Must not touch:** `lib/store.ts` / `lib/store/**`, any page/component UI, `packages/rotation-engine/**`.

## Acceptance criteria

Spec ACs 1–3 + 5 of the monetization spec's telemetry section (all listed events land with anonymous keys + appVersion and zero PII fields in the schema; telemetry outage never blocks an action — tested; rollup doc generated from ≥1 week of seeded events with per-room tables; plain-language privacy note shipped). Plus: no client-side analytics SDK and no consent-requiring storage introduced.
