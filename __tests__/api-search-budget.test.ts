/**
 * GET /api/search × the daily spend counter (TICKET-87).
 *
 * These tests are about the ROUTE's contract, and they assert against OUTBOUND
 * CALL COUNTS rather than trusting the implementation: the whole ticket is
 * "Google must not receive more than the budgeted number of `search.list`
 * requests per Pacific day, no matter how the requests arrive".
 *
 * Note the reset ordering: `_resetSearchBudget()` runs per-test, but the
 * per-uuid/per-IP window limiter is deliberately left in place — several tests
 * below rotate uuids/IPs precisely because a single caller would trip that
 * limiter first, and this counter must hold the line once it is bypassed.
 */
import { GET } from "@/app/api/search/route";
import { _resetCache, _resetRateLimit } from "@/lib/youtube-search";
import {
  _resetSearchBudget,
  SEARCH_DAILY_BUDGET,
  SEARCH_DAILY_CAP,
} from "@/lib/search-budget";
import type { NextRequest } from "next/server";

/**
 * A stand-in Upstash client that fails EVERY command — used only by the
 * fail-closed test below. The rest of this file runs on the memory driver, so
 * this mock is inert there.
 */
jest.mock("@upstash/redis", () => {
  const failing = {
    eval: async () => {
      throw new Error("ECONNREFUSED");
    },
    get: async () => {
      throw new Error("ECONNREFUSED");
    },
    set: async () => {
      throw new Error("ECONNREFUSED");
    },
    zadd: async () => {
      throw new Error("ECONNREFUSED");
    },
    incr: async () => {
      throw new Error("ECONNREFUSED");
    },
  };
  class FakeRedis {
    constructor() {
      return failing as unknown as FakeRedis;
    }
    static fromEnv() {
      return failing;
    }
  }
  return { Redis: FakeRedis };
});

const KEY_BACKUP = process.env.YOUTUBE_API_KEY;

function testUuid(n: number): string {
  return `123e4567-e89b-42d3-a456-${String(n).padStart(12, "0")}`;
}

/** Unique query per call so the result cache never masks a real outbound call. */
function makeReq(q: string, n: number): NextRequest {
  const url = `http://127.0.0.1:3194/api/search?q=${encodeURIComponent(q)}&uuid=${testUuid(n)}`;
  // A distinct IP per caller: the per-IP window (30/10s) would otherwise trip
  // first and we would be testing the wrong limiter.
  return new Request(url, {
    headers: { "x-forwarded-for": `203.0.113.${n % 250}` },
  }) as unknown as NextRequest;
}

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** Count only `search.list` hits — videos.list bills a different, ample pool. */
let searchListCalls = 0;

beforeEach(() => {
  _resetCache();
  _resetRateLimit();
  _resetSearchBudget();
  searchListCalls = 0;
  process.env.STORE_DRIVER = "memory";
  process.env.YOUTUBE_API_KEY = "test-key";
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/youtube/v3/search")) {
      searchListCalls += 1;
      return okJson({ items: [{ id: { videoId: "vid1" }, snippet: { title: "t" } }] });
    }
    return okJson({ items: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  if (KEY_BACKUP === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = KEY_BACKUP;
});

describe("the daily ceiling actually bounds outbound search.list calls", () => {
  it("issues at most SEARCH_DAILY_BUDGET calls over a long sequential drain", async () => {
    const attempts = SEARCH_DAILY_BUDGET * 2;
    for (let i = 0; i < attempts; i++) {
      await GET(makeReq(`unique query ${i}`, i));
    }
    expect(searchListCalls).toBe(SEARCH_DAILY_BUDGET);
    // The point of the whole ticket: Google's hard cap is never reached.
    expect(searchListCalls).toBeLessThan(SEARCH_DAILY_CAP);
  });

  it("issues at most SEARCH_DAILY_BUDGET calls under CONCURRENT load", async () => {
    // The DoS shape from the ticket: many distinct callers firing at once, each
    // with a distinct query so the cache cannot absorb them. A check-then-
    // increment would let this burst sail past the budget.
    const attempts = SEARCH_DAILY_BUDGET * 2;
    await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        GET(makeReq(`concurrent query ${i}`, i)),
      ),
    );
    expect(searchListCalls).toBe(SEARCH_DAILY_BUDGET);
    expect(searchListCalls).toBeLessThan(SEARCH_DAILY_CAP);
  });

  it("degrades honestly at cap: 200 + degraded + daily-limit + empty results", async () => {
    for (let i = 0; i < SEARCH_DAILY_BUDGET; i++) {
      await GET(makeReq(`drain ${i}`, i));
    }
    const res = await GET(makeReq("one more song", 900));
    expect(res.status).toBe(200); // never a 5xx, never a hang
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.reason).toBe("daily-limit");
    expect(body.results).toEqual([]);
    // No further outbound spend once capped.
    expect(searchListCalls).toBe(SEARCH_DAILY_BUDGET);
  });

  it("never leaks how much budget remains (that would map the drain for an attacker)", async () => {
    await GET(makeReq("first search", 1));
    const capped = await GET(makeReq("second search", 2));
    const body = await capped.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/remaining/i);
    expect(serialized).not.toMatch(/budget/i);
    expect(serialized).not.toMatch(/\bused\b/i);
  });
});

