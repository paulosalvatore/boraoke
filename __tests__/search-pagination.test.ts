/**
 * TICKET-83 — pagination + quota tests.
 *
 * The whole point of this ticket is that the patron gets MORE results without
 * spending MORE YouTube quota. These tests pin the three mechanisms that make
 * that true, and they count OUTBOUND CALLS rather than trusting comments:
 *
 * QUOTA MODEL (post-2026-06-01): `search.list` is capped at 100 CALLS PER DAY
 * in its own bucket — NOT 100 units of a shared 10,000 — and videos.list costs
 * 1 unit of a separate, barely-touched pool. One search = 1% of the platform's
 * entire day. What is pinned here:
 *   1. `maxResults` is the API maximum (50). search.list bills per CALL, so one
 *      50-row call costs exactly what the old 8-row call cost — and covers ~6
 *      client-side pages.
 *   2. A deep page (`pageToken`) is a SEPARATE cache entry, so paging forward
 *      then back is free.
 *   3. The route consults the cache before it ever calls Google.
 *   4. Page depth is HARD-CAPPED (MAX_SEARCH_PAGES) and never prefetched.
 *
 * The Data API is never contacted — fetch is stubbed everywhere.
 */
import { GET } from "@/app/api/search/route";
import {
  cacheKey,
  searchYouTubePage,
  getCachedPage,
  setCachedPage,
  SEARCH_DEFAULTS,
  CLIENT_PAGE_SIZE,
  MAX_SEARCH_PAGES,
  _resetCache,
  _resetRateLimit,
} from "@/lib/youtube-search";
import { getCachedSearchPage, setCachedSearchPage } from "@/lib/search-cache";
import type { NextRequest } from "next/server";
import { _resetSearchBudget } from "@/lib/search-budget";

const KEY_BACKUP = process.env.YOUTUBE_API_KEY;

function testUuid(n: number): string {
  return `123e4567-e89b-42d3-a456-${String(n).padStart(12, "0")}`;
}

function makeReq(
  q: string,
  uuid = testUuid(0),
  pageToken?: string,
  page?: number,
): NextRequest {
  let url = `http://127.0.0.1:3040/api/search?q=${encodeURIComponent(q)}&uuid=${uuid}`;
  if (pageToken !== undefined) url += `&pageToken=${encodeURIComponent(pageToken)}`;
  if (page !== undefined) url += `&page=${page}`;
  return new Request(url) as unknown as NextRequest;
}

/** A Google search.list payload with `n` items and an optional next cursor. */
function searchListJson(n: number, nextPageToken?: string) {
  return {
    nextPageToken,
    items: Array.from({ length: n }, (_, i) => ({
      id: { videoId: `vid${i}` },
      snippet: {
        title: `Song ${i}`,
        channelTitle: "Channel",
        thumbnails: { medium: { url: `https://i.ytimg.com/vi/vid${i}/mqdefault.jpg` } },
      },
    })),
  };
}

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  _resetCache();
  _resetRateLimit();
  // TICKET-87: the daily search budget is module-level state shared across this
  // whole file; reset it so accumulated spend can't degrade a later test.
  _resetSearchBudget();
  delete process.env.YOUTUBE_API_KEY;
  process.env.STORE_DRIVER = "memory";
});
afterAll(() => {
  if (KEY_BACKUP === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = KEY_BACKUP;
});

describe("quota shape: one call, many rows", () => {
  it("asks Google for the API maximum (50) rows per search.list call", () => {
    // search.list bills one of 100 DAILY CALLS, not per row — so 50 is strictly
    // better than 8 at identical cost. This is the ticket's core lever.
    expect(SEARCH_DEFAULTS.maxResults).toBe(50);
  });

  it("one 50-row fetch covers several client pages before any new call", () => {
    expect(SEARCH_DEFAULTS.maxResults / CLIENT_PAGE_SIZE).toBeGreaterThanOrEqual(6);
  });

  it("sends maxResults=50 and NO pageToken on a first-page search", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(String(u));
      return okJson(searchListJson(2));
    }) as unknown as typeof fetch;

    await searchYouTubePage("evidencias", "K", { fetchImpl });
    const searchUrl = new URL(urls[0]);
    expect(searchUrl.searchParams.get("maxResults")).toBe("50");
    expect(searchUrl.searchParams.has("pageToken")).toBe(false);
    // Exactly two outbound calls: search.list (1 of the 100 daily searches)
    // + videos.list (1 unit of the separate, ample metadata pool).
    expect(urls).toHaveLength(2);
  });

  it("forwards a pageToken and surfaces the next cursor", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(String(u));
      return okJson(searchListJson(2, "CURSOR_2"));
    }) as unknown as typeof fetch;

    const page = await searchYouTubePage("evidencias", "K", {
      fetchImpl,
      pageToken: "CURSOR_1",
    });
    expect(new URL(urls[0]).searchParams.get("pageToken")).toBe("CURSOR_1");
    expect(page.nextPageToken).toBe("CURSOR_2");
    expect(page.results).toHaveLength(2);
  });

  it("omits nextPageToken on the last page", async () => {
    const fetchImpl = (async () => okJson(searchListJson(1))) as unknown as typeof fetch;
    const page = await searchYouTubePage("q", "K", { fetchImpl });
    expect(page.nextPageToken).toBeUndefined();
  });
});

