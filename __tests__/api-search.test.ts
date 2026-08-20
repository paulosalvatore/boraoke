/**
 * Tests for GET /api/search — validation (query + uuid shape), degraded (no-key)
 * mode, quota → degraded, dual uuid/IP rate limiting, caching. The global fetch
 * is stubbed; the live Data API is never hit.
 */
import { GET } from "@/app/api/search/route";
import { _resetCache, _resetRateLimit, RATE_LIMIT } from "@/lib/youtube-search";
import { _resetSearchBudget } from "@/lib/search-budget";
import type { NextRequest } from "next/server";

const KEY_BACKUP = process.env.YOUTUBE_API_KEY;

/** Deterministic UUID-shaped ids for tests (uuid param must be UUID-shaped). */
function testUuid(n: number): string {
  const hex = String(n).padStart(12, "0");
  return `123e4567-e89b-42d3-a456-${hex}`;
}

function makeReq(
  q: string,
  uuid = testUuid(0),
  headers: Record<string, string> = {},
): NextRequest {
  const url = `http://127.0.0.1:3040/api/search?q=${encodeURIComponent(q)}&uuid=${encodeURIComponent(uuid)}`;
  return new Request(url, { headers }) as unknown as NextRequest;
}

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function errJson(status: number, body: unknown): Response {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  _resetCache();
  _resetRateLimit();
  // TICKET-87: the daily search budget is module-level state shared by every
  // test in this file. Without this reset the ~dozens of live-path searches
  // below would accumulate against one day's 90 and the later ones would
  // degrade for the wrong reason.
  _resetSearchBudget();
  delete process.env.YOUTUBE_API_KEY;
});
afterAll(() => {
  if (KEY_BACKUP === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = KEY_BACKUP;
});

describe("query validation", () => {
  it("400s on a query shorter than 3 chars", async () => {
    const res = await GET(makeReq("ab", testUuid(1)));
    expect(res.status).toBe(400);
  });

  it("400s on an over-long query", async () => {
    const res = await GET(makeReq("x".repeat(101), testUuid(1)));
    expect(res.status).toBe(400);
  });
});

describe("uuid validation (LOW #3 — uuid is a rate-limit map key)", () => {
  it("400s an oversized uuid param", async () => {
    const res = await GET(makeReq("evidencias", "a".repeat(500)));
    expect(res.status).toBe(400);
  });

  it("400s a non-UUID-shaped uuid", async () => {
    const res = await GET(makeReq("evidencias", "not-a-uuid"));
    expect(res.status).toBe(400);
  });

  it("accepts a well-formed UUID", async () => {
    const res = await GET(makeReq("evidencias", testUuid(2)));
    expect(res.status).toBe(200);
  });

  it("accepts the literal 'anon' (pre-boot client) and an absent uuid", async () => {
    const anon = await GET(makeReq("evidencias", "anon"));
    expect(anon.status).toBe(200);
    const absent = await GET(
      new Request("http://127.0.0.1:3040/api/search?q=evidencias") as unknown as NextRequest,
    );
    expect(absent.status).toBe(200);
  });
});

describe("rate limiting (dual uuid + IP buckets)", () => {
  it(`rejects the ${RATE_LIMIT.max + 1}th rapid request per uuid with 429`, async () => {
    for (let i = 0; i < RATE_LIMIT.max; i++) {
      const ok = await GET(makeReq("evidencias", testUuid(10)));
      expect(ok.status).toBe(200); // degraded (no key) but allowed
    }
    const blocked = await GET(makeReq("evidencias", testUuid(10)));
    expect(blocked.status).toBe(429);
  });

  it("keeps buckets separate per uuid", async () => {
    for (let i = 0; i < RATE_LIMIT.max; i++) await GET(makeReq("evidencias", testUuid(11)));
    const other = await GET(makeReq("evidencias", testUuid(12)));
    expect(other.status).toBe(200);
  });

  it("caps rotating uuids from a single IP via x-forwarded-for (MEDIUM #1)", async () => {
    const headers = { "x-forwarded-for": "203.0.113.7, 10.0.0.1" };
    // Every request uses a FRESH uuid — only the IP bucket can stop this.
    for (let i = 0; i < RATE_LIMIT.ipMax; i++) {
      const res = await GET(makeReq("evidencias", testUuid(100 + i), headers));
      expect(res.status).toBe(200);
    }
    const blocked = await GET(makeReq("evidencias", testUuid(999), headers));
    expect(blocked.status).toBe(429);
    // A different client IP is unaffected.
    const otherIp = await GET(
      makeReq("evidencias", testUuid(998), { "x-forwarded-for": "198.51.100.9" }),
    );
    expect(otherIp.status).toBe(200);
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    const headers = { "x-real-ip": "192.0.2.55" };
    for (let i = 0; i < RATE_LIMIT.ipMax; i++) {
      await GET(makeReq("evidencias", testUuid(200 + i), headers));
    }
    const blocked = await GET(makeReq("evidencias", testUuid(997), headers));
    expect(blocked.status).toBe(429);
  });
});

describe("with a key (fetch stubbed)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("returns mapped results on success and caches them", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    let calls = 0;
    global.fetch = (async (url: string) => {
      calls++;
      if (url.includes("/search")) {
        return okJson({
          items: [{ id: { videoId: "aaaaaaaaaaa" }, snippet: { title: "Evidências", channelTitle: "Chitãozinho", thumbnails: { medium: { url: "u" } } } }],
        });
      }
      return okJson({ items: [{ id: "aaaaaaaaaaa", contentDetails: { duration: "PT4M13S" } }] });
    }) as unknown as typeof fetch;

    const res = await GET(makeReq("evidencias", testUuid(3)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ videoId: "aaaaaaaaaaa", title: "Evidências", duration: "4:13" });
    const callsAfterFirst = calls;

    // Second identical query for a different uuid → served from cache (no new fetch).
    const res2 = await GET(makeReq("evidencias", testUuid(4)));
    const body2 = await res2.json();
    expect(body2.cached).toBe(true);
    expect(calls).toBe(callsAfterFirst);
  });

  it("maps a Google quota error to degraded:quota", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    global.fetch = (async () =>
      errJson(403, { error: { errors: [{ reason: "quotaExceeded" }] } })) as unknown as typeof fetch;
    const res = await GET(makeReq("evidencias", testUuid(5)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.reason).toBe("quota");
  });

  it("maps other upstream errors to degraded:error (never 500)", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    global.fetch = (async () => errJson(500, {})) as unknown as typeof fetch;
    const res = await GET(makeReq("evidencias", testUuid(6)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.reason).toBe("error");
  });
});
