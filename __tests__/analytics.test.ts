/**
 * Admin analytics aggregation tests (TICKET-31): day-range bucketing
 * (including zero-event days), top-songs ranking + tie-break, per-room
 * breakdown correctness, and the "unknown"-videoId fallback for events
 * emitted before the videoId prop existed.
 */
import { computeAnalytics } from "@/lib/analytics";
import type { TelemetryEvent } from "@/lib/telemetry-types";

const U1 = "11111111-1111-4111-a111-111111111111";
const U2 = "22222222-2222-4222-a222-222222222222";

function ev(
  event: TelemetryEvent["event"],
  ts: string,
  opts: Partial<TelemetryEvent> = {},
): TelemetryEvent {
  return { event, roomId: "bar-a", ts, appVersion: "test", ...opts };
}

describe("computeAnalytics", () => {
  it("filters to the day range and excludes events outside it", () => {
    const events = [
      ev("song_queued", "2026-06-30T21:00:00Z"), // out (before range)
      ev("song_queued", "2026-07-01T21:00:00Z"),
      ev("song_queued", "2026-07-03T21:00:00Z"),
      ev("song_queued", "2026-07-04T21:00:00Z"), // out (after range)
    ];
    const summary = computeAnalytics(events, "2026-07-01", "2026-07-03");
    expect(summary.totalEvents).toBe(2);
  });

  it("includes zero-event days in the days-over-time series, not just active ones", () => {
    const events = [
      ev("song_played", "2026-07-01T21:00:00Z", { props: { mode: "sing" } }),
      ev("song_played", "2026-07-03T21:00:00Z", { props: { mode: "sing" } }),
    ];
    const summary = computeAnalytics(events, "2026-07-01", "2026-07-03");
    expect(summary.days.map((d) => d.day)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);
    expect(summary.days[1]).toMatchObject({ day: "2026-07-02", events: 0, activeRooms: 0, sessions: 0 });
    expect(summary.totalActiveDays).toBe(2); // day 2 excluded — zero events
  });

  it("counts active rooms and sessions per day across multiple rooms", () => {
    const events = [
      ev("song_queued", "2026-07-01T10:00:00Z", { roomId: "bar-a" }),
      ev("song_queued", "2026-07-01T10:05:00Z", { roomId: "bar-b" }),
      // bar-a has a second session same day after a >1h gap
      ev("song_queued", "2026-07-01T14:00:00Z", { roomId: "bar-a" }),
    ];
    const summary = computeAnalytics(events, "2026-07-01", "2026-07-01");
    expect(summary.days[0].activeRooms).toBe(2);
    expect(summary.days[0].sessions).toBe(3); // bar-a: 2 sessions, bar-b: 1 session
    expect(summary.totalSessions).toBe(3);
  });

  it("ranks top songs by play count, breaking ties by videoId ascending", () => {
    const events = [
      ev("song_played", "2026-07-01T10:00:00Z", { props: { mode: "sing", videoId: "vidAAAAAAA", title: "Song A" } }),
      ev("song_played", "2026-07-01T11:00:00Z", { props: { mode: "sing", videoId: "vidAAAAAAA", title: "Song A" } }),
      ev("song_played", "2026-07-01T12:00:00Z", { props: { mode: "sing", videoId: "vidBBBBBBB", title: "Song B" } }),
      ev("song_played", "2026-07-01T13:00:00Z", { props: { mode: "sing", videoId: "vidCCCCCCC" } }), // no title
    ];
    const summary = computeAnalytics(events, "2026-07-01", "2026-07-01");
    expect(summary.topSongs).toEqual([
      { videoId: "vidAAAAAAA", title: "Song A", playCount: 2 },
      { videoId: "vidBBBBBBB", title: "Song B", playCount: 1 },
      { videoId: "vidCCCCCCC", title: undefined, playCount: 1 },
    ]);
  });

  it("respects the topSongs option (limit)", () => {
    const events = ["v1", "v2", "v3"].map((v, i) =>
      ev("song_played", `2026-07-01T1${i}:00:00Z`, { props: { mode: "sing", videoId: v } }),
    );
    const summary = computeAnalytics(events, "2026-07-01", "2026-07-01", { topSongs: 2 });
    expect(summary.topSongs).toHaveLength(2);
  });

  it("buckets song_played events with no videoId prop under 'unknown' (historical events)", () => {
    const events = [
      ev("song_played", "2026-07-01T10:00:00Z", { props: { mode: "sing" } }), // pre-TICKET-31 shape
      ev("song_played", "2026-07-01T11:00:00Z", { props: { mode: "sing" } }),
    ];
    const summary = computeAnalytics(events, "2026-07-01", "2026-07-01");
    expect(summary.topSongs).toEqual([{ videoId: "unknown", title: undefined, playCount: 2 }]);
  });

  it("computes per-room breakdown correctly and its sums equal the day-series sums", () => {
    const events = [
      ev("song_queued", "2026-07-01T10:00:00Z", { roomId: "bar-a", uuid: U1 }),
      ev("song_played", "2026-07-01T10:05:00Z", { roomId: "bar-a", uuid: U1, props: { mode: "sing", videoId: "v1" } }),
      ev("song_skipped", "2026-07-02T10:00:00Z", { roomId: "bar-a", uuid: U1, props: { reason: "host" } }),
      ev("song_queued", "2026-07-01T10:00:00Z", { roomId: "bar-b", uuid: U2 }),
      ev("song_played", "2026-07-02T10:00:00Z", { roomId: "bar-b", uuid: U2, props: { mode: "sing", videoId: "v2" } }),
    ];
    const summary = computeAnalytics(events, "2026-07-01", "2026-07-02");

    const roomA = summary.rooms.find((r) => r.roomId === "bar-a")!;
    const roomB = summary.rooms.find((r) => r.roomId === "bar-b")!;
    expect(roomA).toMatchObject({
      activeDays: 2,
      events: 3,
      uniquePatrons: 1,
      songsQueued: 1,
      songsPlayed: 1,
      songsSkipped: 1,
    });
    expect(roomB).toMatchObject({
      activeDays: 2,
      events: 2,
      uniquePatrons: 1,
      songsQueued: 1,
      songsPlayed: 1,
      songsSkipped: 0,
    });

    // Cross-check: sum of daily songsQueued/songsPlayed equals sum across rooms
    // (same underlying event set, two different groupings).
    const daySumQueued = summary.days.reduce((n, d) => n + d.songsQueued, 0);
    const daySumPlayed = summary.days.reduce((n, d) => n + d.songsPlayed, 0);
    const roomSumQueued = summary.rooms.reduce((n, r) => n + r.songsQueued, 0);
    const roomSumPlayed = summary.rooms.reduce((n, r) => n + r.songsPlayed, 0);
    expect(daySumQueued).toBe(roomSumQueued);
    expect(daySumPlayed).toBe(roomSumPlayed);
    expect(summary.totalEvents).toBe(5);
  });

  it("performs zero writes — pure function over its inputs, never mutates the input array", () => {
    const events = [ev("song_queued", "2026-07-01T10:00:00Z")];
    const snapshot = JSON.stringify(events);
    computeAnalytics(events, "2026-07-01", "2026-07-01");
    expect(JSON.stringify(events)).toBe(snapshot);
  });
});
