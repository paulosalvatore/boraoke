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

  /**
   * Emulate the atomic MERGE_SCRIPT (TICKET-21). The real script runs on the
   * Redis server over stored JSON strings; this in-process fake operates on the
   * already-deserialized objects (matching @upstash's automaticDeserialization),
   * but applies the identical merge algorithm. Executing synchronously here
   * models the script's server-side atomicity (no interleave mid-merge).
   *
   * args[0] = JSON array of desired entries, each element a JSON.stringify'd entry.
   * args[1] = JSON array of snapshot ids.
   */
  async eval<T = unknown>(
    _script: string,
    ks: string[],
    args: unknown[],
  ): Promise<T> {
    const key = ks[0];
    const desired = (JSON.parse(args[0] as string) as string[]).map(
      (s) => JSON.parse(s) as { id?: string },
    );
    const snapshot = JSON.parse(args[1] as string) as string[];
    const inSnapshot = new Set(snapshot);
    const current = this.list(key) as Array<{ id?: string }>;
    const present = new Set(current.map((e) => e.id));
    const kept = desired.filter((e) => e.id != null && present.has(e.id));
    const appended = current.filter((e) => e.id != null && !inSnapshot.has(e.id));
    const out = [...kept, ...appended];
    this.lists.set(key, out);
    return out.length as T;
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

  describe("rewrite (bulk replace, TICKET-10 — security MEDIUM-1)", () => {
    beforeEach(async () => {
      await s.addEntry(ROOM, makeEntry({ id: "a" }));
      await s.addEntry(ROOM, makeEntry({ id: "b" }));
      await s.addEntry(ROOM, makeEntry({ id: "c" }));
    });
    it("replaces the queue in the given order (one bulk op)", async () => {
      const current = await s.getQueue(ROOM);
      const byId = new Map(current.map((e) => [e.id, e]));
      await s.rewrite(ROOM, [byId.get("c")!, byId.get("a")!, byId.get("b")!]);
      expect((await s.getQueue(ROOM)).map((e) => e.id)).toEqual(["c", "a", "b"]);
    });
    it("an empty array empties the queue", async () => {
      await s.rewrite(ROOM, []);
      expect(await s.getQueue(ROOM)).toHaveLength(0);
      expect(await s.nowPlaying(ROOM)).toBeNull();
    });
    it("preserves full entry payloads across the rewrite", async () => {
      const entry = makeEntry({
        id: "rich",
        title: "Evidências",
        table: "7",
        mode: "listen-dance",
        graceRequeue: true,
      });
      await s.rewrite(ROOM, [entry]);
      const [got] = await s.getQueue(ROOM);
      expect(got).toEqual(entry);
    });
    it("does not touch other rooms", async () => {
      await s.addEntry("room-other", makeEntry({ id: "x" }));
      await s.rewrite(ROOM, []);
      expect((await s.getQueue("room-other")).map((e) => e.id)).toEqual(["x"]);
    });
    it("later caller-side mutation of the passed array does not leak in", async () => {
      const current = await s.getQueue(ROOM);
      const arr = [...current];
      await s.rewrite(ROOM, arr);
      arr.pop(); // caller mutates after the call
      expect(await s.getQueue(ROOM)).toHaveLength(3);
    });
  });

  describe("rewrite merge-on-write — atomic RMW (TICKET-21)", () => {
    beforeEach(async () => {
      await s.addEntry(ROOM, makeEntry({ id: "a" }));
      await s.addEntry(ROOM, makeEntry({ id: "b" }));
      await s.addEntry(ROOM, makeEntry({ id: "c" }));
    });

    it("reorders in the given order when nothing raced (snapshot mode)", async () => {
      const q = await s.getQueue(ROOM);
      const byId = new Map(q.map((e) => [e.id, e]));
      await s.rewrite(ROOM, [byId.get("c")!, byId.get("a")!, byId.get("b")!], {
        snapshot: q.map((e) => e.id),
      });
      expect((await s.getQueue(ROOM)).map((e) => e.id)).toEqual(["c", "a", "b"]);
    });

    it("drops a desired entry whose id vanished concurrently (advance/remove)", async () => {
      const q = await s.getQueue(ROOM); // snapshot [a,b,c]
      // A concurrent op removed "b" AFTER our read.
      await s.removeEntry(ROOM, "b");
      // We still ask to rewrite the whole snapshot, "b" included.
      await s.rewrite(ROOM, [q[2], q[1], q[0]], { snapshot: q.map((e) => e.id) });
      // "b" is NOT resurrected — the vanished id is respected.
      expect((await s.getQueue(ROOM)).map((e) => e.id)).toEqual(["c", "a"]);
    });

    it("wholesale mode (no snapshot) still overwrites, empty empties", async () => {
      await s.rewrite(ROOM, []);
      expect(await s.getQueue(ROOM)).toHaveLength(0);
    });
  });

  describe("CONCURRENCY REGRESSION — append-during-relay never loses a submit (TICKET-21)", () => {
    // This is the exact PR #14 opus-review failure: a concurrent addEntry (atomic
    // RPUSH) landing between a relay's getQueue and its rewrite. Deterministically
    // interleaved: read snapshot → inject the concurrent submit → apply the relay.
    // Under the OLD wholesale rewrite the injected entry was PERMANENTLY lost.
    it("preserves a submit that lands between the relay's read and its rewrite", async () => {
      await s.addEntry(ROOM, makeEntry({ id: "np", nickname: "NowPlaying" }));
      await s.addEntry(ROOM, makeEntry({ id: "x", nickname: "Xavier" }));

      // 1) Relay reads the queue it intends to reorder.
      const snapshot = await s.getQueue(ROOM); // [np, x]

      // 2) A concurrent patron submits — atomic append — AFTER the relay's read.
      await s.addEntry(ROOM, makeEntry({ id: "late", nickname: "Latecomer" }));

      // 3) Relay applies its desired ordering computed from the STALE snapshot
      //    (it never saw "late"). Merge mode with the snapshot ids.
      const desired = [snapshot[1], snapshot[0]]; // reorder [x, np]
      await s.rewrite(ROOM, desired, { snapshot: snapshot.map((e) => e.id) });

      // 4) The late submit MUST survive (re-appended), plus the reordering held.
      const ids = (await s.getQueue(ROOM)).map((e) => e.id);
      expect(ids).toContain("late");
      expect(ids).toEqual(["x", "np", "late"]);
    });

    it("two racing relays: the earlier reader's stale rewrite keeps the newer submit", async () => {
      await s.addEntry(ROOM, makeEntry({ id: "A" }));

      // R1 reads first (only sees A).
      const s1 = await s.getQueue(ROOM); // [A]
      // R2's submit + rewrite happen while R1 is mid-flight.
      await s.addEntry(ROOM, makeEntry({ id: "B" }));
      const s2 = await s.getQueue(ROOM); // [A, B]
      await s.rewrite(ROOM, s2, { snapshot: s2.map((e) => e.id) });
      // R1 finally applies its stale ordering (no B in its snapshot).
      await s.rewrite(ROOM, s1, { snapshot: s1.map((e) => e.id) });

      // B is NOT clobbered by R1's stale rewrite.
      expect((await s.getQueue(ROOM)).map((e) => e.id)).toEqual(["A", "B"]);
    });
  });

  describe("host-op races — removeEntry / reorder vs a concurrent submit (TICKET-21)", () => {
    it("removeEntry removes its target and keeps a concurrently-added entry", async () => {
      await s.addEntry(ROOM, makeEntry({ id: "a" }));
      await s.addEntry(ROOM, makeEntry({ id: "b" }));
      // "c" was added by a concurrent submit; removeEntry(b) must not drop it.
      await s.addEntry(ROOM, makeEntry({ id: "c" }));
      expect(await s.removeEntry(ROOM, "b")).toBe(true);
      expect((await s.getQueue(ROOM)).map((e) => e.id)).toEqual(["a", "c"]);
    });

    it("reorder moves its target and keeps a concurrently-added entry", async () => {
      await s.addEntry(ROOM, makeEntry({ id: "a" }));
      await s.addEntry(ROOM, makeEntry({ id: "b" }));
      await s.addEntry(ROOM, makeEntry({ id: "c" }));
      expect(await s.reorder(ROOM, "c", 0)).toBe(true);
      expect((await s.getQueue(ROOM)).map((e) => e.id)).toEqual(["c", "a", "b"]);
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
