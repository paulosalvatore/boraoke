/**
 * Room data retention (TICKET-91) — the single, configurable source of the
 * room-record expiry window.
 *
 * WHY this exists: room metadata records (`room:<id>:meta` — see lib/rooms.ts)
 * are written with NO TTL, so a created room persists in Redis forever unless a
 * host manually clears it. That is a deliberate design gap surfaced while
 * correcting the YouTube quota compliance form: an unbounded room record is a
 * decision that should be made on purpose (YouTube Developer Policies §III.E.4
 * on stored API-derived metadata; LGPD on patron-supplied data), not an
 * accident of "nothing ever calls delete." This module is the MECHANISM to
 * expire room records via a configurable TTL — mirroring the shipped
 * `TELEMETRY_RETENTION_DAYS` precedent in lib/telemetry-types.ts.
 *
 * ZERO behavior change by default: the retention window is OFF unless the
 * `ROOM_RETENTION_DAYS` env var is set to a positive number. When it is unset
 * (or 0, or non-numeric) `roomRetentionSeconds()` returns `null` and the
 * write-path helpers return `undefined`, so every room write stays a plain
 * `SET` with no expiry — byte-for-byte the current production behavior. Picking
 * an actual retention window is a Tech-Lead decision (30 days to track the
 * YouTube policy ceiling, an idle-based window, etc.); this code deliberately
 * does NOT choose one. Flipping the env var later is the whole activation, and
 * clearing it is a complete, reversible off-switch.
 *
 * SCOPE NOTE: this bounds the room METADATA record only. The queue list
 * (`room:<id>:queue`, which carries patron nicknames and API-derived song
 * titles) and the paused flag live in the frozen queue store (lib/store/**),
 * whose atomic Lua merge (`DEL`+`RPUSH`) would drop any key TTL on every
 * reorder/remove — expiring those keys requires coordinating with that store
 * and is intentionally left as the follow-up the Tech-Lead's window decision
 * unblocks (see work/tickets/TICKET-91-*.md). Keeping the default at no-expiry
 * means nothing in this change alters current behavior regardless.
 */

import "server-only";

/**
 * Configured room-record retention window in whole days, or `null` when
 * retention is OFF (the default). Only a finite value strictly greater than 0
 * enables expiry; unset / 0 / negative / non-numeric all read back as `null`.
 */
export function roomRetentionDays(): number | null {
  const raw = process.env.ROOM_RETENTION_DAYS;
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Configured room-record retention window in whole seconds (for a Redis `EX`
 * option), or `null` when retention is OFF. Rounds down to an integer second.
 */
export function roomRetentionSeconds(): number | null {
  const days = roomRetentionDays();
  if (days == null) return null;
  return Math.floor(days * 24 * 60 * 60);
}

/**
 * SET options for a room record's FIRST write (create): `{ ex: <seconds> }`
 * when a retention window is configured, else `undefined` (a plain SET with no
 * expiry — the default, no behavior change). Pass the result straight through
 * to `redis.set(key, value, roomCreateSetOptions())`.
 */
export function roomCreateSetOptions(): { ex: number } | undefined {
  const seconds = roomRetentionSeconds();
  return seconds == null ? undefined : { ex: seconds };
}

/**
 * SET options for an in-place room UPDATE (mode/language/moderation change).
 * A bare `SET` clears any existing TTL, so when retention is ON we preserve the
 * TTL established at creation with `{ keepTtl: true }` — i.e. the window is
 * fixed from creation and a host action does not silently reset it. When
 * retention is OFF this returns `undefined` (a plain SET), so an update is
 * byte-for-byte the current behavior. Whether an active room should instead
 * REFRESH its TTL on activity is a Tech-Lead policy choice left open here.
 */
export function roomUpdateSetOptions(): { keepTtl: true } | undefined {
  return roomRetentionSeconds() == null ? undefined : { keepTtl: true };
}
