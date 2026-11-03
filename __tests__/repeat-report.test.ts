/** Window math of the cross-day repeat report, on a hand-built fixture. */
import { computeRepeatReport, renderRepeatReport, repeatRates } from "@/lib/repeat-report";
import type { TelemetryEvent } from "@/lib/telemetry-types";

const H = 3600_000;
const D = 24 * H;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const ev = (event: TelemetryEvent["event"], ms: number, props: TelemetryEvent["props"]): TelemetryEvent => ({
  event, roomId: "r", ts: at(ms), appVersion: "t", props,
});
const live = (ms: number, keyHash?: string) =>
  ev("search_performed", ms, { results: 5, source: "live", ...(keyHash ? { keyHash } : {}) });
const rate = (r: ReturnType<typeof repeatRates>, label: string) => r.find((x) => x.label === label)!;

describe("repeatRates window math", () => {
  const series: Array<[number, string]> = [
    [0, "a"],
    [11 * H, "a"], // gap 11h: inside 12h, 7d, 30d
    [11 * H + 13 * H, "a"], // gap 13h: outside 12h, inside 7d, 30d
    [3 * D, "b"],
    [3 * D + 8 * D, "b"], // gap 8d: outside 7d, inside 30d
    [3 * D + 8 * D + 31 * D, "b"], // gap 31d: outside everything
    [5 * D, "c"], // never repeats
  ];
  const r = repeatRates(series);

  it("counts a repeat against the most recent earlier occurrence", () => {
    expect(rate(r, "12h").repeats).toBe(1);
    expect(rate(r, "7d").repeats).toBe(2);
    expect(rate(r, "30d").repeats).toBe(3);
    expect(rate(r, "30d").total).toBe(7);
    expect(rate(r, "12h").rate).toBeCloseTo(1 / 7);
  });

  it("the boundary is inclusive and the series order does not matter", () => {
    const edge = repeatRates([[12 * H, "x"], [0, "x"]]);
    expect(rate(edge, "12h").repeats).toBe(1);
    expect(rate(repeatRates([[12 * H + 1, "x"], [0, "x"]]), "12h").repeats).toBe(0);
  });

  it("same-instant duplicates are not a repeat; empty gives null rates", () => {
    expect(rate(repeatRates([[5, "x"], [5, "x"]]), "30d").repeats).toBe(0);
    expect(rate(repeatRates([]), "12h").rate).toBeNull();
  });
});

describe("computeRepeatReport", () => {
  const events = [
    live(0, "k1"),
    ev("search_performed", H, { results: 5, source: "cache" }),
    ev("search_performed", 2 * H, { results: 5, source: "index" }),
    live(3 * H), // no hash: counted, excluded from the rate
    live(D + H, "k1"), // repeat of k1 at 25h
    ev("song_queued", 0, { kind: "search", mode: "sing", videoHash: "v1" }),
    ev("song_queued", 2 * D, { kind: "search", mode: "sing", videoHash: "v1" }),
    ev("song_queued", 2 * D, { kind: "paste", mode: "sing" }),
    ev("room_created", 0, undefined),
  ];
  const rep = computeRepeatReport(events);

  it("splits cache / index / live per UTC day", () => {
    expect(rep.daily).toEqual([
      { day: "2026-11-01", cache: 1, index: 1, live: 2 },
      { day: "2026-11-02", cache: 0, index: 0, live: 1 },
    ]);
  });

  it("keeps unhashed events out of the denominator", () => {
    expect(rep.billedKeys).toMatchObject({ hashed: 2, unhashed: 1 });
    expect(rate(rep.billedKeys.rates, "12h")).toMatchObject({ repeats: 0, total: 2 });
    expect(rate(rep.billedKeys.rates, "7d")).toMatchObject({ repeats: 1, total: 2 });
    expect(rep.queuedSongs).toMatchObject({ hashed: 2, unhashed: 1 });
    expect(rate(rep.queuedSongs.rates, "7d")).toMatchObject({ repeats: 1, total: 2 });
  });

  it("renders without throwing", () => {
    expect(renderRepeatReport(rep)).toContain("repeat within 7d");
  });
});
