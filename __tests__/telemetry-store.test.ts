/**
 * Telemetry store conformance (TICKET-12): the same contract suite runs
 * against BOTH drivers — MemoryTelemetryStore and UpstashTelemetryStore over
 * an in-memory FakeRedis (zero network) — mirroring the house pattern from
 * __tests__/feedback-store.test.ts.
 */
import {
  MemoryTelemetryStore,
  UpstashTelemetryStore,
  type TelemetryRedisLike,
  type TelemetryStore,
} from "@/lib/telemetry-store";
import {
  dayRange,
  telemetryKeys,
  type TelemetryEvent,
} from "@/lib/telemetry-types";

// ── FakeRedis: just enough of the Upstash client, in memory ─────────────────

class FakeRedis implements TelemetryRedisLike {
  lists = new Map<string, unknown[]>();
  sets = new Map<string, Set<string>>();

  async rpush(key: string, ...values: unknown[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async lrange<T = unknown>(
    key: string,
    start: number,
    stop: number,
  ): Promise<T[]> {
    const list = this.lists.get(key) ?? [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end) as T[];
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m);
        added += 1;
      }
    }
    this.sets.set(key, set);
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? new Set<string>())];
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.lists.delete(k)) n += 1;
      if (this.sets.delete(k)) n += 1;
    }
    return n;
  }
}

function ev(
  event: TelemetryEvent["event"],
  ts: string,
  roomId = "room-a",
  uuid?: string,
): TelemetryEvent {
  return { event, roomId, ts, appVersion: "test", ...(uuid ? { uuid } : {}) };
}

const drivers: Array<[string, () => TelemetryStore]> = [
  ["MemoryTelemetryStore", () => new MemoryTelemetryStore()],
  ["UpstashTelemetryStore", () => new UpstashTelemetryStore(new FakeRedis())],
];

describe.each(drivers)("TelemetryStore contract — %s", (_name, make) => {
  let store: TelemetryStore;

  beforeEach(() => {
    store = make();
  });

  it("appends and reads back a day range, sorted by ts", async () => {
    await store.append(ev("song_played", "2026-07-01T22:10:00.000Z"));
    await store.append(ev("song_queued", "2026-07-01T21:00:00.000Z"));
    await store.append(ev("patron_joined", "2026-07-02T20:00:00.000Z"));
    const events = await store.listRange("2026-07-01", "2026-07-02");
    expect(events.map((e) => e.event)).toEqual([
      "song_queued",
      "song_played",
      "patron_joined",
    ]);
  });

  it("day range is inclusive and excludes events outside it", async () => {
    await store.append(ev("song_queued", "2026-06-30T23:59:59.000Z"));
    await store.append(ev("song_played", "2026-07-01T00:00:00.000Z"));
    await store.append(ev("song_skipped", "2026-07-03T12:00:00.000Z"));
    const events = await store.listRange("2026-07-01", "2026-07-02");
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("song_played");
  });

  it("respects the limit option", async () => {
    for (let i = 0; i < 5; i += 1) {
      await store.append(ev("song_queued", `2026-07-01T2${i}:00:00.000Z`));
    }
    expect(await store.listRange("2026-07-01", "2026-07-01", { limit: 2 })).toHaveLength(2);
    expect(await store.listRange("2026-07-01", "2026-07-01", { limit: 0 })).toHaveLength(0);
  });

  it("preserves the full event payload (props, uuid, sessionKey) round-trip", async () => {
    const full: TelemetryEvent = {
      event: "song_queued",
      roomId: "room-b",
      uuid: "123e4567-e89b-42d3-a456-426614174000",
      sessionKey: "sess-1",
      ts: "2026-07-01T21:30:00.000Z",
      appVersion: "abc1234",
      props: { kind: "search", mode: "sing" },
    };
    await store.append(full);
    const [back] = await store.listRange("2026-07-01", "2026-07-01");
    expect(back).toEqual(full);
  });

  it("lists days with data, sorted", async () => {
    await store.append(ev("song_queued", "2026-07-03T21:00:00.000Z"));
    await store.append(ev("song_queued", "2026-07-01T21:00:00.000Z"));
    await store.append(ev("song_queued", "2026-07-01T22:00:00.000Z"));
    expect(await store.listDays()).toEqual(["2026-07-01", "2026-07-03"]);
  });

  it("clear() wipes everything", async () => {
    await store.append(ev("song_queued", "2026-07-01T21:00:00.000Z"));
    await store.clear();
    expect(await store.listDays()).toEqual([]);
    expect(await store.listRange("2026-07-01", "2026-07-01")).toEqual([]);
  });

  it("events land in UTC-day buckets (keyspace check via range math)", async () => {
    // 23:59 UTC and 00:01 UTC next day are different buckets.
    await store.append(ev("song_queued", "2026-07-01T23:59:00.000Z"));
    await store.append(ev("song_played", "2026-07-02T00:01:00.000Z"));
    expect(await store.listRange("2026-07-01", "2026-07-01")).toHaveLength(1);
    expect(await store.listRange("2026-07-02", "2026-07-02")).toHaveLength(1);
  });
});

describe("telemetry key schema", () => {
  it("uses its own namespace (never collides with room:* or feedback:*)", () => {
    expect(telemetryKeys.day("2026-07-01")).toBe("telemetry:events:2026-07-01");
    expect(telemetryKeys.days).toBe("telemetry:days");
  });

  it("dayRange is inclusive and bounded", () => {
    expect(dayRange("2026-07-01", "2026-07-03")).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);
    expect(dayRange("2026-07-03", "2026-07-01")).toEqual([]);
    expect(dayRange("garbage", "2026-07-01")).toEqual([]);
  });
});
