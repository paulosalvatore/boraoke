/**
 * Daily `search.list` spend counter (TICKET-87) — MEMORY PATH + REDIS EVAL PATH.
 *
 * The load-bearing tests here are the CONCURRENCY ones. A sequential loop that
 * stops at the budget proves almost nothing: a naive client-side
 * GET-then-INCR would pass it too, and would still overspend in production
 * where N serverless instances interleave. So the Redis-path tests run a fake
 * Redis whose `eval` REPRODUCES Redis's actual execution model — each script
 * invocation runs to completion, one at a time, on a shared keyspace, with real
 * async gaps between invocations — and fire the requests CONCURRENTLY.
 *
 * That test is only meaningful if it can fail, so it is NEGATIVE-CONTROLLED:
 * `describe("negative control")` runs the identical concurrent load against a
 * fake that implements the same logic NON-atomically (an await between the read
 * and the write, i.e. exactly the read-modify-write this module refuses to do)
 * and asserts that it DOES overspend. If the atomicity harness were vacuous,
 * that test would fail.
 */
import {
  reserveSearchCall,
  getSearchBudgetUsage,
  pacificDayKey,
  SEARCH_DAILY_CAP,
  SEARCH_DAILY_BUDGET,
  RESERVE_MARGIN,
  RESERVE_SEARCH_SCRIPT,
  _resetSearchBudget,
  _resetBudgetClient,
} from "@/lib/search-budget";

const ORIGINAL_ENV = { ...process.env };

// ─── A fake Upstash client whose `eval` mimics Redis's execution model ────────

interface FakeOpts {
  /** When true, interleave an await between read and write (NON-atomic). */
  nonAtomic?: boolean;
  /** When set, every eval rejects with this error. */
  failWith?: Error;
}