describe("cacheKey is page-scoped (paging back is free)", () => {
  it("keeps the first-page key byte-identical to the pre-TICKET-83 key", () => {
    // Pre-existing Redis entries must not be orphaned by this change.
    expect(cacheKey("  Foo   Bar ", "BR")).toBe("BR::foo bar");
    expect(cacheKey("foo bar", "BR", "")).toBe("BR::foo bar");
  });

  it("a crafted QUERY cannot forge a deep-page key (reviewer finding 1)", () => {
    // nextPageToken is handed to every client, so an attacker knows the real
    // cursor. If the page marker were lowercase, searching the literal text
    // "p:<token>::<query>" would land on page 2's entry for a popular search and
    // serve attacker-chosen videos to every venue for the 12h TTL. The marker is
    // uppercase and the query is lowercased, so the two namespaces cannot meet.
    const realDeepKey = cacheKey("evidencias", "BR", "cursor2");
    const forged = cacheKey("P:cursor2::evidencias", "BR");
    const forgedLower = cacheKey("p:cursor2::evidencias", "BR");
    expect(forged).not.toBe(realDeepKey);
    expect(forgedLower).not.toBe(realDeepKey);
  });

  it("gives each page its own key", () => {
    const p1 = cacheKey("evidencias", "BR");
    const p2 = cacheKey("evidencias", "BR", "CURSOR_2");
    const p3 = cacheKey("evidencias", "BR", "CURSOR_3");
    expect(new Set([p1, p2, p3]).size).toBe(3);
    expect(p2).toContain("CURSOR_2");
  });

  it("round-trips a page (rows + cursor) through the memory LRU", () => {
    const key = cacheKey("evidencias", "BR", "CURSOR_2");
    expect(getCachedPage(key)).toBeNull();
    setCachedPage(key, { results: [], nextPageToken: "CURSOR_3" });
    expect(getCachedPage(key)?.nextPageToken).toBe("CURSOR_3");
  });

  it("round-trips a page through the cross-instance cache module", async () => {
    const key = cacheKey("evidencias", "BR", "CURSOR_9");
    await setCachedSearchPage(key, {
      results: [{ videoId: "a", title: "t", channelTitle: "c", duration: "", thumbnailUrl: "" }],
      nextPageToken: "CURSOR_10",
    });
    const hit = await getCachedSearchPage(key);
    expect(hit?.results).toHaveLength(1);
    expect(hit?.nextPageToken).toBe("CURSOR_10");
  });
});

