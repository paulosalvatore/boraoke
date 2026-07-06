/**
 * Feedback store tests (TICKET-11) — exercises BOTH drivers against the same
 * contract: the in-process memory driver AND the Upstash driver (via an injected
 * fake redis, so no network/credentials). Covers add/list/get/updateStatus, the
 * `since` watermark cursor + idempotency, and the durable rate limiter.
 */
import {
  MemoryFeedbackStore,
  UpstashFeedbackStore,
  generateFeedbackId,
  type FeedbackRedisLike,
  type FeedbackStore,
} from "@/lib/feedback-store";
import {
  RATE_LIMIT_MAX,
  type FeedbackRecord,
} from "@/lib/feedback-types";

/** Minimal in-memory fake of the Redis subset the feedback store uses. */
class FakeRedis implements FeedbackRedisLike {
  private kv = new Map<string, string>();
  private lists = new Map<string, string[]>();
  private nums = new Map<string, number>();

  async rpush(key: string, ...values: unknown[]): Promise<number> {
    const arr = this.lists.get(key) ?? [];
    for (const v of values) arr.push(v as string);
    this.lists.set(key, arr);
    return arr.length;
  }
  async lrange<T = unknown>(
    key: string,
    start: number,
    stop: number,
  ): Promise<T[]> {
    const arr = this.lists.get(key) ?? [];
    const end = stop === -1 ? arr.length : stop + 1;
    return arr.slice(start, end) as unknown as T[];
  }
  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = this.kv.get(key);
    if (raw != null) return JSON.parse(raw) as T; // mimic auto-deserialization
    const n = this.nums.get(key);
    return (n ?? null) as unknown as T | null;
  }
  async set(key: string, value: unknown): Promise<unknown> {
    this.kv.set(key, JSON.stringify(value));
    return "OK";
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.kv.delete(k)) n++;
      if (this.lists.delete(k)) n++;
      if (this.nums.delete(k)) n++;
    }
    return n;
  }
  async incr(key: string): Promise<number> {
    const next = (this.nums.get(key) ?? 0) + 1;
    this.nums.set(key, next);
    return next;
  }
  async expire(): Promise<unknown> {
    return 1; // TTL is a no-op in the fake
  }
}

function makeRecord(id: string, over: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    id,
    sentiment: "happy",
    context: {
      uuid: "123e4567-e89b-42d3-a456-426614174000",
      route: "/",
      role: "patron",
    },
    status: "new",
    ...over,
  };
}

// Run the whole contract suite against each driver.
const drivers: Array<[string, () => FeedbackStore]> = [
  ["MemoryFeedbackStore", () => new MemoryFeedbackStore()],
  ["UpstashFeedbackStore", () => new UpstashFeedbackStore(new FakeRedis())],
];

describe.each(drivers)("FeedbackStore contract — %s", (_name, make) => {
  let store: FeedbackStore;
  beforeEach(() => {
    store = make();
  });

  it("adds and lists records in chronological (id) order", async () => {
    const a = makeRecord(generateFeedbackId(1_000));
    const b = makeRecord(generateFeedbackId(2_000));
    const c = makeRecord(generateFeedbackId(3_000));
    // Add out of order — list must still be chronological.
    await store.add(b);
    await store.add(a);
    await store.add(c);
    const ids = (await store.list()).map((r) => r.id);
    expect(ids).toEqual([a.id, b.id, c.id]);
  });

  it("filters by the `since` watermark and is idempotent on re-read", async () => {
    const a = makeRecord(generateFeedbackId(1_000));
    const b = makeRecord(generateFeedbackId(2_000));
    const c = makeRecord(generateFeedbackId(3_000));
    await store.add(a);
    await store.add(b);
    await store.add(c);

    const after = await store.list({ since: a.id });
    expect(after.map((r) => r.id)).toEqual([b.id, c.id]);

    // Re-reading from the newest processed id yields nothing (no double-count).
    const again = await store.list({ since: c.id });
    expect(again).toEqual([]);
  });

  it("respects the limit cap", async () => {
    for (let i = 1; i <= 5; i++) {
      await store.add(makeRecord(generateFeedbackId(i * 1000)));
    }
    expect(await store.list({ limit: 2 })).toHaveLength(2);
  });

  it("gets a single record by id, or null", async () => {
    const rec = makeRecord(generateFeedbackId(1_000), { text: "oi" });
    await store.add(rec);
    expect((await store.get(rec.id))?.text).toBe("oi");
    expect(await store.get("nope")).toBeNull();
  });

  it("updates status + triageRef, and reports not-found", async () => {
    const rec = makeRecord(generateFeedbackId(1_000));
    await store.add(rec);
    expect(await store.updateStatus(rec.id, "triaged", "cluster-7")).toBe(true);
    const after = await store.get(rec.id);
    expect(after?.status).toBe("triaged");
    expect(after?.triageRef).toBe("cluster-7");
    expect(await store.updateStatus("missing", "triaged")).toBe(false);
  });

  it("rate-limits 5/uuid/hour and isolates per uuid", async () => {
    const uuid = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const results = [];
    for (let i = 0; i < RATE_LIMIT_MAX + 1; i++) {
      results.push(await store.hitRateLimit(uuid));
    }
    // First RATE_LIMIT_MAX allowed, the next rejected.
    expect(results.slice(0, RATE_LIMIT_MAX).every((r) => r.allowed)).toBe(true);
    expect(results[RATE_LIMIT_MAX].allowed).toBe(false);
    expect(results[RATE_LIMIT_MAX].count).toBe(RATE_LIMIT_MAX + 1);

    // A different uuid starts fresh.
    const other = await store.hitRateLimit("bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb");
    expect(other.allowed).toBe(true);
    expect(other.count).toBe(1);
  });
});

describe("generateFeedbackId", () => {
  it("produces lexicographically sortable ids by timestamp", () => {
    const earlier = generateFeedbackId(1_000);
    const later = generateFeedbackId(2_000);
    expect(earlier < later).toBe(true);
  });
});
