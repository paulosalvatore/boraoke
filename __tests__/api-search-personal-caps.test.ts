/**
 * GET /api/search × the per-device and per-IP daily sub-budgets (TICKET-126).
 *
 * Asserted against OUTBOUND search.list counts, like api-search-budget.test.ts:
 * the property is "one person cannot spend more than their share of the
 * platform's day", and "a capped person still gets everything free".
 *
 * The velocity limiter (per-uuid 5/10s, per-IP 30/10s) would trip long before a
 * daily cap in a tight loop, so it is reset between calls — this suite tests the
 * DAILY share, which must hold once the velocity window is bypassed by waiting.
 */
import type { NextRequest } from "next/server";

import { KaraokeIndex } from "@/lib/karaoke-index/matcher";
import type { ChannelShard } from "@/lib/karaoke-index/types";

let mockIndex: KaraokeIndex | null = null;
jest.mock("@/lib/karaoke-index/store", () => ({
  getKaraokeIndex: async () => mockIndex,
}));
// The per-uuid live cooldown is covered by live-search-gate.test.ts.
jest.mock("@/lib/live-search-gate", () => ({
  ...jest.requireActual("@/lib/live-search-gate"),
  liveCooldown: () => ({ ok: true }),
}));

import { GET } from "@/app/api/search/route";
import { _resetCache, _resetRateLimit } from "@/lib/youtube-search";
import {
  _resetSearchBudget,
  DEFAULT_DEVICE_DAILY_CAP,
  DEFAULT_IP_DAILY_CAP,
  SEARCH_DAILY_BUDGET,
  deviceDailyCap,
  ipDailyCap,
  parseCapOverride,
} from "@/lib/search-budget";
import { IDENTITY_COOKIE } from "@/lib/identity";

const SHARD: ChannelShard = {
  v: 1,
  channelId: "UC0000000000000000000001",
  channelTitle: "Karaokê Club",
  harvestedAt: Date.now(),
  rows: [["vEvidencia1", "Evidências - Chitãozinho e Xororó (Karaokê)", "4:30"]],
};

function uuidN(n: number): string {
  return `123e4567-e89b-42d3-a456-${String(n).padStart(12, "0")}`;
}

let qn = 0;
/** A fresh query each call so the cache never masks an outbound call. */
function freshQ(): string {
  qn++;
  return `song number ${qn}`;
}

function req(opts: { q?: string; uuid: string; ip: string; cookie?: string }): NextRequest {
  const q = opts.q ?? freshQ();
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip };
  if (opts.cookie) headers.cookie = `${IDENTITY_COOKIE}=${opts.cookie}`;
  const url = `http://127.0.0.1:3126/api/search?q=${encodeURIComponent(q)}&uuid=${opts.uuid}&v=2&live=1`;
  // NextRequest is needed for `req.cookies`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NextRequest: NR } = require("next/server");
  return new NR(url, { headers }) as NextRequest;
}

async function search(opts: Parameters<typeof req>[0]): Promise<Record<string, unknown>> {
  _resetRateLimit(); // isolate the DAILY share from the 10s velocity window
  const res = await GET(req(opts));
  return (await res.json()) as Record<string, unknown>;
}

let searchListCalls = 0;
const ENV = { ...process.env };