function makeFakeRedis(opts: FakeOpts = {}) {
  const store = new Map<string, number>();
  const ttls = new Map<string, number>();
  const evalCalls: Array<{ script: string; keys: unknown[]; args: unknown[] }> = [];
  // Redis executes one script at a time to completion. We model that with a
  // promise chain so concurrent callers queue rather than interleave.
  let tail: Promise<unknown> = Promise.resolve();

  async function runScript(key: string, budget: number, ttl: number): Promise<number> {
    const used = store.get(key) ?? 0;
    if (opts.nonAtomic) {
      // THE BUG THIS MODULE EXISTS TO PREVENT: yielding between the read and
      // the write lets every concurrent caller observe the same pre-increment
      // value and all pass the budget check.
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
    if (used >= budget) return -1;
    const count = used + 1;
    store.set(key, count);
    if (count === 1) ttls.set(key, ttl);
    return budget - count;
  }

  return {
    _store: store,
    _ttls: ttls,
    _evalCalls: evalCalls,
    async eval(script: string, keys: string[], args: (string | number)[]) {
      evalCalls.push({ script, keys, args });
      if (opts.failWith) throw opts.failWith;
      const key = keys[0];
      const budget = Number(args[0]);
      const ttl = Number(args[1]);
      if (opts.nonAtomic) {
        // No serialization at all — concurrent scripts interleave freely.
        return runScript(key, budget, ttl);
      }
      // Serialized, exactly like Redis's single thread.
      const next = tail.then(() => runScript(key, budget, ttl));
      tail = next.catch(() => undefined);
      return next;
    },
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
  };
}

let fake: ReturnType<typeof makeFakeRedis>;

jest.mock("@upstash/redis", () => ({
  Redis: {
    fromEnv: () => {
      const g = globalThis as unknown as { __fakeRedis?: unknown };
      if (!g.__fakeRedis) throw new Error("no fake configured");
      return g.__fakeRedis;
    },
  },
}));

function installFake(f: ReturnType<typeof makeFakeRedis> | null) {
  (globalThis as unknown as { __fakeRedis?: unknown }).__fakeRedis =
    f ?? undefined;
  _resetBudgetClient();
}

beforeEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  process.env.STORE_DRIVER = "memory";
  installFake(null);
  _resetSearchBudget();
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  installFake(null);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ─── Constants / headroom ────────────────────────────────────────────────────

describe("budget constants", () => {
  it("matches Google's documented 100 search.list calls/day cap", () => {
    expect(SEARCH_DAILY_CAP).toBe(100);
  });

  it("leaves real headroom rather than spending to exactly the cap", () => {
    expect(RESERVE_MARGIN).toBeGreaterThan(0);
    expect(SEARCH_DAILY_BUDGET).toBe(SEARCH_DAILY_CAP - RESERVE_MARGIN);
    expect(SEARCH_DAILY_BUDGET).toBeLessThan(SEARCH_DAILY_CAP);
  });
});

// ─── Day boundary: midnight PACIFIC, DST-aware ───────────────────────────────

describe("pacificDayKey — Google resets at midnight Pacific, not UTC", () => {
  it("is still the PREVIOUS day at 00:30 UTC (17:30 PDT the day before)", () => {
    // 2026-08-20T00:30Z is 2026-08-19 17:30 PDT — Google's day has NOT rolled.
    // A UTC-keyed counter would have reset here and handed out a second budget.
    expect(pacificDayKey(new Date("2026-08-20T00:30:00Z"))).toBe("2026-08-19");
  });

  it("rolls at 07:00 UTC during PDT (UTC-7)", () => {
    expect(pacificDayKey(new Date("2026-08-20T06:59:00Z"))).toBe("2026-08-19");
    expect(pacificDayKey(new Date("2026-08-20T07:00:00Z"))).toBe("2026-08-20");
  });

  it("rolls at 08:00 UTC during PST (UTC-8) — the DST shift is honoured", () => {
    // January = PST. The roll moves an hour later in UTC than the PDT case
    // above, which is precisely what a fixed UTC offset would get wrong.
    expect(pacificDayKey(new Date("2026-01-15T07:59:00Z"))).toBe("2026-01-14");
    expect(pacificDayKey(new Date("2026-01-15T08:00:00Z"))).toBe("2026-01-15");
  });

  it("emits a stable YYYY-MM-DD shape usable as a Redis key", () => {
    expect(pacificDayKey(new Date("2026-03-09T12:00:00Z"))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("cannot be influenced by any caller input (clock-derived only)", () => {
    // The function's ONLY parameter is a Date. There is no string/query/header
    // path into the key, so the counter cannot be split or rotated by a patron.
    expect(reserveSearchCall.length).toBeLessThanOrEqual(1);
    expect(pacificDayKey.length).toBeLessThanOrEqual(1);
  });
});

// ─── Memory path (no Upstash configured: dev / CI / single instance) ─────────

describe("memory path", () => {
  it("allows exactly SEARCH_DAILY_BUDGET reservations then denies", async () => {
    for (let i = 0; i < SEARCH_DAILY_BUDGET; i++) {
      const r = await reserveSearchCall();
      expect(r.ok).toBe(true);
      expect(r.remaining).toBe(SEARCH_DAILY_BUDGET - (i + 1));
    }
    const denied = await reserveSearchCall();
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe("cap");
  });

  it("never exceeds the budget under CONCURRENT load", async () => {
    const attempts = SEARCH_DAILY_BUDGET * 3;
    const results = await Promise.all(
      Array.from({ length: attempts }, () => reserveSearchCall()),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(SEARCH_DAILY_BUDGET);
    // And crucially: never more than Google's real hard cap.
    expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(SEARCH_DAILY_CAP);
  });

  it("resets when the Pacific day rolls over", async () => {
    const day1 = new Date("2026-08-19T18:00:00Z"); // 11:00 PDT
    for (let i = 0; i < SEARCH_DAILY_BUDGET; i++) await reserveSearchCall(day1);
    expect((await reserveSearchCall(day1)).ok).toBe(false);

    const day2 = new Date("2026-08-20T18:00:00Z");
    const fresh = await reserveSearchCall(day2);
    expect(fresh.ok).toBe(true);
    expect(fresh.day).toBe("2026-08-20");
    expect(fresh.remaining).toBe(SEARCH_DAILY_BUDGET - 1);
  });

  it("does NOT roll over at UTC midnight mid-Pacific-day", async () => {
    const evening = new Date("2026-08-19T23:00:00Z"); // 16:00 PDT, day 08-19
    for (let i = 0; i < SEARCH_DAILY_BUDGET; i++) await reserveSearchCall(evening);
    // 00:30 UTC = still 08-19 in Pacific. A UTC-keyed counter resets here.
    const afterUtcMidnight = await reserveSearchCall(
      new Date("2026-08-20T00:30:00Z"),
    );
    expect(afterUtcMidnight.ok).toBe(false);
    expect(afterUtcMidnight.reason).toBe("cap");
  });

  it("reports usage without mutating it", async () => {
    const now = new Date("2026-08-19T18:00:00Z");
    await reserveSearchCall(now);
    await reserveSearchCall(now);
    const a = await getSearchBudgetUsage(now);
    const b = await getSearchBudgetUsage(now);
    expect(a).toEqual({ day: "2026-08-19", used: 2, remaining: SEARCH_DAILY_BUDGET - 2 });
    expect(b).toEqual(a);
  });
});

// ─── Redis path: ONE atomic EVAL ─────────────────────────────────────────────

describe("redis path", () => {
  beforeEach(() => {
    process.env.STORE_DRIVER = "upstash";
    process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
    fake = makeFakeRedis();
    installFake(fake);
  });

  it("reserves with a SINGLE eval — never a client-side GET-then-INCR", async () => {
    const r = await reserveSearchCall(new Date("2026-08-19T18:00:00Z"));
    expect(r.ok).toBe(true);
    expect(fake._evalCalls).toHaveLength(1);
    // The check AND the increment are both inside the script, not in JS.
    expect(RESERVE_SEARCH_SCRIPT).toContain("INCR");
    expect(RESERVE_SEARCH_SCRIPT).toContain("used >= budget");
    // No cjson anywhere — TICKET-63's lossless-round-trip invariant only holds
    // for strings/booleans, so a counter must never go through it.
    expect(RESERVE_SEARCH_SCRIPT).not.toContain("cjson");
  });

  it("keys on the Pacific day and sets a TTL on create only", async () => {
    const now = new Date("2026-08-19T18:00:00Z");
    await reserveSearchCall(now);
    await reserveSearchCall(now);
    expect([...fake._store.keys()]).toEqual(["sb:2026-08-19"]);
    expect(fake._store.get("sb:2026-08-19")).toBe(2);
    // TTL set once, on the create — longer than the longest possible day.
    expect(fake._ttls.get("sb:2026-08-19")).toBeGreaterThan(25 * 60 * 60 * 1000);
  });

  it("ATOMICITY: 300 CONCURRENT reservations grant exactly the budget", async () => {
    const now = new Date("2026-08-19T18:00:00Z");
    const results = await Promise.all(
      Array.from({ length: SEARCH_DAILY_BUDGET * 3 }, () => reserveSearchCall(now)),
    );
    const granted = results.filter((r) => r.ok).length;
    expect(granted).toBe(SEARCH_DAILY_BUDGET);
    expect(granted).toBeLessThan(SEARCH_DAILY_CAP);
    expect(fake._store.get("sb:2026-08-19")).toBe(SEARCH_DAILY_BUDGET);
    // Every denial is a cap denial, and every grant reports a sane remaining.
    for (const r of results) {
      if (r.ok) expect(r.remaining).toBeGreaterThanOrEqual(0);
      else expect(r.reason).toBe("cap");
    }
  });

  it("ATOMICITY: remaining values are unique across concurrent grants", async () => {
    // A read-modify-write hands the SAME remaining value to multiple callers.
    // Under a real atomic INCR every grant gets a distinct slot.
    const now = new Date("2026-08-19T18:00:00Z");
    const results = await Promise.all(
      Array.from({ length: SEARCH_DAILY_BUDGET }, () => reserveSearchCall(now)),
    );
    const remainings = results.filter((r) => r.ok).map((r) => r.remaining);
    expect(new Set(remainings).size).toBe(remainings.length);
    expect(Math.min(...remainings)).toBe(0);
    expect(Math.max(...remainings)).toBe(SEARCH_DAILY_BUDGET - 1);
  });

  it("FAILS CLOSED when the configured Redis is unreachable", async () => {
    fake = makeFakeRedis({ failWith: new Error("ECONNRESET") });
    installFake(fake);
    const r = await reserveSearchCall(new Date("2026-08-19T18:00:00Z"));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("store");
    // Nothing was spent, and the failure is loud in the logs.
    expect(console.warn).toHaveBeenCalled();
  });

  it("FAILS CLOSED for EVERY request while Redis is down (no partial leak)", async () => {
    fake = makeFakeRedis({ failWith: new Error("ETIMEDOUT") });
    installFake(fake);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => reserveSearchCall(new Date("2026-08-19T18:00:00Z"))),
    );
    expect(results.every((r) => !r.ok && r.reason === "store")).toBe(true);
  });

  it("recovers automatically the moment Redis comes back", async () => {
    fake = makeFakeRedis({ failWith: new Error("blip") });
    installFake(fake);
    expect((await reserveSearchCall()).ok).toBe(false);
    fake = makeFakeRedis();
    installFake(fake);
    expect((await reserveSearchCall()).ok).toBe(true);
  });

  it("fails closed when Upstash is selected but the client cannot be built", async () => {
    installFake(null); // Redis.fromEnv() throws
    const r = await reserveSearchCall();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("store");
  });

  it("getSearchBudgetUsage returns null (not a misleading 0) when Redis fails", async () => {
    fake = makeFakeRedis({ failWith: new Error("down") });
    installFake(fake);
    // `get` on this fake still works; force the read to throw instead.
    fake.get = async () => {
      throw new Error("down");
    };
    expect(await getSearchBudgetUsage()).toBeNull();
  });

  it("exposes no refund/decrement API (an error-refund is a free credit)", async () => {
    const mod = await import("@/lib/search-budget");
    const names = Object.keys(mod).join(" ").toLowerCase();
    expect(names).not.toContain("refund");
    expect(names).not.toContain("release");
    expect(RESERVE_SEARCH_SCRIPT).not.toContain("DECR");
  });
});

// ─── NEGATIVE CONTROL: the concurrency harness must be able to fail ──────────

describe("negative control — a NON-atomic counter overspends the same load", () => {
  beforeEach(() => {
    process.env.STORE_DRIVER = "upstash";
    process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
    fake = makeFakeRedis({ nonAtomic: true });
    installFake(fake);
  });

  it("grants MORE than the budget when read and write are not atomic", async () => {
    const now = new Date("2026-08-19T18:00:00Z");
    const results = await Promise.all(
      Array.from({ length: SEARCH_DAILY_BUDGET * 3 }, () => reserveSearchCall(now)),
    );
    const granted = results.filter((r) => r.ok).length;
    // This is the production failure being prevented: every concurrent caller
    // read the same pre-increment value and all passed the check. If this
    // assertion ever fails, the atomicity tests above are vacuous.
    expect(granted).toBeGreaterThan(SEARCH_DAILY_BUDGET);
  });
});
