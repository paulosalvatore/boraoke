/**
 * track() emit helper (TICKET-12) — the load-bearing tests:
 *
 *   FAIL-OPEN IS THE CONTRACT (spec AC2): a telemetry outage must never block
 *   or slow a queue/playback action. `track()` NEVER rejects — store failures
 *   (sync or async) are swallowed and counted.
 *
 * Plus: server-filled ts/appVersion, props sanitization (zero PII by
 * construction), and the TELEMETRY_DISABLED kill switch.
 */
import { createTracker, appVersion } from "@/lib/telemetry";
import { MemoryTelemetryStore, type TelemetryStore } from "@/lib/telemetry-store";
import {
  MAX_PROP_KEYS,
  MAX_PROP_STRING,
  sanitizeProps,
} from "@/lib/telemetry-types";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => {
  delete process.env.TELEMETRY_DISABLED;
  delete process.env.GIT_SHA;
});

describe("track() — fail-open (spec AC2)", () => {
  it("resolves false (never rejects) when the store rejects asynchronously", async () => {
    const failing: TelemetryStore = {
      append: async () => {
        throw new Error("upstash is down");
      },
      listRange: async () => [],
      listDays: async () => [],
      clear: async () => {},
    };
    const tracker = createTracker(failing);
    await expect(
      tracker.track("song_queued", { roomId: "r1", uuid: UUID }),
    ).resolves.toBe(false);
    expect(tracker.droppedCount()).toBe(1);
  });

  it("resolves false (never rejects) when the store throws synchronously", async () => {
    const failing = {
      append: () => {
        throw new Error("boom");
      },
    } as unknown as TelemetryStore;
    const tracker = createTracker(failing);
    await expect(tracker.track("song_played", { roomId: "r1" })).resolves.toBe(
      false,
    );
    expect(tracker.droppedCount()).toBe(1);
  });

  it("counts every dropped event and keeps working afterwards", async () => {
    let fail = true;
    const store = new MemoryTelemetryStore();
    const flaky: TelemetryStore = {
      ...store,
      append: async (e) => {
        if (fail) throw new Error("transient");
        return store.append(e);
      },
      listRange: store.listRange.bind(store),
      listDays: store.listDays.bind(store),
      clear: store.clear.bind(store),
    };
    const tracker = createTracker(flaky);
    await tracker.track("song_queued", { roomId: "r1" });
    await tracker.track("song_queued", { roomId: "r1" });
    expect(tracker.droppedCount()).toBe(2);
    fail = false;
    await expect(tracker.track("song_queued", { roomId: "r1" })).resolves.toBe(
      true,
    );
    expect(tracker.droppedCount()).toBe(2);
  });
});

describe("track() — server-filled fields + schema", () => {
  it("stores the event with server ts + appVersion and the anonymous keys", async () => {
    process.env.GIT_SHA = "abc1234";
    const store = new MemoryTelemetryStore();
    const tracker = createTracker(store);
    const now = new Date("2026-07-01T21:00:00.000Z");
    const ok = await tracker.track("song_queued", {
      roomId: "room-a",
      uuid: UUID,
      props: { kind: "search", mode: "sing" },
      now,
    });
    expect(ok).toBe(true);
    const [e] = await store.listRange("2026-07-01", "2026-07-01");
    expect(e).toEqual({
      event: "song_queued",
      roomId: "room-a",
      uuid: UUID,
      ts: "2026-07-01T21:00:00.000Z",
      appVersion: "abc1234",
      props: { kind: "search", mode: "sing" },
    });
    // Zero-PII schema shape: only the known keys exist.
    expect(Object.keys(e).sort()).toEqual(
      ["appVersion", "event", "props", "roomId", "ts", "uuid"].sort(),
    );
  });

  it("falls back to roomId 'unknown' and omits empty optionals", async () => {
    const store = new MemoryTelemetryStore();
    const tracker = createTracker(store);
    await tracker.track("song_played", { roomId: "", now: new Date("2026-07-01T00:00:00Z") });
    const [e] = await store.listRange("2026-07-01", "2026-07-01");
    expect(e.roomId).toBe("unknown");
    expect(e).not.toHaveProperty("uuid");
    expect(e).not.toHaveProperty("sessionKey");
    expect(e).not.toHaveProperty("props");
  });

  it("appVersion() resolves the env chain with a dev fallback", () => {
    delete process.env.GIT_SHA;
    expect(appVersion()).toBe("dev");
    process.env.GIT_SHA = "sha-x";
    expect(appVersion()).toBe("sha-x");
  });
});

describe("props sanitization (free text impossible)", () => {
  it("truncates long strings and drops non-scalar values", () => {
    const out = sanitizeProps({
      long: "x".repeat(500),
      n: 3,
      b: true,
      obj: { nested: "no" },
      arr: [1, 2],
      nil: null,
      undef: undefined,
      nan: NaN,
    });
    expect(out).toEqual({ long: "x".repeat(MAX_PROP_STRING), n: 3, b: true });
  });

  it("caps the number of keys", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 20; i += 1) big[`k${i}`] = i;
    const out = sanitizeProps(big);
    expect(Object.keys(out!)).toHaveLength(MAX_PROP_KEYS);
  });

  it("returns undefined for empty/invalid input", () => {
    expect(sanitizeProps(undefined)).toBeUndefined();
    expect(sanitizeProps("string")).toBeUndefined();
    expect(sanitizeProps({})).toBeUndefined();
    expect(sanitizeProps({ only: { nested: true } })).toBeUndefined();
  });
});

describe("TELEMETRY_DISABLED kill switch", () => {
  it("no-ops every emit when set", async () => {
    process.env.TELEMETRY_DISABLED = "1";
    const store = new MemoryTelemetryStore();
    const tracker = createTracker(store);
    await expect(tracker.track("song_queued", { roomId: "r1" })).resolves.toBe(
      false,
    );
    expect(await store.listDays()).toEqual([]);
    expect(tracker.droppedCount()).toBe(0); // disabled ≠ dropped
  });
});
