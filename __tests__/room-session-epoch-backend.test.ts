/**
 * TICKET-118 — the Upstash room backend's session-epoch counter.
 *
 * The epoch's source of truth is its own key, bumped with INCR, so that the
 * whole-record read-modify-write every room mutation does (TICKET-127) can never
 * roll it back. `get` reads the record and the counter in ONE round trip (MGET)
 * and reports the larger of the record's copy and the counter. These tests drive
 * `UpstashRoomBackend` with an in-memory fake of the few Redis commands it uses,
 * so they pin which commands it sends and how it combines their results; they do
 * not prove Upstash's own atomicity (INCR is atomic in Redis by definition).
 */
import type { Redis } from "@upstash/redis";
import {
  ROOM_CAS_SCRIPT,
  UpstashRoomBackend,
  normaliseRoomRev,
  roomKey,
  roomSessionEpochKey,
  type Room,
} from "@/lib/rooms";

class FakeRedis {
  data = new Map<string, unknown>();
  ttl = new Map<string, number>();
  calls: string[] = [];
  async get(k: string) {
    this.calls.push(`get ${k}`);
    return this.data.get(k) ?? null;
  }
  async mget(...keys: string[]) {
    this.calls.push(`mget ${keys.join(" ")}`);
    return keys.map((k) => this.data.get(k) ?? null);
  }
  async set(k: string, v: unknown) {
    this.calls.push(`set ${k}`);
    this.data.set(k, JSON.parse(JSON.stringify(v)));
    return "OK";
  }
  async incr(k: string) {
    this.calls.push(`incr ${k}`);
    const n = Number(this.data.get(k) ?? 0) + 1;
    this.data.set(k, n);
    return n;
  }
  async incrby(k: string, by: number) {
    this.calls.push(`incrby ${k} ${by}`);
    const n = Number(this.data.get(k) ?? 0) + by;
    this.data.set(k, n);
    return n;
  }
  async pttl(k: string) {
    this.calls.push(`pttl ${k}`);
    if (!this.data.has(k)) return -2;
    return this.ttl.get(k) ?? -1;
  }
  async pexpire(k: string, ms: number) {
    this.calls.push(`pexpire ${k} ${ms}`);
    this.ttl.set(k, ms);
    return 1;
  }
  async persist(k: string) {
    this.calls.push(`persist ${k}`);
    return this.ttl.delete(k) ? 1 : 0;
  }
  /**
   * The room compare-and-set (TICKET-127), modelled in JS: it pins what the backend
   * SENDS (one EVAL, which key, which arguments). The shipped Lua itself is run
   * against a real Redis in room-cas-lua.integration.test.ts.
   */
  evals: Array<{ keys: string[]; args: string[] }> = [];
  async eval(script: string, keys: string[], args: string[]) {
    this.calls.push(`eval ${keys.join(" ")}`);
    if (script !== ROOM_CAS_SCRIPT) throw new Error("unexpected script");
    this.evals.push({ keys, args });
    const cur = this.data.get(keys[0]) as Room | undefined;
    if (cur === undefined) return 0;
    if (normaliseRoomRev(cur.rev) !== Number(args[0])) return -1;
    this.data.set(keys[0], JSON.parse(args[1]));
    if (args[2] !== "1") this.ttl.delete(keys[0]);
    return 1;
  }
}

function room(id: string, extra: Partial<Room> = {}): Room {
  return {
    id,
    name: "Bar",
    hostCodeHash: "h".repeat(64),
    createdAt: "2026-10-15T00:00:00.000Z",
    settings: { mode: "full-karaoke" },
    ...extra,
  };
}

function backend() {
  const fake = new FakeRedis();
  return { fake, be: new UpstashRoomBackend(fake as unknown as Redis) };
}

const ENV = process.env.ROOM_RETENTION_DAYS;
afterEach(() => {
  if (ENV === undefined) delete process.env.ROOM_RETENTION_DAYS;
  else process.env.ROOM_RETENTION_DAYS = ENV;
});

