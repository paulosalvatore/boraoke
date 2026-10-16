/**
 * REAL-REDIS execution of TICKET-127's `ROOM_CAS_SCRIPT`, and of the Upstash room
 * backend end to end. Opt-in like the other Lua suites: set REDIS_TEST_URL to a
 * redis:// server, e.g.
 *   docker run --rm -d -p 6427:6379 redis:7-alpine
 *   REDIS_TEST_URL=redis://127.0.0.1:6427 npx jest room-cas-lua
 * Unset, it skips with one explanatory test.
 *
 * The JS suites drive the memory backend and a JS fake of the script, so this is
 * the only proof that the SHIPPED Lua does what its docblock says: the revision
 * compare, its normalisation (which must match `normaliseRoomRev` exactly, or a
 * room's writes would all conflict), KEEPTTL, and never creating a record. Then it
 * runs every writer pair from room-write-race.test.ts with the app's room backend
 * swapped for `UpstashRoomBackend` on that real Redis.
 *
 * `@upstash/redis` speaks REST, which a plain Redis does not, so `RespUpstash`
 * below adapts the few commands the backend uses onto RESP, with the same
 * serialization @upstash/redis applies (objects JSON-encoded on write, replies
 * JSON-parsed on read, strings passed through raw).
 */
import type { Redis } from "@upstash/redis";
import {
  ROOM_CAS_SCRIPT,
  UpstashRoomBackend,
  normaliseRoomRev,
  roomBackend,
  roomKey,
  type Room,
} from "@/lib/rooms";
import { Resp } from "./helpers/resp";
import { PAIRS, runPair } from "./helpers/room-writers";

const REDIS_URL = process.env.REDIS_TEST_URL;
const maybe = REDIS_URL ? describe : describe.skip;

if (!REDIS_URL) {
  it("SKIPPED: set REDIS_TEST_URL to execute the real Lua against a real Redis", () => {
    expect(ROOM_CAS_SCRIPT).toContain("KEEPTTL");
  });
}

/** @upstash/redis's reply parsing: JSON when it parses (and a number round-trips), else the raw string. */
function parse(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    const out = JSON.parse(v);
    return typeof out === "number" && out.toString() !== v ? v : out;
  } catch {
    return v;
  }
}
const serialize = (v: unknown) => (typeof v === "string" || typeof v === "number" ? v : JSON.stringify(v));

/** The subset of @upstash/redis that `UpstashRoomBackend` calls, over RESP. */
class RespUpstash {
  constructor(private readonly r: Resp) {}
  async get(k: string) {
    return parse(await this.r.cmd("GET", k));
  }
  async mget(...keys: string[]) {
    // One atomic read, like MGET, returned as one bulk string (the helper client
    // parses scalar replies only). Lua turns a missing key into `false`.
    const raw = (await this.r.cmd(
      "EVAL",
      "return cjson.encode(redis.call('MGET', unpack(KEYS)))",
      keys.length,
      ...keys,
    )) as string;
    return (JSON.parse(raw) as unknown[]).map((v) => (v === false ? null : parse(v)));
  }
  async set(k: string, v: unknown, opts?: { ex?: number; keepTtl?: boolean }) {
    const args: (string | number)[] = ["SET", k, serialize(v)];
    if (opts?.ex) args.push("EX", opts.ex);
    if (opts?.keepTtl) args.push("KEEPTTL");
    return this.r.cmd(...args);
  }
  incr = (k: string) => this.r.cmd("INCR", k);
  incrby = (k: string, by: number) => this.r.cmd("INCRBY", k, by);
  pttl = (k: string) => this.r.cmd("PTTL", k);
  pexpire = (k: string, ms: number) => this.r.cmd("PEXPIRE", k, ms);
  persist = (k: string) => this.r.cmd("PERSIST", k);
  async eval(script: string, keys: string[], args: unknown[]) {
    return parse(await this.r.cmd("EVAL", script, keys.length, ...keys, ...(args as (string | number)[])));
  }
}

