/**
 * Rollup computation tests (TICKET-12): ISO-week math, per-room retention /
 * engagement / host / friction tables, and the search-no-submit derivation —
 * all derivable metrics are computed here from raw events, never stored.
 */
import {
  computeRollup,
  escapeCell,
  isoWeekOf,
  isoWeekRange,
  renderRollupMarkdown,
  SEARCH_SUBMIT_WINDOW_MS,
} from "@/lib/telemetry-rollup";
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

describe("ISO week helpers", () => {
  it("computes the ISO week of a date (year boundary included)", () => {
    expect(isoWeekOf("2026-07-01T12:00:00.000Z")).toBe("2026-W27");
    expect(isoWeekOf("2026-01-01T00:00:00.000Z")).toBe("2026-W01");
    expect(isoWeekOf("2027-01-01T00:00:00.000Z")).toBe("2026-W53"); // Jan 1 2027 is a Friday of ISO 2026-W53
  });

  it("expands a week to its Monday..Sunday day range", () => {
    expect(isoWeekRange("2026-W27")).toEqual({
      fromDay: "2026-06-29",
      toDay: "2026-07-05",
    });
  });

  it("rejects malformed weeks", () => {
    expect(() => isoWeekRange("2026-27")).toThrow();
    expect(() => isoWeekRange("2026-W99")).toThrow();
  });

  it("round-trips: every day of a week maps back to that week", () => {
    const { fromDay, toDay } = isoWeekRange("2026-W27");
    expect(isoWeekOf(`${fromDay}T00:00:00Z`)).toBe("2026-W27");
    expect(isoWeekOf(`${toDay}T23:59:59Z`)).toBe("2026-W27");
  });
});

describe("computeRollup", () => {
  it("filters to the week and groups per room", () => {
    const events = [
      ev("song_queued", "2026-06-28T21:00:00Z"), // W26 — out
      ev("song_queued", "2026-06-29T21:00:00Z"),
      ev("song_queued", "2026-07-05T21:00:00Z"),
      ev("song_queued", "2026-07-01T21:00:00Z", { roomId: "bar-b" }),
      ev("song_queued", "2026-07-06T21:00:00Z"), // W28 — out
    ];
    const r = computeRollup(events, "2026-W27");
    expect(r.totalEvents).toBe(3);
    expect(r.rooms.map((x) => x.roomId).sort()).toEqual(["bar-a", "bar-b"]);
  });

  it("computes retention: active days + gap-split sessions + duration", () => {
    const events = [
      // Night 1: 2h of activity (one session)
      ev("patron_joined", "2026-06-29T20:00:00Z", { uuid: U1 }),
      ev("song_queued", "2026-06-29T21:00:00Z", { uuid: U1, props: { kind: "search", mode: "sing" } }),
      ev("song_played", "2026-06-29T22:00:00Z"),
      // Night 2 (same UTC day boundary respected): separate session after >60min gap
      ev("song_played", "2026-07-01T20:00:00Z"),
      ev("song_played", "2026-07-01T20:30:00Z"),
    ];
    const [room] = computeRollup(events, "2026-W27").rooms;
    expect(room.activeDays).toBe(2);
    expect(room.sessions).toBe(2);
    expect(room.sessionMinutes).toBe(120 + 30);
  });

  it("computes engagement: patrons, queued/played/skipped, subs/patron, kind+mode splits", () => {
    const events = [
      ev("song_queued", "2026-06-29T20:00:00Z", { uuid: U1, props: { kind: "search", mode: "sing" } }),
      ev("song_queued", "2026-06-29T20:05:00Z", { uuid: U1, props: { kind: "paste", mode: "sing" } }),
      ev("song_queued", "2026-06-29T20:10:00Z", { uuid: U2, props: { kind: "search", mode: "listen-dance" } }),
      ev("song_played", "2026-06-29T20:15:00Z"),
      ev("song_skipped", "2026-06-29T20:20:00Z", { props: { reason: "noshow" } }),
      ev("song_skipped", "2026-06-29T20:25:00Z", { props: { reason: "host" } }),
    ];
    const [room] = computeRollup(events, "2026-W27").rooms;
    expect(room.uniquePatrons).toBe(2);
    expect(room.songsQueued).toBe(3);
    expect(room.songsPlayed).toBe(1);
    expect(room.songsSkipped).toBe(2);
    expect(room.noshowSkips).toBe(1);
    expect(room.submissionsPerPatron).toBe(1.5);
    expect(room.queuedByKind).toEqual({ search: 2, paste: 1 });
    expect(room.queuedByMode).toEqual({ sing: 2, "listen-dance": 1 });
  });

  it("counts host actions by type (priority-tools demand proxy)", () => {
    const events = [
      ev("host_action", "2026-06-29T20:00:00Z", { props: { action: "skip" } }),
      ev("host_action", "2026-06-29T20:01:00Z", { props: { action: "skip" } }),
      ev("host_action", "2026-06-29T20:02:00Z", { props: { action: "pause" } }),
      ev("host_action", "2026-06-29T20:03:00Z", { props: { action: "reorder" } }),
    ];
    const [room] = computeRollup(events, "2026-W27").rooms;
    expect(room.hostActions).toEqual({ skip: 2, pause: 1, reorder: 1 });
  });

  it("derives search-no-submit: a search not followed by a queue from the same uuid within the window", () => {
    const t0 = new Date("2026-06-29T20:00:00Z").getTime();
    const events = [
      // U1 searches then queues within the window → submitted
      ev("search_performed", new Date(t0).toISOString(), { uuid: U1, props: { results: 8 } }),
      ev("song_queued", new Date(t0 + 60_000).toISOString(), { uuid: U1, props: { kind: "search", mode: "sing" } }),
      // U2 searches, never queues → no-submit
      ev("search_performed", new Date(t0 + 120_000).toISOString(), { uuid: U2, props: { results: 0 } }),
      // U1 searches again but queues only AFTER the window → no-submit
      ev("search_performed", new Date(t0 + 300_000).toISOString(), { uuid: U1, props: { results: 5 } }),
      ev("song_queued", new Date(t0 + 300_000 + SEARCH_SUBMIT_WINDOW_MS + 1000).toISOString(), {
        uuid: U1,
        props: { kind: "search", mode: "sing" },
      }),
    ];
    const [room] = computeRollup(events, "2026-W27").rooms;
    expect(room.searches).toBe(3);
    expect(room.searchNoSubmit).toBe(2);
  });

  it("counts cap rejections", () => {
    const events = [
      ev("submit_rejected", "2026-06-29T20:00:00Z", { uuid: U1, props: { reason: "cap" } }),
      ev("submit_rejected", "2026-06-29T20:01:00Z", { uuid: U1, props: { reason: "other" } }),
    ];
    const [room] = computeRollup(events, "2026-W27").rooms;
    expect(room.submitRejectedByCap).toBe(1);
  });
});