beforeEach(() => {
  _resetCache();
  _resetRateLimit();
  _resetSearchBudget();
  mockIndex = new KaraokeIndex([SHARD]);
  searchListCalls = 0;
  process.env.STORE_DRIVER = "memory";
  process.env.YOUTUBE_API_KEY = "test-key";
  delete process.env.SEARCH_DEVICE_DAILY_CAP;
  delete process.env.SEARCH_IP_DAILY_CAP;
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/youtube/v3/search")
      ? (searchListCalls++, { items: [{ id: { videoId: "vid1" }, snippet: { title: "t", channelTitle: "c" } }] })
      : { items: [] };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

describe("per-device daily sub-budget", () => {
  it(`stops one device at ${DEFAULT_DEVICE_DAILY_CAP} billed calls, however many IPs it uses`, async () => {
    const uuid = uuidN(1);
    for (let i = 0; i < DEFAULT_DEVICE_DAILY_CAP; i++) {
      const body = await search({ uuid, ip: `198.51.100.${i + 1}` });
      expect(body.degraded).toBeUndefined();
    }
    const denied = await search({ uuid, ip: "198.51.100.200" });
    expect(denied).toEqual({ degraded: true, reason: "personal-limit", results: [] });
    expect(searchListCalls).toBe(DEFAULT_DEVICE_DAILY_CAP);
  });

  it("keys on the identity cookie when present, so rotating the uuid param does not reset it", async () => {
    const cookie = uuidN(900);
    for (let i = 0; i < DEFAULT_DEVICE_DAILY_CAP; i++) {
      await search({ uuid: uuidN(100 + i), ip: `198.51.100.${i + 1}`, cookie });
    }
    const denied = await search({ uuid: uuidN(199), ip: "198.51.100.250", cookie });
    expect(denied.reason).toBe("personal-limit");
    expect(searchListCalls).toBe(DEFAULT_DEVICE_DAILY_CAP);
  });

  it("a capped device still gets CACHED answers free", async () => {
    const uuid = uuidN(2);
    const shared = "evidencias ao vivo";
    await search({ uuid: uuidN(3), ip: "203.0.113.3", q: shared }); // someone else warms the cache
    for (let i = 0; i < DEFAULT_DEVICE_DAILY_CAP; i++) await search({ uuid, ip: `198.51.100.${i + 1}` });
    expect((await search({ uuid, ip: "198.51.100.99" })).reason).toBe("personal-limit");
    const before = searchListCalls;
    const hit = await search({ uuid, ip: "198.51.100.99", q: shared });
    expect(hit.cached).toBe(true);
    expect(Array.isArray(hit.results) && hit.results.length).toBe(1);
    expect(searchListCalls).toBe(before);
  });

  it("a capped device still gets KARAOKE-INDEX answers free", async () => {
    const uuid = uuidN(4);
    for (let i = 0; i < DEFAULT_DEVICE_DAILY_CAP; i++) await search({ uuid, ip: `198.51.100.${i + 1}` });
    expect((await search({ uuid, ip: "198.51.100.99" })).reason).toBe("personal-limit");
    const before = searchListCalls;
    const idx = await search({ uuid, ip: "198.51.100.99", q: "evidencias karaoke" });
    expect(idx.source).toBe("index");
    expect(searchListCalls).toBe(before);
  });
});

describe("default caps (TL 2026-10-15: generous, only stop one abuser)", () => {
  it("defaults to 30 per device and 90 per network (= the platform budget)", () => {
    expect(DEFAULT_DEVICE_DAILY_CAP).toBe(30);
    expect(DEFAULT_IP_DAILY_CAP).toBe(90);
    expect(DEFAULT_IP_DAILY_CAP).toBe(SEARCH_DAILY_BUDGET);
    expect(deviceDailyCap()).toBe(30);
    expect(ipDailyCap()).toBe(90);
  });

  it("loads the overrides when set, and clamps them to the platform budget", () => {
    process.env.SEARCH_DEVICE_DAILY_CAP = "12";
    process.env.SEARCH_IP_DAILY_CAP = "500";
    expect(deviceDailyCap()).toBe(12);
    expect(ipDailyCap()).toBe(SEARCH_DAILY_BUDGET);
  });

  it("with default caps one network never hits a personal limit before the platform day runs out", async () => {
    const ip = "203.0.113.60";
    for (let i = 0; i < SEARCH_DAILY_BUDGET; i++) {
      const body = await search({ uuid: uuidN(1500 + i), ip });
      expect(body.degraded).toBeUndefined();
    }
    expect(searchListCalls).toBe(SEARCH_DAILY_BUDGET);
    expect((await search({ uuid: uuidN(1599), ip })).reason).toBe("daily-limit");
  });
});

describe("per-IP daily sub-budget", () => {
  it("stops one network at its cap across many devices", async () => {
    process.env.SEARCH_IP_DAILY_CAP = "5";
    const ip = "203.0.113.50";
    for (let i = 0; i < 5; i++) {
      const body = await search({ uuid: uuidN(1000 + i), ip });
      expect(body.degraded).toBeUndefined();
    }
    const denied = await search({ uuid: uuidN(1999), ip });
    expect(denied).toEqual({ degraded: true, reason: "personal-limit", results: [] });
    expect(searchListCalls).toBe(5);
    // Another network is unaffected.
    expect((await search({ uuid: uuidN(2000), ip: "203.0.113.51" })).degraded).toBeUndefined();
  });

  it("keys an IPv6 subscriber by /64, so rotating within it does not reset the cap", async () => {
    process.env.SEARCH_IP_DAILY_CAP = "3";
    for (let i = 0; i < 3; i++) await search({ uuid: uuidN(3000 + i), ip: `2001:db8:1:2::${i + 1}` });
    expect((await search({ uuid: uuidN(3999), ip: "2001:db8:1:2:aaaa::9" })).reason).toBe("personal-limit");
    expect(searchListCalls).toBe(3);
  });
});

describe("a denial charges nobody", () => {
  it("personal denials do not consume the platform budget", async () => {
    process.env.SEARCH_DEVICE_DAILY_CAP = "2";
    const uuid = uuidN(5);
    await search({ uuid, ip: "198.51.100.1" });
    await search({ uuid, ip: "198.51.100.2" });
    for (let i = 0; i < 20; i++) {
      expect((await search({ uuid, ip: `198.51.100.${10 + i}` })).reason).toBe("personal-limit");
    }
    // Drain the rest of the day with fresh devices on fresh networks.
    let n = 0;
    for (;;) {
      const body = await search({ uuid: uuidN(5000 + n), ip: `10.${Math.floor(n / 250)}.${n % 250}.1` });
      n++;
      if (body.degraded) {
        expect(body.reason).toBe("daily-limit");
        break;
      }
      if (n > 200) throw new Error("platform budget never ran out");
    }
    expect(searchListCalls).toBe(SEARCH_DAILY_BUDGET);
  });

  it("reports a drained PLATFORM as daily-limit even to a capped person", async () => {
    process.env.SEARCH_DEVICE_DAILY_CAP = "1";
    const uuid = uuidN(6);
    await search({ uuid, ip: "198.51.100.1" });
    for (let n = 0; n < SEARCH_DAILY_BUDGET - 1; n++) {
      await search({ uuid: uuidN(6000 + n), ip: `10.${Math.floor(n / 250)}.${n % 250}.2` });
    }
    expect((await search({ uuid, ip: "198.51.100.1" })).reason).toBe("daily-limit");
  });
});

describe("env overrides", () => {
  it("honours a positive integer override", async () => {
    process.env.SEARCH_DEVICE_DAILY_CAP = "3";
    const uuid = uuidN(7);
    for (let i = 0; i < 3; i++) await search({ uuid, ip: `198.51.100.${i + 1}` });
    expect((await search({ uuid, ip: "198.51.100.9" })).reason).toBe("personal-limit");
    expect(searchListCalls).toBe(3);
  });

  it.each(["abc", "0", "-5", "2.5", " "])("ignores a malformed override %j (default applies)", async (bad) => {
    process.env.SEARCH_DEVICE_DAILY_CAP = bad;
    const uuid = uuidN(8);
    for (let i = 0; i < DEFAULT_DEVICE_DAILY_CAP; i++) await search({ uuid, ip: `198.51.100.${i + 1}` });
    expect((await search({ uuid, ip: "198.51.100.99" })).reason).toBe("personal-limit");
    expect(searchListCalls).toBe(DEFAULT_DEVICE_DAILY_CAP);
  });

  it("clamps an override above the platform budget to the budget", () => {
    expect(parseCapOverride("100000", 30, "X")).toBe(SEARCH_DAILY_BUDGET);
    expect(parseCapOverride(String(SEARCH_DAILY_BUDGET), 30, "X")).toBe(SEARCH_DAILY_BUDGET);
    expect(parseCapOverride("12", 30, "X")).toBe(12);
    expect(parseCapOverride(undefined, 30, "X")).toBe(30);
  });
});
