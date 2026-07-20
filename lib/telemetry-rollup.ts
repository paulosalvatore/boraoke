/**
 * Weekly telemetry rollup — PURE computation (TICKET-12).
 *
 * Takes raw events + an ISO week and produces the human-readable per-room
 * retention / engagement / host-usage / friction tables the TL/PO watch from
 * the repo (`work/telemetry/rollups/<YYYY-Www>.md`). No `server-only`, no
 * driver imports — the CLI script and unit tests import this under plain node.
 *
 * All derivable metrics live HERE (spec rule: store raw events only):
 *   - sessions + duration: activity split on >60min gaps per room
 *   - retention proxy (#1 signal): active days per room per week
 *   - submissions per patron, search-no-submit rate, etc.
 */

import type { TelemetryEvent } from "./telemetry-types";

/** Gap that splits two events into separate venue sessions. */
export const SESSION_GAP_MS = 60 * 60 * 1000;
/** A search not followed by a queue submit from the same uuid within this window counts as no-submit. */
export const SEARCH_SUBMIT_WINDOW_MS = 10 * 60 * 1000;

export interface RoomRollup {
  roomId: string;
  events: number;
  activeDays: number;
  sessions: number;
  /** Total first→last activity time across sessions, minutes (rounded). */
  sessionMinutes: number;
  /** Max sessions overlapping in time across the venue's week (multi-room demand proxy is cross-room; this is per-room busyness). */
  uniquePatrons: number;
  songsQueued: number;
  songsPlayed: number;
  songsSkipped: number;
  noshowSkips: number;
  /** Avg submissions per active patron (1 decimal). */
  submissionsPerPatron: number;
  queuedByKind: Record<string, number>;
  queuedByMode: Record<string, number>;
  hostActions: Record<string, number>;
  searches: number;
  searchNoSubmit: number;
  submitRejectedByCap: number;
}

export interface WeekRollup {
  week: string; // YYYY-Www
  fromDay: string; // YYYY-MM-DD (Monday)
  toDay: string; // YYYY-MM-DD (Sunday)
  totalEvents: number;
  rooms: RoomRollup[];
}

// ── ISO week helpers ─────────────────────────────────────────────────────────

/** ISO week (`YYYY-Www`) of a UTC timestamp. */
export function isoWeekOf(ts: string | number | Date): string {
  const d = new Date(ts);
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  // ISO: week belongs to the year of its Thursday.
  const dayNum = (target.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const isoYear = target.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4DayNum);
  const week =
    1 +
    Math.round(
      (target.getTime() - 3 * 86400000 - week1Monday.getTime()) /
        (7 * 86400000),
    );
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Monday..Sunday (`YYYY-MM-DD`, UTC) for an ISO week (`YYYY-Www`). */
export function isoWeekRange(week: string): { fromDay: string; toDay: string } {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new Error(`Invalid ISO week: ${week} (expected YYYY-Www)`);
  const year = Number(m[1]);
  const wk = Number(m[2]);
  if (wk < 1 || wk > 53) throw new Error(`Invalid ISO week number: ${week}`);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4DayNum);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (wk - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    fromDay: monday.toISOString().slice(0, 10),
    toDay: sunday.toISOString().slice(0, 10),
  };
}

// ── rollup computation ───────────────────────────────────────────────────────

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * Split a chronologically-sorted list of same-room events into sessions on
 * >SESSION_GAP_MS gaps. Factored out (TICKET-31) so `lib/analytics.ts` can
 * reuse the exact same session-boundary rule at day granularity instead of
 * only the weekly rollup's granularity — one definition of "a session", two
 * call sites. `events` MUST already be sorted by `ts` ascending (both call
 * sites pre-sort).
 */
export function countSessions(
  events: TelemetryEvent[],
): { sessions: number; sessionMs: number } {
  let sessions = 0;
  let sessionMs = 0;
  let sessionStart = -1;
  let prev = -1;
  for (const e of events) {
    const t = new Date(e.ts).getTime();
    if (prev < 0 || t - prev > SESSION_GAP_MS) {
      if (sessionStart >= 0) sessionMs += prev - sessionStart;
      sessions += 1;
      sessionStart = t;
    }
    prev = t;
  }
  if (sessionStart >= 0) sessionMs += prev - sessionStart;
  return { sessions, sessionMs };
}

