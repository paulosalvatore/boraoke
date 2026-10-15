/**
 * Single-flight for billed searches (TICKET-126) — the CONCURRENCY PROBE.
 *
 * N concurrent requests for one query, spread across several simulated
 * serverless instances (separate module registries, so separate in-memory L1
 * caches and module state) that share ONE fake Upstash keyspace whose commands
 * interleave with random delays. The property: exactly ONE outbound
 * `search.list` call, every request answered with the same rows, and only the
 * leader charged.
 *
 * NEGATIVE CONTROL: the same probe with the lock disabled (every request told
 * it is "solo", i.e. the pre-TICKET-126 behaviour) must show N calls. If it did
 * not, the harness would not be capable of detecting the bug, and the main
 * assertion would prove nothing.
 */
import type { NextRequest } from "next/server";
import { makeFakeUpstash, type FakeUpstash } from "./helpers/fake-upstash";

jest.mock("@upstash/redis", () => {
  const current = () => {
    const g = globalThis as unknown as { __t126Fake?: unknown };
    if (!g.__t126Fake) throw new Error("no fake configured");
    return g.__t126Fake;
  };
  class Redis {
    constructor() {
      return current() as Redis;
    }
    static fromEnv() {
      return current();
    }
  }
  return { Redis };
});
jest.mock("@/lib/telemetry", () => ({ track: async () => {} }));
jest.mock("@/lib/karaoke-index/store", () => ({ getKaraokeIndex: async () => null }));

type RouteModule = typeof import("@/app/api/search/route");

const INSTANCES = 4;
const REQUESTS = 20;
const ENV = { ...process.env };

let fake: FakeUpstash;
let searchListCalls = 0;
let soloMode = false;
let failUpstream = false;

function uuidN(n: number): string {
  return `123e4567-e89b-42d3-a456-${String(n).padStart(12, "0")}`;
}

/** Load the route N times, each in its own module registry = its own instance. */
function loadInstances(): RouteModule[] {
  const out: RouteModule[] = [];
  for (let i = 0; i < INSTANCES; i++) {
    jest.isolateModules(() => {
      if (soloMode) {
        jest.doMock("@/lib/search-single-flight", () => ({
          ...jest.requireActual("@/lib/search-single-flight"),
          acquireSearchFlight: async () => ({ role: "solo" }),
        }));
      } else {
        jest.dontMock("@/lib/search-single-flight");
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      out.push(require("@/app/api/search/route") as RouteModule);
    });
  }
  return out;
}

function req(n: number, q: string): NextRequest {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest: NR } = require("next/server");
  return new NR(
    `http://127.0.0.1:3126/api/search?q=${encodeURIComponent(q)}&uuid=${uuidN(n)}&v=2&live=1`,
    { headers: { "x-forwarded-for": `198.51.100.${n}` } },
  ) as NextRequest;
}

async function fire(q: string): Promise<Record<string, unknown>[]> {
  const routes = loadInstances();
  const res = await Promise.all(
    Array.from({ length: REQUESTS }, (_, i) => routes[i % INSTANCES].GET(req(i + 1, q))),
  );
  return Promise.all(res.map((r) => r.json() as Promise<Record<string, unknown>>));
}

/** Count of budget counter keys and their values in the fake. */
function counters() {
  const out: Record<string, number> = {};
  for (const [k, e] of fake.store) if (k.startsWith("sb:")) out[k] = Number(e.v);
  return out;
}

beforeEach(() => {
  fake = makeFakeUpstash(126);
  (globalThis as unknown as { __t126Fake?: unknown }).__t126Fake = fake;
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake";
  delete process.env.STORE_DRIVER;
  process.env.YOUTUBE_API_KEY = "test-key";
  searchListCalls = 0;
  soloMode = false;
  failUpstream = false;
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/youtube/v3/search")) {
      searchListCalls++;
      await new Promise((r) => setTimeout(r, 40)); // a real round trip, so requests overlap it
      if (failUpstream) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [{ id: { videoId: "vShared01" }, snippet: { title: "Shared", channelTitle: "c" } }] }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  process.env = { ...ENV };
  (globalThis as unknown as { __t126Fake?: unknown }).__t126Fake = undefined;
  jest.restoreAllMocks();
});

