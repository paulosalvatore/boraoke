/**
 * Room-memory lib tests (TICKET-43) — pure functions against an injected fake
 * `localStorage`, so they run under jest's node env with no DOM. Covers
 * add / dedupe / forget / order / cap, the role-merge (created is sticky), the
 * sync seam, corrupt-blob tolerance, and the load-bearing NEVER-STORES-HOSTCODE
 * security invariant.
 */
import {
  ROOMS_KEY,
  MAX_ROOMS,
  MAX_HOST_PROBES,
  loadRooms,
  rememberCreatedRoom,
  rememberJoinedRoom,
  forgetRoom,
  roomsToProbe,
  syncLocalRooms,
  type StorageLike,
} from "@/lib/room-memory";

/** Minimal in-memory fake of the localStorage subset the lib uses. */
class FakeStorage implements StorageLike {
  kv = new Map<string, string>();
  getItem(key: string): string | null {
    return this.kv.has(key) ? (this.kv.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.kv.set(key, value);
  }
  removeItem(key: string): void {
    this.kv.delete(key);
  }
  /** Raw JSON blob under the rooms key (for invariant inspection). */
  raw(): string {
    return this.kv.get(ROOMS_KEY) ?? "";
  }
}

let store: FakeStorage;
beforeEach(() => {
  store = new FakeStorage();
});

describe("add", () => {
  it("remembers a created room with id/name/role/claimable", () => {
    rememberCreatedRoom({ id: "bar-do-ze", name: "Bar do Zé", createdAt: 1000 }, store);
    const rooms = loadRooms(store);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({
      id: "bar-do-ze",
      name: "Bar do Zé",
      role: "created",
      lastTouched: 1000,
      claimable: true,
    });
  });

  it("remembers a joined room (not claimable — patron doesn't own it)", () => {
    rememberJoinedRoom({ id: "boteco", name: "Boteco", lastSeen: 2000 }, store);
    const rooms = loadRooms(store);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ id: "boteco", role: "joined", claimable: false });
  });

  it("defaults timestamp to now when omitted", () => {
    const before = Date.now();
    rememberCreatedRoom({ id: "r", name: "R" }, store);
    const after = Date.now();
    const [room] = loadRooms(store);
    expect(room.lastTouched).toBeGreaterThanOrEqual(before);
    expect(room.lastTouched).toBeLessThanOrEqual(after);
  });
});

describe("dedupe", () => {
  it("keeps a single entry per room id, refreshing recency", () => {
    rememberJoinedRoom({ id: "same", name: "Same", lastSeen: 1000 }, store);
    rememberJoinedRoom({ id: "same", name: "Same v2", lastSeen: 5000 }, store);
    const rooms = loadRooms(store);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].name).toBe("Same v2");
    expect(rooms[0].lastTouched).toBe(5000);
  });

  it("created mark is sticky — join after create stays created + claimable", () => {
    rememberCreatedRoom({ id: "mine", name: "Mine", createdAt: 1000 }, store);
    rememberJoinedRoom({ id: "mine", name: "Mine", lastSeen: 9000 }, store);
    const [room] = loadRooms(store);
    expect(room.role).toBe("created");
    expect(room.claimable).toBe(true);
    expect(room.lastTouched).toBe(9000);
  });

  it("create after join upgrades role to created", () => {
    rememberJoinedRoom({ id: "up", name: "Up", lastSeen: 1000 }, store);
    rememberCreatedRoom({ id: "up", name: "Up", createdAt: 2000 }, store);
    const [room] = loadRooms(store);
    expect(room.role).toBe("created");
    expect(room.claimable).toBe(true);
  });
});