describe("renderRollupMarkdown", () => {
  it("renders all four sections with per-room rows", () => {
    const events = [
      ev("song_queued", "2026-06-29T20:00:00Z", { uuid: U1, props: { kind: "search", mode: "sing" } }),
      ev("host_action", "2026-06-29T20:01:00Z", { props: { action: "skip" } }),
    ];
    const md = renderRollupMarkdown(computeRollup(events, "2026-W27"));
    expect(md).toContain("# Telemetry rollup — 2026-W27");
    expect(md).toContain("## Retention");
    expect(md).toContain("## Engagement");
    expect(md).toContain("## Host usage");
    expect(md).toContain("## Friction");
    expect(md).toContain("| bar-a |");
  });

  it("escapes user-influenced table cells (security M2 — historical data included)", () => {
    // Malicious values built directly (bypassing today's ingest allowlist) to
    // model pre-fix stored data: render-side escaping must still neutralize.
    const events: TelemetryEvent[] = [
      {
        event: "patron_joined",
        roomId: "evil|room\n## injected header",
        ts: "2026-06-29T20:00:00Z",
        appVersion: "test",
        uuid: U1,
      },
      {
        event: "host_action",
        roomId: "evil|room\n## injected header",
        ts: "2026-06-29T20:01:00Z",
        appVersion: "test",
        props: { action: "skip|drop" },
      },
      {
        event: "song_queued",
        roomId: "evil|room\n## injected header",
        ts: "2026-06-29T20:02:00Z",
        appVersion: "test",
        uuid: U1,
        props: { kind: "search\nfake", mode: "# sing" },
      },
    ];
    const md = renderRollupMarkdown(computeRollup(events, "2026-W27"));
    // No section injection: the payload may survive INSIDE a cell (harmless)
    // but must never start a line, which is what makes it a markdown header.
    expect(md).not.toMatch(/^## injected header/m);
    expect(md.split("\n").filter((l) => l.startsWith("## "))).toHaveLength(4); // exactly the 4 real sections
    expect(md).toContain("\\|"); // pipes escaped, not raw
    expect(md).not.toMatch(/^\s*# sing/m); // no leading markdown control chars
    // Table integrity: every row line still starts AND ends with a pipe.
    const tableLines = md.split("\n").filter((l) => l.includes("evil"));
    expect(tableLines.length).toBeGreaterThan(0);
    for (const line of tableLines) {
      expect(line.startsWith("| ")).toBe(true);
      expect(line.endsWith(" |")).toBe(true);
    }
  });

  describe("escapeCell", () => {
    it("neutralizes pipes, newlines, and leading markdown control chars", () => {
      expect(escapeCell("a|b")).toBe("a\\|b");
      expect(escapeCell("a\r\nb")).toBe("a b");
      expect(escapeCell("# header")).toBe("header");
      expect(escapeCell("> quote")).toBe("quote");
      expect(escapeCell("- list")).toBe("list");
      expect(escapeCell("plain-room_1.x")).toBe("plain-room_1.x");
      expect(escapeCell("")).toBe("(empty)");
      expect(escapeCell("   ")).toBe("(empty)");
      expect(escapeCell("###")).toBe("(empty)");
    });
  });
});