maybe("ROOM_CAS_SCRIPT executed by a real Redis", () => {
  let r: Resp;
  const K = "room:t127-lua:meta";
  const cas = (expected: string | number, value: string, keepTtl = "0") =>
    r.cmd("EVAL", ROOM_CAS_SCRIPT, 1, K, String(expected), value, keepTtl);

  beforeAll(async () => {
    r = new Resp();
    await r.connect(REDIS_URL!);
  });
  afterAll(() => r?.end());
  beforeEach(async () => {
    await r.cmd("DEL", K);
  });

  it("writes when the stored revision matches, and stores exactly the given JSON", async () => {
    await r.cmd("SET", K, JSON.stringify({ id: "x", rev: 4 }));
    expect(await cas(4, JSON.stringify({ id: "x", rev: 5, name: "new" }))).toBe(1);
    expect(await r.cmd("GET", K)).toBe(JSON.stringify({ id: "x", rev: 5, name: "new" }));
  });

  it("refuses a stale revision (behind OR ahead) and leaves the value byte-for-byte", async () => {
    const stored = JSON.stringify({ id: "x", rev: 4, name: "kept" });
    await r.cmd("SET", K, stored);
    expect(await cas(3, JSON.stringify({ id: "x", rev: 4, name: "stale" }))).toBe(-1);
    expect(await cas(5, JSON.stringify({ id: "x", rev: 6, name: "ahead" }))).toBe(-1);
    expect(await r.cmd("GET", K)).toBe(stored);
  });

  it("never creates a record (0 on a missing key)", async () => {
    expect(await cas(0, JSON.stringify({ id: "x", rev: 1 }))).toBe(0);
    expect(await r.cmd("EXISTS", K)).toBe(0);
  });

  it("refuses to overwrite a value that is not a JSON object", async () => {
    for (const raw of ["not json", "42", '"a string"']) {
      await r.cmd("SET", K, raw);
      expect([raw, await cas(0, "{}")]).toEqual([raw, -1]);
      expect(await r.cmd("GET", K)).toBe(raw);
    }
  });

  // The Lua normalisation must agree with normaliseRoomRev for every shape, or a
  // room whose stored rev is odd would refuse every write (or accept a stale one).
  it.each([
    ["absent", "{}"],
    ["null", '{"rev":null}'],
    ["true", '{"rev":true}'],
    ["0", '{"rev":0}'],
    ["7", '{"rev":7}'],
    ["negative", '{"rev":-3}'],
    ["fraction", '{"rev":1.5}'],
    ["huge", '{"rev":1e400}'],
    ["numeric string", '{"rev":"7"}'],
    ["padded string", '{"rev":" 7 "}'],
    ["blank string", '{"rev":"  "}'],
    ["junk string", '{"rev":"abc"}'],
    ["object", '{"rev":{"a":1}}'],
  ])("revision %s: the script accepts exactly what normaliseRoomRev reads", async (_label, json) => {
    const jsRev = normaliseRoomRev((JSON.parse(json) as { rev?: unknown }).rev);
    for (const candidate of [0, 1, 7, jsRev]) {
      await r.cmd("SET", K, json);
      const out = await cas(candidate, JSON.stringify({ rev: candidate + 1 }));
      expect([json, candidate, out]).toEqual([json, candidate, candidate === jsRev ? 1 : -1]);
    }
  });

  it("keeps the TTL with ARGV[3]=1 and makes the key permanent with 0, like SET KEEPTTL / SET", async () => {
    await r.cmd("SET", K, JSON.stringify({ rev: 0 }), "PX", 600_000);
    expect(await cas(0, JSON.stringify({ rev: 1 }), "1")).toBe(1);
    const kept = Number(await r.cmd("PTTL", K));
    expect(kept).toBeGreaterThan(500_000);
    expect(await cas(1, JSON.stringify({ rev: 2 }), "0")).toBe(1);
    expect(await r.cmd("PTTL", K)).toBe(-1);
  });
});

