import {
  getQueue,
  addToQueue,
  advanceQueue,
  nowPlaying,
  clearQueue,
  isQueueFull,
  QUEUE_MAX,
  type QueueEntry,
} from "@/lib/store";

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

describe("queue store", () => {
  beforeEach(() => {
    clearQueue();
  });

  describe("initial state", () => {
    it("starts empty", () => {
      expect(getQueue()).toHaveLength(0);
    });

    it("nowPlaying is null when empty", () => {
      expect(nowPlaying()).toBeNull();
    });
  });

  describe("addToQueue", () => {
    it("adds an entry", () => {
      addToQueue(makeEntry({ id: "a" }));
      expect(getQueue()).toHaveLength(1);
    });

    it("preserves submission order", () => {
      addToQueue(makeEntry({ id: "first", nickname: "Alice" }));
      addToQueue(makeEntry({ id: "second", nickname: "Bob" }));
      addToQueue(makeEntry({ id: "third", nickname: "Carol" }));
      const q = getQueue();
      expect(q[0].nickname).toBe("Alice");
      expect(q[1].nickname).toBe("Bob");
      expect(q[2].nickname).toBe("Carol");
    });
  });

  describe("nowPlaying", () => {
    it("returns the first entry", () => {
      addToQueue(makeEntry({ id: "x", nickname: "Alice" }));
      addToQueue(makeEntry({ id: "y", nickname: "Bob" }));
      expect(nowPlaying()?.nickname).toBe("Alice");
    });
  });

  describe("advanceQueue", () => {
    it("removes the head and returns the new head", () => {
      addToQueue(makeEntry({ id: "a", nickname: "Alice" }));
      addToQueue(makeEntry({ id: "b", nickname: "Bob" }));
      const next = advanceQueue();
      expect(next?.nickname).toBe("Bob");
      expect(getQueue()).toHaveLength(1);
    });

    it("returns null when queue becomes empty after advance", () => {
      addToQueue(makeEntry({ id: "only" }));
      const next = advanceQueue();
      expect(next).toBeNull();
      expect(getQueue()).toHaveLength(0);
    });

    it("returns null on empty queue", () => {
      expect(advanceQueue()).toBeNull();
    });
  });

  describe("queue depth cap (QUEUE_MAX)", () => {
    it("rejects additions beyond QUEUE_MAX", () => {
      for (let i = 0; i < QUEUE_MAX; i++) {
        expect(addToQueue(makeEntry({ id: `e${i}` }))).toBe(true);
      }
      expect(isQueueFull()).toBe(true);
      expect(addToQueue(makeEntry({ id: "overflow" }))).toBe(false);
      expect(getQueue()).toHaveLength(QUEUE_MAX);
    });

    it("isQueueFull is false below capacity", () => {
      addToQueue(makeEntry({ id: "a" }));
      expect(isQueueFull()).toBe(false);
    });

    it("accepts again after advancing when full", () => {
      for (let i = 0; i < QUEUE_MAX; i++) {
        addToQueue(makeEntry({ id: `e${i}` }));
      }
      advanceQueue();
      expect(isQueueFull()).toBe(false);
      expect(addToQueue(makeEntry({ id: "after-advance" }))).toBe(true);
    });
  });

  describe("ordering integrity under multiple advances", () => {
    it("drains in FIFO order", () => {
      const names = ["Alice", "Bob", "Carol", "Dave"];
      names.forEach((name, i) =>
        addToQueue(makeEntry({ id: `e${i}`, nickname: name }))
      );
      const order: string[] = [];
      while (getQueue().length > 0) {
        order.push(nowPlaying()!.nickname);
        advanceQueue();
      }
      expect(order).toEqual(names);
    });
  });
});
