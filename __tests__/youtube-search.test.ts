/**
 * Unit tests for lib/youtube-search — response mapping, duration parsing,
 * quota-error handling, cache and rate-limiter. The live Data API is NEVER
 * called: searchYouTube receives an injected fetch stub.
 */
import {
  formatISODuration,
  decodeHtmlEntities,
  mapSearchResponse,
  searchYouTube,
  YouTubeQuotaError,
  YouTubeSearchError,
  cacheKey,
  getCached,
  setCached,
  _resetCache,
  rateLimitOk,
  _resetRateLimit,
  RATE_LIMIT,
} from "@/lib/youtube-search";

describe("formatISODuration", () => {
  it("formats minutes and seconds", () => {
    expect(formatISODuration("PT4M13S")).toBe("4:13");
  });
  it("zero-pads seconds", () => {
    expect(formatISODuration("PT4M3S")).toBe("4:03");
  });
  it("handles seconds only", () => {
    expect(formatISODuration("PT45S")).toBe("0:45");
  });
  it("handles hours", () => {
    expect(formatISODuration("PT1H2M5S")).toBe("1:02:05");
  });
  it("handles minutes only", () => {
    expect(formatISODuration("PT2M")).toBe("2:00");
  });
  it("returns empty for garbage", () => {
    expect(formatISODuration("banana")).toBe("");
    expect(formatISODuration("")).toBe("");
    expect(formatISODuration(undefined)).toBe("");
    expect(formatISODuration(null)).toBe("");
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes common entities", () => {
    expect(decodeHtmlEntities("Rock &amp; Roll &quot;live&quot; &#39;92")).toBe(
      "Rock & Roll \"live\" '92",
    );
  });
});

describe("mapSearchResponse", () => {
  const searchJson = {
    items: [
      {
        id: { videoId: "aaaaaaaaaaa" },
        snippet: {
          title: "Ev&amp;idências",
          channelTitle: "Chitãozinho",
          thumbnails: {
            default: { url: "http://d/def.jpg" },
            medium: { url: "http://d/med.jpg" },
          },
        },
      },
      {
        id: { videoId: "bbbbbbbbbbb" },
        snippet: { title: "Segundo", channelTitle: "Canal B", thumbnails: {} },
      },
      // A channel result with no videoId — must be dropped.
      { id: {}, snippet: { title: "Nope" } },
    ],
  };
  const videosJson = {
    items: [
      { id: "aaaaaaaaaaa", contentDetails: { duration: "PT4M13S" } },
      { id: "bbbbbbbbbbb", contentDetails: { duration: "PT3M" } },
    ],
  };

  it("fuses search + videos into ordered results", () => {
    const out = mapSearchResponse(searchJson, videosJson);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      videoId: "aaaaaaaaaaa",
      title: "Ev&idências",
      channelTitle: "Chitãozinho",
      duration: "4:13",
      thumbnailUrl: "http://d/med.jpg",
    });
  });

  it("decodes HTML entities in title/channel", () => {
    const out = mapSearchResponse(searchJson, videosJson);
    expect(out[0].title).toBe("Ev&idências");
  });

  it("prefers the medium thumbnail then falls back", () => {
    const out = mapSearchResponse(searchJson, videosJson);
    expect(out[0].thumbnailUrl).toBe("http://d/med.jpg");
    expect(out[1].thumbnailUrl).toBe(""); // empty thumbnails object
  });

  it("drops items without a videoId", () => {
    const out = mapSearchResponse(searchJson, videosJson);
    expect(out.map((r) => r.videoId)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
  });

  it("leaves duration empty when videos.list lacks the id", () => {
    const out = mapSearchResponse(searchJson, { items: [] });
    expect(out[0].duration).toBe("");
  });

  it("tolerates empty payloads", () => {
    expect(mapSearchResponse({}, {})).toEqual([]);
  });
});

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function errJson(status: number, body: unknown): Response {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

describe("searchYouTube (injected fetch — never hits the network)", () => {
  it("performs search.list then videos.list and maps results", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.includes("/search")) {
        return okJson({
          items: [{ id: { videoId: "aaaaaaaaaaa" }, snippet: { title: "T", channelTitle: "C", thumbnails: { medium: { url: "u" } } } }],
        });
      }
      return okJson({ items: [{ id: "aaaaaaaaaaa", contentDetails: { duration: "PT2M2S" } }] });
    }) as unknown as typeof fetch;

    const out = await searchYouTube("evidencias", "FAKE_KEY", { fetchImpl });
    expect(out).toEqual([
      { videoId: "aaaaaaaaaaa", title: "T", channelTitle: "C", duration: "2:02", thumbnailUrl: "u" },
    ]);
    // Two endpoints hit, key present, correct filter params on search.
    expect(calls[0]).toContain("videoEmbeddable=true");
    expect(calls[0]).toContain("type=video");
    expect(calls[0]).toContain("regionCode=BR");
    expect(calls[0]).toContain("safeSearch=moderate");
    expect(calls[0]).toContain("key=FAKE_KEY");
    expect(calls[1]).toContain("/videos");
  });

  it("skips videos.list when search returns nothing", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return okJson({ items: [] });
    }) as unknown as typeof fetch;
    const out = await searchYouTube("nothing", "K", { fetchImpl });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(1); // no videos.list call
  });

  it("throws YouTubeQuotaError on a 403 quotaExceeded from search.list", async () => {
    const fetchImpl = (async () =>
      errJson(403, { error: { errors: [{ reason: "quotaExceeded" }] } })) as unknown as typeof fetch;
    await expect(searchYouTube("q", "K", { fetchImpl })).rejects.toBeInstanceOf(YouTubeQuotaError);
  });

  it("throws YouTubeSearchError on other non-OK search responses", async () => {
    const fetchImpl = (async () =>
      errJson(400, { error: { errors: [{ reason: "badRequest" }] } })) as unknown as typeof fetch;
    await expect(searchYouTube("q", "K", { fetchImpl })).rejects.toBeInstanceOf(YouTubeSearchError);
  });

  it("returns results without durations when videos.list fails non-fatally", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("/search")) {
        return okJson({ items: [{ id: { videoId: "aaaaaaaaaaa" }, snippet: { title: "T", channelTitle: "C", thumbnails: {} } }] });
      }
      return errJson(500, {});
    }) as unknown as typeof fetch;
    const out = await searchYouTube("q", "K", { fetchImpl });
    expect(out[0].duration).toBe("");
  });
});