maybe("UpstashRoomBackend on a real Redis", () => {
  let r: Resp;
  let be: UpstashRoomBackend;
  const legacy: Room = {
    id: "t127-legacy",
    name: "Bar Legado",
    hostCodeHash: "h".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    settings: { mode: "full-karaoke" },
    claimTokenHashes: ["a".repeat(64)],
    ownerClaimTokenHash: "a".repeat(64),
  };

  beforeAll(async () => {
    r = new Resp();
    await r.connect(REDIS_URL!);
    be = new UpstashRoomBackend(new RespUpstash(r) as unknown as Redis);
  });
  afterAll(() => r?.end());
  beforeEach(async () => {
    await r.cmd("DEL", roomKey(legacy.id), `room:${legacy.id}:session-epoch`);
  });

  it("a legacy record written by the old plain SET reads back unchanged, and its first CAS write stamps rev 1", async () => {
    await r.cmd("SET", roomKey(legacy.id), JSON.stringify(legacy)); // what `redis.set(key, room)` stored
    const read = (await be.get(legacy.id))!;
    expect(read).toEqual(legacy);
    expect(await be.update({ ...read, settings: { ...read.settings, moderation: true } })).toBe("ok");
    expect(await be.get(legacy.id)).toEqual({ ...legacy, settings: { mode: "full-karaoke", moderation: true }, rev: 1 });
  });

  it("two writers from the same read: the first commits, the second is a conflict and changes nothing", async () => {
    await be.create(legacy);
    const a = (await be.get(legacy.id))!;
    const b = (await be.get(legacy.id))!;
    expect(await be.update({ ...a, claimTokenHashes: [...a.claimTokenHashes!, "b".repeat(64)] })).toBe("ok");
    expect(await be.update({ ...b, settings: { ...b.settings, mode: "per-table-2" } })).toBe("conflict");
    const now = (await be.get(legacy.id))!;
    expect(now.claimTokenHashes).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(now.settings.mode).toBe("full-karaoke");
  });

  it("an update of a missing room is `missing` and creates nothing", async () => {
    expect(await be.update(legacy)).toBe("missing");
    expect(await r.cmd("EXISTS", roomKey(legacy.id))).toBe(0);
  });

  it("with retention ON an update keeps the record's TTL", async () => {
    process.env.ROOM_RETENTION_DAYS = "30";
    try {
      await be.create(legacy);
      expect(Number(await r.cmd("PTTL", roomKey(legacy.id)))).toBeGreaterThan(0);
      expect(await be.update((await be.get(legacy.id))!)).toBe("ok");
      expect(Number(await r.cmd("PTTL", roomKey(legacy.id)))).toBeGreaterThan(29 * 86_400_000);
    } finally {
      delete process.env.ROOM_RETENTION_DAYS;
    }
  });
});

maybe("every writer pair, worst order, with the room backend on a real Redis", () => {
  let r: Resp;
  const METHODS = ["get", "create", "update", "count", "bumpSessionEpoch"] as const;
  const original = new Map<string, unknown>();
  beforeAll(async () => {
    r = new Resp();
    await r.connect(REDIS_URL!);
    const be = new UpstashRoomBackend(new RespUpstash(r) as unknown as Redis);
    await r.cmd("FLUSHDB");
    // Point the app's room backend at the real Redis for this block. Plain
    // assignment, not jest.spyOn: the pair harness spies on `update` itself, and
    // jest's restoreMocks would undo a spy here before every test.
    const target = roomBackend as unknown as Record<string, unknown>;
    for (const m of METHODS) {
      original.set(m, target[m]);
      target[m] = (be as unknown as Record<string, (...a: unknown[]) => unknown>)[m].bind(be);
    }
  });
  afterAll(() => {
    const target = roomBackend as unknown as Record<string, unknown>;
    for (const m of METHODS) target[m] = original.get(m);
    r?.end();
  });

  it("the app's room backend really is the Upstash one on Redis", async () => {
    const before = Number(await r.cmd("DBSIZE"));
    await runPair("mint", "mode", "Bar Redis Sonda 127");
    expect(Number(await r.cmd("DBSIZE"))).toBeGreaterThan(before);
  });

  it.each(PAIRS)("stale %s, interleaved %s", (a, b) => runPair(a, b, "Bar Redis 127"));
});