describe("what still works once the budget is spent", () => {
  it("CACHED queries keep being served — a cache hit spends no call", async () => {
    // Warm one query, then drain the rest of the budget on other queries.
    await GET(makeReq("cached favourite", 1));
    for (let i = 1; i < SEARCH_DAILY_BUDGET; i++) {
      await GET(makeReq(`drain ${i}`, i + 10));
    }
    expect(searchListCalls).toBe(SEARCH_DAILY_BUDGET);

    // The warmed query still returns real results after the cap.
    const res = await GET(makeReq("cached favourite", 700));
    const body = await res.json();
    expect(body.degraded).toBeUndefined();
    expect(body.cached).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    expect(searchListCalls).toBe(SEARCH_DAILY_BUDGET); // still no extra spend
  });

  it("the budget gate sits AFTER the cache read, so hits never consume budget", async () => {
    for (let i = 0; i < 5; i++) await GET(makeReq("same query", 1 + i));
    // Five identical requests, one outbound call — so four of them cost nothing
    // and, critically, did not reserve four slots of the day's budget.
    expect(searchListCalls).toBe(1);
    const res = await GET(makeReq("same query", 99));
    expect((await res.json()).degraded).toBeUndefined();
  });
});

describe("the existing per-uuid / per-IP limiter is NOT weakened", () => {
  it("still 429s a single uuid past its window (before any budget is touched)", async () => {
    const uuid = testUuid(42);
    const req = (q: string) =>
      new Request(
        `http://127.0.0.1:3194/api/search?q=${encodeURIComponent(q)}&uuid=${uuid}`,
        { headers: { "x-forwarded-for": "198.51.100.9" } },
      ) as unknown as NextRequest;

    let sawRateLimit = false;
    for (let i = 0; i < 12; i++) {
      const res = await GET(req(`burst ${i}`));
      if (res.status === 429) sawRateLimit = true;
    }
    expect(sawRateLimit).toBe(true);
    // The velocity limiter rejected BEFORE the outbound call, so it also
    // protected the daily budget rather than spending it.
    expect(searchListCalls).toBeLessThan(12);
  });

  it("a 429 does not consume daily budget", async () => {
    const uuid = testUuid(43);
    const req = (q: string) =>
      new Request(
        `http://127.0.0.1:3194/api/search?q=${encodeURIComponent(q)}&uuid=${uuid}`,
        { headers: { "x-forwarded-for": "198.51.100.10" } },
      ) as unknown as NextRequest;
    for (let i = 0; i < 20; i++) await GET(req(`rl ${i}`));
    const spentByRateLimitedBurst = searchListCalls;
    // Only the pre-limit requests spent anything; the rest never reached the
    // reservation at all.
    expect(spentByRateLimitedBurst).toBeLessThanOrEqual(6);
  });
});

describe("counter cannot be poisoned by attacker-controlled input", () => {
  it("a hostile query/uuid does not change which day is charged", async () => {
    // Everything a patron controls (q, uuid, pageToken, headers) is downstream
    // of the counter key, which is derived only from the server clock. Draining
    // with adversarial-looking inputs still lands on ONE budget.
    const nasty = [
      "'; FLUSHALL; --",
      "sb:1999-01-01",
      "../../sb:2000-01-01",
      "%00%0aINCR",
    ];
    for (let round = 0; round < 30; round++) {
      for (const q of nasty) {
        await GET(makeReq(`${q} ${round}`, round * 4));
      }
    }
    // 120 attempts, still exactly one budget's worth of outbound calls.
    expect(searchListCalls).toBe(SEARCH_DAILY_BUDGET);
  });
});

describe("Redis-unreachable behaviour is FAIL-CLOSED", () => {
  it("denies every search (and spends nothing) when a configured Redis errors", async () => {
    // Upstash is fully CONFIGURED here (both creds present, so the unrelated
    // telemetry store constructs fine) but every command it issues fails — the
    // realistic outage shape. The route must deny rather than treat an
    // unreadable counter as "no limit".
    process.env.STORE_DRIVER = "upstash";
    process.env.UPSTASH_REDIS_REST_URL = "https://unreachable.invalid";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    jest.resetModules();
    const { GET: FreshGET } = await import("@/app/api/search/route");

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => FreshGET(makeReq(`outage ${i}`, i))),
    );
    for (const res of results) {
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.degraded).toBe(true);
      expect(body.reason).toBe("daily-limit");
    }
    // Not one unaccounted call escaped to Google during the outage.
    expect(searchListCalls).toBe(0);

    process.env.STORE_DRIVER = "memory";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    jest.resetModules();
  });

  it("uses the SAME opaque reason as a real cap (no infrastructure probing)", async () => {
    // A caller must not be able to distinguish "our Redis is down" from
    // "today's budget is spent" by reading the response body.
    for (let i = 0; i < SEARCH_DAILY_BUDGET; i++) await GET(makeReq(`d ${i}`, i));
    const capBody = await (await GET(makeReq("capped", 800))).json();
    expect(capBody).toEqual({ degraded: true, reason: "daily-limit", results: [] });
  });
});