export function computeRollup(
  events: TelemetryEvent[],
  week: string,
): WeekRollup {
  const { fromDay, toDay } = isoWeekRange(week);
  const inWeek = events
    .filter((e) => {
      const day = e.ts.slice(0, 10);
      return day >= fromDay && day <= toDay;
    })
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const byRoom = new Map<string, TelemetryEvent[]>();
  for (const e of inWeek) {
    const list = byRoom.get(e.roomId) ?? [];
    list.push(e);
    byRoom.set(e.roomId, list);
  }

  const rooms: RoomRollup[] = [];
  for (const [roomId, roomEvents] of byRoom) {
    const activeDays = new Set(roomEvents.map((e) => e.ts.slice(0, 10))).size;

    // Sessions: chronological events split on >SESSION_GAP_MS gaps.
    const { sessions, sessionMs } = countSessions(roomEvents);

    const patrons = new Set(
      roomEvents.filter((e) => e.uuid).map((e) => e.uuid as string),
    );

    const queued = roomEvents.filter((e) => e.event === "song_queued");
    const skipped = roomEvents.filter((e) => e.event === "song_skipped");
    const queuedByKind: Record<string, number> = {};
    const queuedByMode: Record<string, number> = {};
    for (const e of queued) {
      bump(queuedByKind, String(e.props?.kind ?? "unknown"));
      bump(queuedByMode, String(e.props?.mode ?? "unknown"));
    }
    const hostActions: Record<string, number> = {};
    for (const e of roomEvents.filter((e) => e.event === "host_action")) {
      bump(hostActions, String(e.props?.action ?? "unknown"));
    }

    // Friction: searches with no song_queued from the same uuid within the window.
    const searches = roomEvents.filter((e) => e.event === "search_performed");
    let searchNoSubmit = 0;
    for (const s of searches) {
      if (!s.uuid) continue;
      const t = new Date(s.ts).getTime();
      const followed = queued.some(
        (q) =>
          q.uuid === s.uuid &&
          new Date(q.ts).getTime() >= t &&
          new Date(q.ts).getTime() <= t + SEARCH_SUBMIT_WINDOW_MS,
      );
      if (!followed) searchNoSubmit += 1;
    }

    const submitters = new Set(
      queued.filter((e) => e.uuid).map((e) => e.uuid as string),
    );

    rooms.push({
      roomId,
      events: roomEvents.length,
      activeDays,
      sessions,
      sessionMinutes: Math.round(sessionMs / 60000),
      uniquePatrons: patrons.size,
      songsQueued: queued.length,
      songsPlayed: roomEvents.filter((e) => e.event === "song_played").length,
      songsSkipped: skipped.length,
      noshowSkips: skipped.filter((e) => e.props?.reason === "noshow").length,
      submissionsPerPatron: submitters.size
        ? Math.round((queued.length / submitters.size) * 10) / 10
        : 0,
      queuedByKind,
      queuedByMode,
      hostActions,
      searches: searches.length,
      searchNoSubmit,
      submitRejectedByCap: roomEvents.filter(
        (e) => e.event === "submit_rejected" && e.props?.reason === "cap",
      ).length,
    });
  }

  rooms.sort((a, b) => b.events - a.events);

  return { week, fromDay, toDay, totalEvents: inWeek.length, rooms };
}

// ── markdown rendering ───────────────────────────────────────────────────────

/**
 * Escape a user-influenced string for a GFM table cell (security M2, render
 * side — covers historical/pre-fix stored data too): pipes would break the
 * table, newlines would inject new markdown sections, and leading markdown
 * control characters could fake headers/quotes/lists at line start.
 */
export function escapeCell(s: string): string {
  const cleaned = s
    .replace(/[\r\n]+/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/^[\s#>*+`~=-]+/, "")
    .trim();
  return cleaned || "(empty)";
}

function fmtCounts(map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return entries.length
    ? entries.map(([k, v]) => `${escapeCell(k)}: ${v}`).join(", ")
    : "—";
}

export function renderRollupMarkdown(r: WeekRollup): string {
  const lines: string[] = [];
  lines.push(`# Telemetry rollup — ${r.week} (${r.fromDay} → ${r.toDay})`);
  lines.push("");
  lines.push(
    `Raw events: **${r.totalEvents}** across **${r.rooms.length}** room(s). Anonymous keys only (roomId/uuid); derivable metrics computed here, never stored. Ordering is best-effort by server timestamp.`,
  );
  lines.push("");
  lines.push("## Retention (the #1 monetization signal)");
  lines.push("");
  lines.push(
    "| Room | Active days | Sessions | Session time (min) | Events |",
  );
  lines.push("|---|---|---|---|---|");
  for (const room of r.rooms) {
    lines.push(
      `| ${escapeCell(room.roomId)} | ${room.activeDays}/7 | ${room.sessions} | ${room.sessionMinutes} | ${room.events} |`,
    );
  }
  lines.push("");
  lines.push("## Engagement");
  lines.push("");
  lines.push(
    "| Room | Patrons | Queued | Played | Skipped | Subs/patron | By kind | By mode |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const room of r.rooms) {
    lines.push(
      `| ${escapeCell(room.roomId)} | ${room.uniquePatrons} | ${room.songsQueued} | ${room.songsPlayed} | ${room.songsSkipped} | ${room.submissionsPerPatron} | ${fmtCounts(room.queuedByKind)} | ${fmtCounts(room.queuedByMode)} |`,
    );
  }
  lines.push("");
  lines.push("## Host usage (priority-tools demand proxy)");
  lines.push("");
  lines.push("| Room | Host actions by type |");
  lines.push("|---|---|");
  for (const room of r.rooms) {
    lines.push(`| ${escapeCell(room.roomId)} | ${fmtCounts(room.hostActions)} |`);
  }
  lines.push("");
  lines.push("## Friction");
  lines.push("");
  lines.push(
    "| Room | Searches | Search-no-submit | Cap rejections | No-show skips |",
  );
  lines.push("|---|---|---|---|---|");
  for (const room of r.rooms) {
    lines.push(
      `| ${escapeCell(room.roomId)} | ${room.searches} | ${room.searchNoSubmit} | ${room.submitRejectedByCap} | ${room.noshowSkips} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
