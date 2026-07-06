/**
 * Store tests (TICKET-6).
 *
 * The same conformance suite runs against BOTH drivers:
 *   - MemoryStore (the CI/dev default)
 *   - UpstashStore backed by an in-process FakeRedis (no network, no creds)
 * so the Upstash driver's logic is exercised without provisioned credentials.
 */

import { MemoryStore } from "@/lib/store/memory";
import { UpstashStore, type RedisLike } from "@/lib/store/upstash";
import {
  QUEUE_MAX,
  DEFAULT_ROOM,
  keys,
  type QueueEntry,
  type QueueStore,
} from "@/lib/store/types";
import { store } from "@/lib/store";

const ROOM = "default";

function makeEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: "entry-1",
    videoId: "dQw4w9WgXcQ",
    nickname: "Alice",
    patronUuid: "uuid-alice",
    mode: "sing",
    submittedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Minimal in-process Redis matching the RedisLike subset UpstashStore uses.
 * Mirrors @upstash/redis semantics (values round-trip as parsed objects).
 */
class FakeRedis implements RedisLike {
  private lists = new Map<string, unknown[]>();
  private kv = new Map<string, unknown>();

  private list(key: string): unknown[] {
    let l = this.lists.get(key);
    if (!l) {
      l = [];
      this.lists.set(key, l);
    }
    return l;
  }

  async lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]> {
    const l = this.list(key);
    // Redis LRANGE is inclusive; stop === -1 means to the end.
    const end = stop === -1 ? l.length : stop + 1;
    return l.slice(start, end) as T[];
  }

  async llen(key: string): Promise<number> {
    return this.list(key).length;
  }

  async rpush(key: string, ...values: unknown[]): Promise<number> {
    const l = this.list(key);
    l.push(...values);
    return l.length;
  }

  async lpop<T = unknown>(key: string): Promise<T | null> {
    const l = this.list(key);
    return (l.shift() as T) ?? null;
  }

  async lindex<T = unknown>(key: string, index: number): Promise<T | null> {
    const l = this.list(key);
    const i = index < 0 ? l.length + index : index;
    return (l[i] as T) ?? null;
  }

  async del(...ks: string[]): Promise<number> {
    let n = 0;
    for (const k of ks) {
      if (this.lists.delete(k)) n++;
      if (this.kv.delete(k)) n++;
    }
    return n;
  }

  async set(key: string, value: unknown): Promise<unknown> {
    this.kv.set(key, value);
    return "OK";
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return (this.kv.get(key) as T) ?? null;
  }
}

const drivers: Array<[string, () => QueueStore]> = [
  ["MemoryStore", () => new MemoryStore()],
  ["UpstashStore(FakeRedis)", () => new UpstashStore(new FakeRedis())],
];

