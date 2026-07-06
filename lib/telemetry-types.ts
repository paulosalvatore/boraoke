/**
 * Telemetry domain types + constants (TICKET-12) — the single source of truth
 * shared by the server emit helper/store, the beacon route, and the rollup
 * script.
 *
 * This file is deliberately PURE: no `server-only`, no React, no driver
 * imports, so the offline rollup script (`scripts/telemetry-rollup.ts`) and
 * tests can import it under plain node.
 *
 * PRIVACY (zero PII by construction — monetization spec AC1):
 * the schema has NO free-text field, no names, no user agent. The only keys
 * are the anonymous `uuid` (random patron id), `roomId`, and an optional
 * `sessionKey`. `props` is sanitized to a handful of short scalar values —
 * anything else is dropped before storage.
 */

/**
 * Event names (typed constants). Derivable metrics (sessions/week, duration,
 * concurrent rooms, submissions per uuid, search-no-submit) are NOT events —
 * they are computed by the weekly rollup from these raw events.
 */
export const TELEMETRY_EVENTS = [
  // ── venue lifecycle ──
  "room_created", // a room/session comes into existence (#9 room creation)
  // ── patron engagement ──
  "patron_joined", // a patron joins a room (#9 join flow / beacon)
  "song_queued", // props: kind ("search" | "paste"), mode
  "song_played", // a queue entry is promoted to now-playing
  "song_skipped", // props: reason ("host" | "noshow")
  // ── host behavior (proxies priority-tools demand) ──
  "host_action", // props: action ("skip" | "pause" | "resume" | "remove" | "reorder")
  // ── friction markers ──
  "search_performed", // props: results (count) — search-no-submit derived at rollup
  "submit_rejected", // props: reason ("cap")
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[number];

/**
 * The subset of events the public `/api/t` beacon accepts from clients.
 * Server-observable moments (queue/search/host actions) are emitted from API
 * routes only — a client claiming them would poison the data. `song_played`
 * is deliberately NOT here (review C1): it has exactly ONE source, the
 * server-side `/api/queue/advance` instrumentation — a beacon duplicate
 * would double-count plays.
 */
export const CLIENT_ALLOWED_EVENTS: readonly TelemetryEventName[] = [
  "patron_joined",
];

/** Small scalar-only props bag (post-sanitization). */
export type TelemetryProps = Record<string, string | number | boolean>;

/**
 * One raw telemetry event. `ts` and `appVersion` are ALWAYS server-filled —
 * never trusted from a client (beacon included).
 */
export interface TelemetryEvent {
  event: TelemetryEventName;
  roomId: string;
  /** Optional venue session key (#9 rooms) — anonymous, room-scoped. */
  sessionKey?: string;
  /** Anonymous patron uuid (random, client-generated) — never an identity. */
  uuid?: string;
  /** ISO-8601, server clock. */
  ts: string;
  appVersion: string;
  props?: TelemetryProps;
}

// ── props sanitization limits (PII/abuse guard — free text is impossible) ──
export const MAX_PROP_KEYS = 8;
export const MAX_PROP_STRING = 64;
export const MAX_ROOM_ID = 64;
export const MAX_SESSION_KEY = 64;

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * roomId charset allowlist (security M2, ingest side): letters, digits,
 * `.` `_` `-` only — markdown/control characters never enter the store.
 */
export const ROOM_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** sessionKey shape (security L2): opaque short token. */
export const SESSION_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Raw-event retention (security M3): each `telemetry:events:<day>` Upstash
 * key gets this TTL at first write, so raw events age out after the weekly
 * rollups have captured them. 90 days ≫ the weekly rollup cadence.
 */
export const TELEMETRY_RETENTION_DAYS = 90;
export const TELEMETRY_RETENTION_SECONDS =
  TELEMETRY_RETENTION_DAYS * 24 * 60 * 60;

/**
 * Reduce an arbitrary object to a safe props bag: at most MAX_PROP_KEYS keys,
 * scalar values only (string/number/boolean), strings truncated to
 * MAX_PROP_STRING. Objects/arrays/functions/nullish values are dropped.
 * Returns undefined when nothing survives.
 */
export function sanitizeProps(raw: unknown): TelemetryProps | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: TelemetryProps = {};
  let n = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_PROP_KEYS) break;
    const k = key.slice(0, MAX_PROP_STRING);
    if (typeof value === "string") {
      out[k] = value.slice(0, MAX_PROP_STRING);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[k] = value;
    } else if (typeof value === "boolean") {
      out[k] = value;
    } else {
      continue; // objects, arrays, null, undefined, NaN — dropped
    }
    n += 1;
  }
  return n > 0 ? out : undefined;
}

/** `YYYY-MM-DD` (UTC) for a timestamp — the storage bucket granularity. */
export function dayOf(ts: string | number | Date): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Redis key schema — telemetry's own namespace (never collides with `room:*`
 * queue keys or `feedback:*`). Events are append-only lists bucketed by UTC
 * day; `days` is the bucket registry (discovery + clear).
 */
export const telemetryKeys = {
  day: (day: string) => `telemetry:events:${day}`,
  days: "telemetry:days",
};

/** Inclusive list of `YYYY-MM-DD` days between two dates (UTC). */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  let cur = new Date(`${from}T00:00:00.000Z`).getTime();
  if (Number.isNaN(cur) || Number.isNaN(end)) return out;
  const DAY_MS = 24 * 60 * 60 * 1000;
  while (cur <= end && out.length < 366) {
    out.push(new Date(cur).toISOString().slice(0, 10));
    cur += DAY_MS;
  }
  return out;
}
