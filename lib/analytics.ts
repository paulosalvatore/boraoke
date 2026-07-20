/**
 * Admin analytics aggregation — PURE computation (TICKET-31).
 *
 * Takes raw telemetry events over an arbitrary day range and produces the
 * shapes the site-wide admin analytics view needs: a days-over-time series
 * (for the "karaoke days" chart), top-played songs, and a per-room activity
 * breakdown. This is a SEPARATE, live/flexible-range sibling of
 * `lib/telemetry-rollup.ts` (which is fixed to one ISO week and renders
 * markdown for the file-based weekly digest) — same raw events, same
 * session-boundary rule (`countSessions`, reused from the rollup module),
 * different grouping axis. No `server-only`, no driver imports: pure so it is
 * trivially unit-testable and reusable from a route handler.
 *
 * IDENTITY SEAM (TICKET-31 boundary): rows here are keyed by anonymous
 * `roomId`/`uuid` only, exactly like the rollup. A future per-patron identity
 * lookup (TICKET-26/28 territory) could enrich `RoomActivity.uniquePatrons`
 * into named/returning-patron breakdowns — deliberately NOT built here; this
 * file only reads existing session/song/room telemetry.
 */

import { countSessions } from "./telemetry-rollup";
import { dayRange, type TelemetryEvent } from "./telemetry-types";

/** Default number of top-songs rows returned when the caller doesn't ask for more/fewer. */
export const DEFAULT_TOP_SONGS = 10;

export interface DayActivity {
  day: string; // YYYY-MM-DD
  activeRooms: number;
  sessions: number;
  songsQueued: number;
  songsPlayed: number;
  events: number;
}

export interface TopSong {
  /** Grouping key: the played video's id, or "unknown" for pre-TICKET-31 events with no videoId prop. */
  videoId: string;
  /** First-seen title for this videoId, if any event carried one. */
  title?: string;
  playCount: number;
}

export interface RoomActivity {
  roomId: string;
  activeDays: number;
  events: number;
  sessions: number;
  uniquePatrons: number;
  songsQueued: number;
  songsPlayed: number;
  songsSkipped: number;
}

export interface AnalyticsSummary {
  fromDay: string;
  toDay: string;
  totalEvents: number;
  /** Distinct days with at least one event, across all rooms. */
  totalActiveDays: number;
  totalSessions: number;
  days: DayActivity[];
  topSongs: TopSong[];
  rooms: RoomActivity[];
}

function inRange(events: TelemetryEvent[], fromDay: string, toDay: string): TelemetryEvent[] {
  return events
    .filter((e) => {
      const day = e.ts.slice(0, 10);
      return day >= fromDay && day <= toDay;
    })
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/**
 * Compute the admin analytics summary for [fromDay, toDay] (inclusive,
 * `YYYY-MM-DD`, UTC day buckets — same convention as `telemetryKeys`/`dayRange`).
 * `events` need not be pre-sorted or pre-filtered; this function does both.
 */
export function computeAnalytics(
  events: TelemetryEvent[],
  fromDay: string,
  toDay: string,
  opts: { topSongs?: number } = {},
): AnalyticsSummary {
  const topN = opts.topSongs ?? DEFAULT_TOP_SONGS;
  const scoped = inRange(events, fromDay, toDay);

  // ── days-over-time ──────────────────────────────────────────────────────
  const byDay = new Map<string, TelemetryEvent[]>();
  for (const e of scoped) {
    const day = e.ts.slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push(e);
    byDay.set(day, list);
  }
  const days: DayActivity[] = [];
  let totalSessions = 0;
  for (const day of dayRange(fromDay, toDay)) {
    const dayEvents = byDay.get(day) ?? [];
    const byRoomThatDay = new Map<string, TelemetryEvent[]>();
    for (const e of dayEvents) {
      const list = byRoomThatDay.get(e.roomId) ?? [];
      list.push(e);
      byRoomThatDay.set(e.roomId, list);
    }
    let daySessions = 0;
    for (const roomEvents of byRoomThatDay.values()) {
      daySessions += countSessions(roomEvents).sessions;
    }
    totalSessions += daySessions;
    days.push({
      day,
      activeRooms: byRoomThatDay.size,
      sessions: daySessions,
      songsQueued: dayEvents.filter((e) => e.event === "song_queued").length,
      songsPlayed: dayEvents.filter((e) => e.event === "song_played").length,
      events: dayEvents.length,
    });
  }
  const totalActiveDays = days.filter((d) => d.events > 0).length;

  // ── top songs ────────────────────────────────────────────────────────────
  const songCounts = new Map<string, { title?: string; playCount: number }>();
  for (const e of scoped) {
    if (e.event !== "song_played") continue;
    const videoId = typeof e.props?.videoId === "string" && e.props.videoId ? e.props.videoId : "unknown";
    const title = typeof e.props?.title === "string" && e.props.title ? e.props.title : undefined;
    const existing = songCounts.get(videoId);
    if (existing) {
      existing.playCount += 1;
      if (!existing.title && title) existing.title = title;
    } else {
      songCounts.set(videoId, { title, playCount: 1 });
    }
  }
  const topSongs: TopSong[] = [...songCounts.entries()]
    .map(([videoId, v]) => ({ videoId, title: v.title, playCount: v.playCount }))
    .sort((a, b) => b.playCount - a.playCount || a.videoId.localeCompare(b.videoId))
    .slice(0, topN);

  // ── per-room breakdown ───────────────────────────────────────────────────
  const byRoom = new Map<string, TelemetryEvent[]>();
  for (const e of scoped) {
    const list = byRoom.get(e.roomId) ?? [];
    list.push(e);
    byRoom.set(e.roomId, list);
  }
  const rooms: RoomActivity[] = [];
  for (const [roomId, roomEvents] of byRoom) {
    const activeDays = new Set(roomEvents.map((e) => e.ts.slice(0, 10))).size;
    const patrons = new Set(roomEvents.filter((e) => e.uuid).map((e) => e.uuid as string));
    rooms.push({
      roomId,
      activeDays,
      events: roomEvents.length,
      sessions: countSessions(roomEvents).sessions,
      uniquePatrons: patrons.size,
      songsQueued: roomEvents.filter((e) => e.event === "song_queued").length,
      songsPlayed: roomEvents.filter((e) => e.event === "song_played").length,
      songsSkipped: roomEvents.filter((e) => e.event === "song_skipped").length,
    });
  }
  rooms.sort((a, b) => b.events - a.events);

  return {
    fromDay,
    toDay,
    totalEvents: scoped.length,
    totalActiveDays,
    totalSessions,
    days,
    topSongs,
    rooms,
  };
}