describe.each(drivers)("QueueStore conformance — %s", (_name, make) => {
  let s: QueueStore;
  beforeEach(async () => {
    s = make();
    await s.clear(ROOM);
  });

  describe("initial state", () => {
    it("starts empty", async () => {
      expect(await s.getQueue(ROOM)).toHaveLength(0);
    });
    it("nowPlaying is null when empty", async () => {
      expect(await s.nowPlaying(ROOM)).toBeNull();
    });
    it("isPaused defaults to false", async () => {
      expect(await s.isPaused(ROOM)).toBe(false);
    });
  });

  describe("addEntry", () => {
    it("adds an entry and returns true", async () => {
      expect(await s.addEntry(ROOM, makeEntry({ id: "a" }))).toBe(true);
      expect(await s.getQueue(ROOM)).toHaveLength(1);
    });
    it("preserves submission order", async () => {
      await s.addEntry(ROOM, makeEntry({ id: "first", nickname: "Alice" }));
      await s.addEntry(ROOM, makeEntry({ id: "second", nickname: "Bob" }));
      await s.addEntry(ROOM, makeEntry({ id: "third", nickname: "Carol" }));
      const q = await s.getQueue(ROOM);
      expect(q.map((e) => e.nickname)).toEqual(["Alice", "Bob", "Carol"]);
    });
    it("preserves the reserved graceRequeue field", async () => {
      await s.addEntry(ROOM, makeEntry({ id: "g", graceRequeue: true }));
      const [entry] = await s.getQueue(ROOM);
      expect(entry.graceRequeue).toBe(true);
    });
  });

  describe("nowPlaying", () => {
    it("returns the head entry", async () => {
      await s.addEntry(ROOM, makeEntry({ id: "x", nickname: "Alice" }));
      await s.addEntry(ROOM, makeEntry({ id: "y", nickname: "Bob" }));
      expect((await s.nowPlaying(ROOM))?.nickname).toBe("Alice");
    });
  });

  describe("advance", () => {
    it("removes the head and returns the new head", async () => {
      await s.addEntry(ROOM, makeEntry({ id: "a", nickname: "Alice" }));
      await s.addEntry(ROOM, makeEntry({ id: "b", nickname: "Bob" }));
      const next = await s.advance(ROOM);
      expect(next?.nickname).toBe("Bob");
      expect(await s.getQueue(ROOM)).toHaveLength(1);
    });
    it("returns null when the queue becomes empty", async () => {
      await s.addEntry(ROOM, makeEntry({ id: "only" }));
      expect(await s.advance(ROOM)).toBeNull();
      expect(await s.getQueue(ROOM)).toHaveLength(0);
    });
    it("returns null on an empty queue", async () => {
      expect(await s.advance(ROOM)).toBeNull();
    });
    it("drains in FIFO order", async () => {
      const names = ["Alice", "Bob", "Carol", "Dave"];
      for (const [i, name] of names.entries()) {
        await s.addEntry(ROOM, makeEntry({ id: `e${i}`, nickname: name }));
      }
      const order: string[] = [];
      while ((await s.getQueue(ROOM)).length > 0) {
        order.push((await s.nowPlaying(ROOM))!.nickname);
        await s.advance(ROOM);
      }
      expect(order).toEqual(names);
    });
  });

  describe("removeEntry (host control, TICKET-7)", () => {
    it("removes a middle entry by id", async () => {
      await s.addEntry(ROOM, makeEntry({ id: "a", nickname: "Alice" }));
      await s.addEntry(ROOM, makeEntry({ id: "b", nickname: "Bob" }));
      await s.addEntry(ROOM, makeEntry({ id: "c", nickname: "Carol" }));
      expect(await s.removeEntry(ROOM, "b")).toBe(true);
      const q = await s.getQueue(ROOM);
      expect(q.map((e) => e.id)).toEqual(["a", "c"]);
    });
    it("returns false for an unknown id", async () => {
      await s.addEntry(ROOM, makeEntry({ id: "a" }));
      expect(await s.removeEntry(ROOM, "nope")).toBe(false);
      expect(await s.getQueue(ROOM)).toHaveLength(1);
    });
    it("can remove the head", async () => {
      await s.addEntry(ROOM, makeEntry({ id: "a" }));
      await s.addEntry(ROOM, makeEntry({ id: "b" }));
      expect(await s.removeEntry(ROOM, "a")).toBe(true);
      expect((await s.nowPlaying(ROOM))?.id).toBe("b");
    });
  });

  describe("reorder (host control, TICKET-7)", () => {
    beforeEach(async () => {
      await s.addEntry(ROOM, makeEntry({ id: "a" }));
      await s.addEntry(ROOM, makeEntry({ id: "b" }));
      await s.addEntry(ROOM, makeEntry({ id: "c" }));
    });
    it("moves an entry to the front", async () => {
      expect(await s.reorder(ROOM, "c", 0)).toBe(true);
      expect((await s.getQueue(ROOM)).map((e) => e.id)).toEqual(["c", "a", "b"]);
    });
    it("moves an entry to the back", async () => {
      expect(await s.reorder(ROOM, "a", 2)).toBe(true);
      expect((await s.getQueue(ROOM)).map((e) => e.id)).toEqual(["b", "c", "a"]);
    });
    it("clamps an out-of-range index", async () => {
      expect(await s.reorder(ROOM, "a", 99)).toBe(true);
      expect((await s.getQueue(ROOM)).map((e) => e.id)).toEqual(["b", "c", "a"]);
    });
    it("returns false for an unknown id", async () => {
      expect(await s.reorder(ROOM, "nope", 0)).toBe(false);
      expect((await s.getQueue(ROOM)).map((e) => e.id)).toEqual(["a", "b", "c"]);
    });
  });

  describe("pause flag (host control, TICKET-7)", () => {
    it("sets and reads the paused flag", async () => {
      await s.setPaused(ROOM, true);
      expect(await s.isPaused(ROOM)).toBe(true);
      await s.setPaused(ROOM, false);
      expect(await s.isPaused(ROOM)).toBe(false);
    });
    it("clear() resets the paused flag", async () => {
      await s.setPaused(ROOM, true);
      await s.clear(ROOM);
      expect(await s.isPaused(ROOM)).toBe(false);
    });
  });

  describe("room scoping", () => {
    it("keeps separate queues per room", async () => {
      await s.addEntry("room-a", makeEntry({ id: "a", nickname: "Alice" }));
      await s.addEntry("room-b", makeEntry({ id: "b", nickname: "Bob" }));
      expect((await s.getQueue("room-a")).map((e) => e.id)).toEqual(["a"]);
      expect((await s.getQueue("room-b")).map((e) => e.id)).toEqual(["b"]);
    });
    it("keeps separate paused flags per room", async () => {
      await s.setPaused("room-a", true);
      expect(await s.isPaused("room-a")).toBe(true);
      expect(await s.isPaused("room-b")).toBe(false);
    });
  });

  describe("queue depth cap (QUEUE_MAX)", () => {
    it("rejects additions beyond QUEUE_MAX", async () => {
      for (let i = 0; i < QUEUE_MAX; i++) {
        expect(await s.addEntry(ROOM, makeEntry({ id: `e${i}` }))).toBe(true);
      }
      expect(await s.addEntry(ROOM, makeEntry({ id: "overflow" }))).toBe(false);
      expect(await s.getQueue(ROOM)).toHaveLength(QUEUE_MAX);
    });
    it("accepts again after advancing when full", async () => {
      for (let i = 0; i < QUEUE_MAX; i++) {
        await s.addEntry(ROOM, makeEntry({ id: `e${i}` }));
      }
      await s.advance(ROOM);
      expect(await s.addEntry(ROOM, makeEntry({ id: "after" }))).toBe(true);
    });
  });
});

describe("key schema is room-scoped", () => {
  it("namespaces every key under room:<id>", () => {
    expect(keys.queue("default")).toBe("room:default:queue");
    expect(keys.paused("default")).toBe("room:default:paused");
    expect(keys.queue("venue-7")).toBe("room:venue-7:queue");
  });
});

describe("default store singleton (memory driver, no creds)", () => {
  beforeEach(async () => {
    await store.clear(DEFAULT_ROOM);
  });
  it("uses the memory driver when no Upstash creds are present", async () => {
    // A no-cred CI/dev environment must resolve to the in-process driver.
    expect(store).toBeInstanceOf(MemoryStore);
  });
  it("round-trips an entry via the singleton", async () => {
    await store.addEntry(DEFAULT_ROOM, makeEntry({ id: "s1" }));
    expect((await store.nowPlaying(DEFAULT_ROOM))?.id).toBe("s1");
  });
});