describe("order", () => {
  it("lists most-recent-first", () => {
    rememberJoinedRoom({ id: "old", name: "Old", lastSeen: 100 }, store);
    rememberJoinedRoom({ id: "new", name: "New", lastSeen: 900 }, store);
    rememberJoinedRoom({ id: "mid", name: "Mid", lastSeen: 500 }, store);
    expect(loadRooms(store).map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  it("re-touching a room moves it to the front", () => {
    rememberJoinedRoom({ id: "a", name: "A", lastSeen: 100 }, store);
    rememberJoinedRoom({ id: "b", name: "B", lastSeen: 200 }, store);
    rememberJoinedRoom({ id: "a", name: "A", lastSeen: 300 }, store);
    expect(loadRooms(store).map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("cap", () => {
  it(`caps at ${MAX_ROOMS}, dropping oldest`, () => {
    for (let i = 0; i < MAX_ROOMS + 10; i++) {
      rememberJoinedRoom({ id: `room-${i}`, name: `Room ${i}`, lastSeen: i }, store);
    }
    const rooms = loadRooms(store);
    expect(rooms).toHaveLength(MAX_ROOMS);
    // Newest kept, oldest dropped.
    expect(rooms[0].id).toBe(`room-${MAX_ROOMS + 9}`);
    expect(rooms.some((r) => r.id === "room-0")).toBe(false);
  });
});

describe("forget", () => {
  it("removes a single room, leaving the rest", () => {
    rememberJoinedRoom({ id: "keep", name: "Keep", lastSeen: 1 }, store);
    rememberJoinedRoom({ id: "drop", name: "Drop", lastSeen: 2 }, store);
    const after = forgetRoom("drop", store);
    expect(after.map((r) => r.id)).toEqual(["keep"]);
    expect(loadRooms(store).map((r) => r.id)).toEqual(["keep"]);
  });

  it("is a no-op for an unknown id", () => {
    rememberJoinedRoom({ id: "only", name: "Only", lastSeen: 1 }, store);
    expect(forgetRoom("ghost", store).map((r) => r.id)).toEqual(["only"]);
  });
});

describe("resilience", () => {
  it("returns [] for a missing blob", () => {
    expect(loadRooms(store)).toEqual([]);
  });

  it("returns [] for a corrupt blob", () => {
    store.setItem(ROOMS_KEY, "{not json");
    expect(loadRooms(store)).toEqual([]);
  });

  it("drops malformed entries but keeps valid ones", () => {
    store.setItem(
      ROOMS_KEY,
      JSON.stringify([
        { id: "good", name: "Good", role: "joined", lastTouched: 5 },
        { role: "joined", lastTouched: 1 }, // no id
        { id: "bad-role", name: "X", role: "spectator", lastTouched: 2 },
        "totally wrong",
      ]),
    );
    expect(loadRooms(store).map((r) => r.id)).toEqual(["good"]);
  });
});

describe("probe bound (BLOCKING-1, PR #22)", () => {
  it(`probes at most ${MAX_HOST_PROBES} created rooms with 5+ created remembered`, () => {
    for (let i = 0; i < 5; i++) {
      rememberCreatedRoom({ id: `mine-${i}`, name: `Mine ${i}`, createdAt: i }, store);
    }
    rememberJoinedRoom({ id: "guest", name: "Guest", lastSeen: 999 }, store);

    const probes = roomsToProbe(loadRooms(store));
    expect(probes).toHaveLength(MAX_HOST_PROBES);
    // Most-recent created rooms first; the joined room is never probed.
    expect(probes.map((r) => r.id)).toEqual(["mine-4", "mine-3", "mine-2"]);
    expect(probes.every((r) => r.role === "created")).toBe(true);
  });

  it("probes fewer when fewer created rooms exist, and none for joined-only", () => {
    rememberCreatedRoom({ id: "only", name: "Only", createdAt: 1 }, store);
    rememberJoinedRoom({ id: "guest", name: "Guest", lastSeen: 2 }, store);
    expect(roomsToProbe(loadRooms(store)).map((r) => r.id)).toEqual(["only"]);

    const joinedOnly = loadRooms(store).filter((r) => r.role === "joined");
    expect(roomsToProbe(joinedOnly)).toEqual([]);
  });

  it("respects a custom limit", () => {
    for (let i = 0; i < 4; i++) {
      rememberCreatedRoom({ id: `r-${i}`, name: `R ${i}`, createdAt: i }, store);
    }
    expect(roomsToProbe(loadRooms(store), 1).map((r) => r.id)).toEqual(["r-3"]);
  });
});

describe("sync seam", () => {
  it("returns only claimable (created) rooms and mutates nothing", () => {
    rememberCreatedRoom({ id: "owned", name: "Owned", createdAt: 1 }, store);
    rememberJoinedRoom({ id: "guested", name: "Guested", lastSeen: 2 }, store);
    const before = store.raw();
    const claimable = syncLocalRooms(store);
    expect(claimable.map((r) => r.id)).toEqual(["owned"]);
    expect(store.raw()).toBe(before); // no side effects
  });
});

describe("SECURITY INVARIANT — never stores host code", () => {
  it("does not persist a hostCode even if smuggled into the input object", () => {
    // Simulate an over-broad create response object being passed wholesale.
    const roomResponse = {
      id: "secret",
      name: "Secret Bar",
      hostCode: "SUPER-SECRET-1234",
      createdAt: 1000,
    } as { id: string; name: string; createdAt: number };
    rememberCreatedRoom(roomResponse, store);

    const blob = store.raw();
    expect(blob).not.toContain("SUPER-SECRET-1234");
    expect(blob).not.toContain("hostCode");

    const [room] = loadRooms(store);
    expect(room).not.toHaveProperty("hostCode");
    // Sanity: the room IS remembered, just without the code.
    expect(room.id).toBe("secret");
  });

  it("no persisted room object carries any host-code-shaped field", () => {
    rememberCreatedRoom({ id: "a", name: "A" }, store);
    rememberJoinedRoom({ id: "b", name: "B" }, store);
    for (const room of loadRooms(store)) {
      expect(Object.keys(room)).toEqual(
        expect.arrayContaining(["id", "name", "role", "lastTouched", "claimable"]),
      );
      expect(room).not.toHaveProperty("hostCode");
      expect(room).not.toHaveProperty("code");
    }
  });
});