describe("query cache", () => {
  beforeEach(() => _resetCache());

  it("stores and retrieves within TTL", () => {
    const key = cacheKey("Evidências", "BR");
    expect(getCached(key)).toBeNull();
    setCached(key, [{ videoId: "aaaaaaaaaaa", title: "t", channelTitle: "c", duration: "", thumbnailUrl: "" }]);
    expect(getCached(key)).toHaveLength(1);
  });

  it("is case-insensitive on the query", () => {
    setCached(cacheKey("Evidências", "BR"), [
      { videoId: "aaaaaaaaaaa", title: "t", channelTitle: "c", duration: "", thumbnailUrl: "" },
    ]);
    expect(getCached(cacheKey("evidências", "BR"))).toHaveLength(1);
  });

  it("expires entries past the TTL", () => {
    const key = cacheKey("q", "BR");
    setCached(key, [], 1000);
    expect(getCached(key, 1000 + 59_000)).not.toBeNull();
    expect(getCached(key, 1000 + 61_000)).toBeNull();
  });
});

describe("rate limiter", () => {
  beforeEach(() => _resetRateLimit());

  it(`allows ${RATE_LIMIT.max} requests then rejects the next`, () => {
    const now = 10_000;
    for (let i = 0; i < RATE_LIMIT.max; i++) {
      expect(rateLimitOk("uuid-1", now)).toBe(true);
    }
    expect(rateLimitOk("uuid-1", now)).toBe(false); // 6th within the window
  });

  it("isolates buckets per uuid", () => {
    const now = 10_000;
    for (let i = 0; i < RATE_LIMIT.max; i++) rateLimitOk("uuid-1", now);
    expect(rateLimitOk("uuid-2", now)).toBe(true);
  });

  it("recovers after the window slides", () => {
    const now = 10_000;
    for (let i = 0; i < RATE_LIMIT.max; i++) rateLimitOk("uuid-1", now);
    expect(rateLimitOk("uuid-1", now)).toBe(false);
    expect(rateLimitOk("uuid-1", now + RATE_LIMIT.windowMs + 1)).toBe(true);
  });
});
