/**
 * Tests for GET /api/search — validation, degraded (no-key) mode, quota → degraded,
 * rate limiting, caching. The global fetch is stubbed; the live Data API is never hit.
 */
import { GET } from "@/app/api/search/route";
import { _resetCache, _resetRateLimit, RATE_LIMIT } from "@/lib/youtube-search";
import type { NextRequest } from "next/server";

const KEY_BACKUP = process.env.YOUTUBE_API_KEY;

function makeReq(q: string, uuid = "u-default"): NextRequest {
  const url = `http://127.0.0.1:3040/api/search?q=${encodeURIComponent(q)}&uuid=${uuid}`;
  return new Request(url) as unknown as NextRequest;
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
  delete process.env.YOUTUBE_API_KEY;
});
afterAll(() => {
  if (KEY_BACKUP === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = KEY_BACKUP;
});

describe("query validation", () => {
  it("400s on a query shorter than 3 chars", async () => {
    const res = await GET(makeReq("ab", "u1"));
    expect(res.status).toBe(400);
  });

  it("400s on an over-long query", async () => {
    const res = await GET(makeReq("x".repeat(101), "u1"));
    expect(res.status).toBe(400);
  });
});

describe("degraded mode (no API key)", () => {
  it("returns degraded:no-api-key with empty results and 200", async () => {
    const res = await GET(makeReq("evidencias", "u2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.reason).toBe("no-api-key");
    expect(body.results).toEqual([]);
  });
});

describe("rate limiting", () => {
  it(`rejects the ${RATE_LIMIT.max + 1}th rapid request per uuid with 429`, async () => {
    for (let i = 0; i < RATE_LIMIT.max; i++) {
      const ok = await GET(makeReq("evidencias", "rl-uuid"));
      expect(ok.status).toBe(200); // degraded (no key) but allowed
    }
    const blocked = await GET(makeReq("evidencias", "rl-uuid"));
    expect(blocked.status).toBe(429);
  });

  it("keeps buckets separate per uuid", async () => {
    for (let i = 0; i < RATE_LIMIT.max; i++) await GET(makeReq("evidencias", "rl-a"));
    const other = await GET(makeReq("evidencias", "rl-b"));
    expect(other.status).toBe(200);
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

    const res = await GET(makeReq("evidencias", "u3"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ videoId: "aaaaaaaaaaa", title: "Evidências", duration: "4:13" });
    const callsAfterFirst = calls;

    // Second identical query for a different uuid → served from cache (no new fetch).
    const res2 = await GET(makeReq("evidencias", "u4"));
    const body2 = await res2.json();
    expect(body2.cached).toBe(true);
    expect(calls).toBe(callsAfterFirst);
  });

  it("maps a Google quota error to degraded:quota", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    global.fetch = (async () =>
      errJson(403, { error: { errors: [{ reason: "quotaExceeded" }] } })) as unknown as typeof fetch;
    const res = await GET(makeReq("evidencias", "u5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.reason).toBe("quota");
  });

  it("maps other upstream errors to degraded:error (never 500)", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    global.fetch = (async () => errJson(500, {})) as unknown as typeof fetch;
    const res = await GET(makeReq("evidencias", "u6"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.reason).toBe("error");
  });
});