describe("GET /api/search — paged requests", () => {
  it("returns nextPageToken so the client can ask for more", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    global.fetch = (async () => okJson(searchListJson(50, "CURSOR_2"))) as unknown as typeof fetch;

    const body = await (await GET(makeReq("evidencias", testUuid(1)))).json();
    expect(body.results).toHaveLength(50);
    expect(body.nextPageToken).toBe("CURSOR_2");
  });

  it("a REVISITED page is served from cache — ZERO outbound calls", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return okJson(searchListJson(3, "CURSOR_3"));
    }) as unknown as typeof fetch;

    // Cold deep page: search.list + videos.list.
    const first = await (await GET(makeReq("evidencias", testUuid(2), "CURSOR_2", 2))).json();
    expect(first.cached).toBeUndefined();
    const afterCold = calls;
    expect(afterCold).toBeGreaterThan(0);

    // The patron pages forward then back to the SAME page (even as another
    // patron/uuid) → cache hit, no quota spent.
    const again = await (await GET(makeReq("evidencias", testUuid(3), "CURSOR_2", 2))).json();
    expect(again.cached).toBe(true);
    expect(again.nextPageToken).toBe("CURSOR_3");
    expect(calls).toBe(afterCold);
  });

  it("page 2 does NOT collide with page 1's cache entry", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    const tokensSeen: (string | null)[] = [];
    global.fetch = (async (u: string) => {
      const url = new URL(String(u));
      if (url.pathname.endsWith("/search")) {
        tokensSeen.push(url.searchParams.get("pageToken"));
      }
      return okJson(searchListJson(2, "CURSOR_NEXT"));
    }) as unknown as typeof fetch;

    await GET(makeReq("evidencias", testUuid(4)));
    await GET(makeReq("evidencias", testUuid(5), "CURSOR_2", 2));
    // Both were real calls (distinct keys), and the token was forwarded.
    expect(tokensSeen).toEqual([null, "CURSOR_2"]);
  });

  it("400s a malformed pageToken before it reaches a URL or a cache key", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return okJson(searchListJson(1));
    }) as unknown as typeof fetch;

    const res = await GET(makeReq("evidencias", testUuid(6), "not a token!&key=x"));
    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });

  it("degraded (no key) ignores pageToken and still returns the fallback contract", async () => {
    // No YOUTUBE_API_KEY set → the paste-a-link path. Pagination must not break it.
    const res = await GET(makeReq("evidencias", testUuid(7), "CURSOR_2", 2));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degraded).toBe(true);
    expect(body.results).toEqual([]);
    expect(body.nextPageToken).toBeUndefined();
  });
});

describe("page-depth cap (the daily search budget is scarce)", () => {
  it("caps a single query at 2 search.list calls", () => {
    // 100 searches/day for the WHOLE platform. Page 1 already gives 50 rows;
    // one deep page is a deliberate concession, page 3 is refused.
    expect(MAX_SEARCH_PAGES).toBe(2);
  });

  it("serves a request at the cap", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    global.fetch = (async () => okJson(searchListJson(3, "CURSOR_3"))) as unknown as typeof fetch;
    const res = await GET(makeReq("evidencias", testUuid(20), "CURSOR_2", MAX_SEARCH_PAGES));
    expect(res.status).toBe(200);
  });

  it("400s past the cap WITHOUT spending a search", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return okJson(searchListJson(3, "CURSOR_4"));
    }) as unknown as typeof fetch;

    const res = await GET(makeReq("evidencias", testUuid(21), "CURSOR_3", MAX_SEARCH_PAGES + 1));
    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });

  it("400s a non-numeric page without spending a search", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return okJson(searchListJson(1));
    }) as unknown as typeof fetch;

    const url = `http://127.0.0.1:3040/api/search?q=evidencias&uuid=${testUuid(22)}&page=abc`;
    const res = await GET(new Request(url) as unknown as NextRequest);
    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });
});

describe("page/pageToken must agree (the cap is not sidesteppable)", () => {
  it("rejects a deep cursor smuggled in as page 1", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return okJson(searchListJson(3, "CURSOR_9"));
    }) as unknown as typeof fetch;

    // page defaults to 1; a cursor means depth >= 2, so this is incoherent and
    // would otherwise let a caller page forever at "page 1".
    const res = await GET(makeReq("evidencias", testUuid(30), "CURSOR_5"));
    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });

  it("rejects page 2 with no cursor", async () => {
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return okJson(searchListJson(3));
    }) as unknown as typeof fetch;

    const url = `http://127.0.0.1:3040/api/search?q=evidencias&uuid=${testUuid(31)}&page=2`;
    const res = await GET(new Request(url) as unknown as NextRequest);
    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });
});