describe("concurrent identical queries across instances", () => {
  it(`${REQUESTS} requests on ${INSTANCES} instances produce ONE billed call`, async () => {
    const bodies = await fire("escurinho do cinema");
    expect(searchListCalls).toBe(1);
    for (const b of bodies) {
      expect(b.degraded).toBeUndefined();
      expect(b.deferred).toBeUndefined();
      expect((b.results as { videoId: string }[]).map((r) => r.videoId)).toEqual(["vShared01"]);
    }
    // Only the leader was charged: platform +1, exactly one IP and one device key at 1.
    const c = counters();
    const platform = Object.entries(c).filter(([k]) => !k.includes(":ip:") && !k.includes(":dev:"));
    expect(platform.map(([, v]) => v)).toEqual([1]);
    expect(Object.entries(c).filter(([k]) => k.includes(":ip:")).map(([, v]) => v)).toEqual([1]);
    expect(Object.entries(c).filter(([k]) => k.includes(":dev:")).map(([, v]) => v)).toEqual([1]);
    // The lock is released.
    expect([...fake.store.keys()].filter((k) => k.startsWith("sf:"))).toEqual([]);
  });

  it("holds across 8 different interleavings (seeds), not one lucky schedule", async () => {
    const perSeed: number[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      fake = makeFakeUpstash(seed, 8);
      (globalThis as unknown as { __t126Fake?: unknown }).__t126Fake = fake;
      searchListCalls = 0;
      await fire(`seeded query ${seed}`);
      perSeed.push(searchListCalls);
    }
    expect(perSeed).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("NEGATIVE CONTROL: with the lock disabled the same probe bills every request", async () => {
    soloMode = true;
    await fire("escurinho do cinema");
    expect(searchListCalls).toBeGreaterThan(1);
    expect(searchListCalls).toBe(REQUESTS);
  });

  it("an upstream failure costs ONE call and every waiter degrades instead of retrying", async () => {
    failUpstream = true;
    const bodies = await fire("borbulhas de amor");
    expect(searchListCalls).toBe(1);
    for (const b of bodies) expect(b).toMatchObject({ degraded: true, results: [] });
  });

  it("different queries are not serialised behind each other", async () => {
    const routes = loadInstances();
    const res = await Promise.all(
      Array.from({ length: 6 }, (_, i) => routes[i % INSTANCES].GET(req(i + 1, `distinct query ${i}`))),
    );
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(searchListCalls).toBe(6);
  });
});

describe("module protocol (Redis path)", () => {
  async function mod() {
    let m!: typeof import("@/lib/search-single-flight");
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      m = require("@/lib/search-single-flight");
    });
    return m;
  }

  it("a leader that abandons (e.g. denied a reservation) leaves the flight VACANT", async () => {
    const m = await mod();
    const leader = await m.acquireSearchFlight("k1");
    expect(leader.role).toBe("leader");
    expect((await m.acquireSearchFlight("k1")).role).toBe("waiter");
    const waiting = m.waitForSearchFlight("k1", { pollMs: 5, deadlineMs: 2000 });
    if (leader.role === "leader") await leader.release("abandoned");
    expect(await waiting).toEqual({ kind: "vacant" });
    expect((await m.acquireSearchFlight("k1")).role).toBe("leader");
  });

  it("a waiter whose leader never answers times out (and the route defers, not bills)", async () => {
    const m = await mod();
    await m.acquireSearchFlight("k2");
    expect(await m.waitForSearchFlight("k2", { pollMs: 5, deadlineMs: 60 })).toEqual({ kind: "timeout" });
  });

  it("acquire FAILS OPEN to 'solo' when the store errors", async () => {
    const m = await mod();
    fake.set = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect((await m.acquireSearchFlight("k3")).role).toBe("solo");
  });

  it("a lock for query X:err is never read as query X's error marker (key namespaces cannot collide)", async () => {
    const m = await mod();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { cacheKey } = require("@/lib/youtube-search") as typeof import("@/lib/youtube-search");
    const plain = cacheKey("abc", "BR");
    const suffixed = cacheKey("abc:err", "BR");
    // Key level: no lock key equals any error-marker key, in either direction.
    expect(m.lockKey(suffixed)).not.toBe(m.errKey(plain));
    expect(m.errKey(suffixed)).not.toBe(m.lockKey(plain));
    // Behaviour level: someone leads a flight for "abc:err" while "abc" has a
    // leader that abandons; the "abc" waiter must see VACANT, not "failed".
    const other = await m.acquireSearchFlight(suffixed);
    expect(other.role).toBe("leader");
    const leader = await m.acquireSearchFlight(plain);
    expect(leader.role).toBe("leader");
    const waiting = m.waitForSearchFlight(plain, { pollMs: 5, deadlineMs: 2000 });
    if (leader.role === "leader") await leader.release("abandoned");
    expect(await waiting).toEqual({ kind: "vacant" });
    // And a failed "abc" leader does not block "abc:err" from leading.
    if (other.role === "leader") await other.release("abandoned");
    const failing = await m.acquireSearchFlight(plain);
    if (failing.role === "leader") await failing.release("failed");
    expect((await m.acquireSearchFlight(suffixed)).role).toBe("leader");
  });

  it("a waiter that cannot read the store defers rather than bills", async () => {
    const m = await mod();
    await m.acquireSearchFlight("k4");
    fake.mget = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await m.waitForSearchFlight("k4", { pollMs: 5, deadlineMs: 500 })).toEqual({ kind: "timeout" });
  });
});

describe("module protocol (in-process path, no Upstash)", () => {
  beforeEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    process.env.STORE_DRIVER = "memory";
  });

  it("serialises concurrent identical misses within one process to one call", async () => {
    let route!: RouteModule;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      route = require("@/app/api/search/route");
    });
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => route.GET(req(i + 1, "zé ramalho"))));
    const bodies = await Promise.all(res.map((r) => r.json()));
    expect(searchListCalls).toBe(1);
    for (const b of bodies) expect((b.results as { videoId: string }[])[0].videoId).toBe("vShared01");
  });
});