describe("UpstashRoomBackend session epoch", () => {
  it("reads the record and the counter in ONE round trip", async () => {
    const { fake, be } = backend();
    await fake.set(roomKey("bar"), room("bar"));
    fake.calls = [];
    await be.get("bar");
    expect(fake.calls).toEqual([`mget ${roomKey("bar")} ${roomSessionEpochKey("bar")}`]);
  });

  it("a room that never went through a revoke reads back exactly as stored", async () => {
    const { fake, be } = backend();
    await fake.set(roomKey("bar"), room("bar"));
    expect(await be.get("bar")).toEqual(room("bar"));
    expect((await be.get("bar"))!.sessionEpoch).toBeUndefined();
  });

  it("reports the COUNTER when a stale whole-record write lowered the record's copy", async () => {
    const { fake, be } = backend();
    await be.create(room("bar"));
    const stale = (await be.get("bar"))!; // read before the revoke
    expect(await be.bumpSessionEpoch("bar", 0)).toBe(1);
    expect(await be.update({ ...(await be.get("bar"))!, sessionEpoch: 1 })).toBe("ok");
    // TICKET-127: the stale snapshot is now refused outright...
    expect(await be.update(stale)).toBe("conflict");
    // ...so plant it the only way left, a raw SET (an old-code write mid-deploy):
    // the record copy goes back to absent, and the counter still wins.
    await fake.set(roomKey("bar"), stale);
    expect((await be.get("bar"))!.sessionEpoch).toBe(1);
  });

  it("reports the record's copy when the counter key was lost", async () => {
    const { fake, be } = backend();
    await be.create(room("bar", { sessionEpoch: 3 }));
    expect((await be.get("bar"))!.sessionEpoch).toBe(3);
    // and a counter value written as a string still counts
    fake.data.set(roomSessionEpochKey("bar"), "5");
    expect((await be.get("bar"))!.sessionEpoch).toBe(5);
  });

  it("a bump is strictly above both the counter and the floor it is given", async () => {
    const { fake, be } = backend();
    await be.create(room("bar"));
    expect(await be.bumpSessionEpoch("bar", 0)).toBe(1);
    expect(await be.bumpSessionEpoch("bar", 1)).toBe(2);
    // Counter lost while the record still says 7: the bump must jump past 7.
    fake.data.delete(roomSessionEpochKey("bar"));
    expect(await be.bumpSessionEpoch("bar", 7)).toBe(8);
    expect(fake.data.get(roomSessionEpochKey("bar"))).toBe(8);
  });

  it("whole-record writes never touch the counter", async () => {
    const { fake, be } = backend();
    await be.create(room("bar"));
    await be.bumpSessionEpoch("bar", 0);
    fake.calls = [];
    expect(await be.update(room("bar", { sessionEpoch: 0 }))).toBe("ok");
    expect(fake.calls.every((c) => !c.includes(roomSessionEpochKey("bar")))).toBe(true);
    expect(fake.data.get(roomSessionEpochKey("bar"))).toBe(1);
  });

  it("with retention ON, the counter expires with its room", async () => {
    process.env.ROOM_RETENTION_DAYS = "30";
    const { fake, be } = backend();
    await be.create(room("bar"));
    fake.ttl.set(roomKey("bar"), 123_456);
    await be.bumpSessionEpoch("bar", 0);
    expect(fake.ttl.get(roomSessionEpochKey("bar"))).toBe(123_456);
  });

  it("with retention OFF, the counter gets no TTL", async () => {
    delete process.env.ROOM_RETENTION_DAYS;
    const { fake, be } = backend();
    await be.create(room("bar"));
    await be.bumpSessionEpoch("bar", 0);
    expect(fake.ttl.has(roomSessionEpochKey("bar"))).toBe(false);
  });

  // Cyber S4: retention ON when the counter was first bumped, then switched OFF.
  // The next plain-SET update makes the RECORD permanent while the counter kept the
  // TTL an earlier bump copied onto it, so the counter would expire first and the
  // epoch fall back to the record's floor. The next bump must clear that TTL.
  it("a retention ON->OFF flip: the next bump makes the counter permanent like its record", async () => {
    process.env.ROOM_RETENTION_DAYS = "30";
    const { fake, be } = backend();
    await be.create(room("bar"));
    fake.ttl.set(roomKey("bar"), 123_456);
    await be.bumpSessionEpoch("bar", 0);
    expect(fake.ttl.get(roomSessionEpochKey("bar"))).toBe(123_456);
    delete process.env.ROOM_RETENTION_DAYS;
    fake.ttl.delete(roomKey("bar")); // a plain SET dropped the record's TTL (measured -1 in Redis)
    await be.bumpSessionEpoch("bar", 1);
    expect(fake.ttl.has(roomSessionEpochKey("bar"))).toBe(false);
  });
});

describe("UpstashRoomBackend compare-and-set writes (TICKET-127)", () => {
  it("an update is ONE eval of the CAS script on the record key, carrying the read revision", async () => {
    const { fake, be } = backend();
    await be.create(room("bar"));
    fake.calls = [];
    expect(await be.update({ ...room("bar"), name: "Bar 2" })).toBe("ok");
    expect(fake.calls).toEqual([`eval ${roomKey("bar")}`]);
    const [{ args }] = fake.evals;
    expect(args[0]).toBe("0"); // a legacy record has no rev: expected 0
    expect(JSON.parse(args[1])).toEqual({ ...room("bar"), name: "Bar 2", rev: 1 });
    // The stored value is exactly what `get` hands back, revision included.
    expect(await be.get("bar")).toEqual({ ...room("bar"), name: "Bar 2", rev: 1 });
  });

  it("a write from a snapshot older than the stored revision is a conflict and changes nothing", async () => {
    const { fake, be } = backend();
    await be.create(room("bar"));
    const a = (await be.get("bar"))!;
    const b = (await be.get("bar"))!;
    expect(await be.update({ ...a, name: "A" })).toBe("ok");
    expect(await be.update({ ...b, name: "B" })).toBe("conflict");
    expect((fake.data.get(roomKey("bar")) as Room).name).toBe("A");
    // A fresh read carries the new revision and goes through.
    expect(await be.update({ ...(await be.get("bar"))!, name: "B" })).toBe("ok");
    expect((await be.get("bar"))!).toMatchObject({ name: "B", rev: 2 });
  });

  it("never creates a record: updating a missing room is `missing`", async () => {
    const { fake, be } = backend();
    expect(await be.update(room("ghost"))).toBe("missing");
    expect(fake.data.has(roomKey("ghost"))).toBe(false);
  });

  it("keeps the TTL with retention ON, and is a plain SET with it OFF (TICKET-91 unchanged)", async () => {
    const { fake, be } = backend();
    await be.create(room("bar"));
    process.env.ROOM_RETENTION_DAYS = "30";
    await be.update((await be.get("bar"))!);
    delete process.env.ROOM_RETENTION_DAYS;
    await be.update((await be.get("bar"))!);
    expect(fake.evals.map((e) => e.args[2])).toEqual(["1", "0"]);
  });
});
