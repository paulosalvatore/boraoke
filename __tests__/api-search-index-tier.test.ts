/**
 * GET /api/search with the karaoke index tier: cache -> index -> live.
 * The index store is mocked with a tiny in-memory index; fetch is stubbed, so
 * every Data API call is counted and none reaches Google.
 */
import type { NextRequest } from "next/server";

import { KaraokeIndex } from "@/lib/karaoke-index/matcher";
import type { ChannelShard } from "@/lib/karaoke-index/types";

let mockIndex: KaraokeIndex | null = null;
let indexLoads = 0;
jest.mock("@/lib/karaoke-index/store", () => ({
  getKaraokeIndex: async () => {
    indexLoads++;
    return mockIndex;
  },
}));

import { GET } from "@/app/api/search/route";
import { INDEX_MORE_TOKEN } from "@/lib/karaoke-index/tier";
import { _resetCache, _resetRateLimit } from "@/lib/youtube-search";
import { _resetSearchBudget } from "@/lib/search-budget";

const SHARD: ChannelShard = {
  v: 1,
  channelId: "UC0000000000000000000001",
  channelTitle: "Karaokê Club",
  harvestedAt: Date.now(),
  rows: [
    ["vEscurinho1", "Escurinho do Cinema - Rita Lee (Karaokê)", "3:41"],
    ["vEvidencia1", "Evidências - Chitãozinho e Xororó (Karaokê)", "4:30"],
  ],
};

let n = 0;
function req(q: string, extra = ""): NextRequest {
  n++;
  const uuid = `123e4567-e89b-42d3-a456-${String(n).padStart(12, "0")}`;
  return new Request(
    `http://127.0.0.1:3040/api/search?q=${encodeURIComponent(q)}&uuid=${uuid}${extra}`,
  ) as unknown as NextRequest;
}

const LIVE_ROW = { id: { videoId: "vLive000001" }, snippet: { title: "Live result", channelTitle: "YT" } };
let fetchUrls: string[] = [];

beforeEach(() => {
  _resetCache();
  _resetRateLimit();
  _resetSearchBudget();
  mockIndex = new KaraokeIndex([SHARD]);
  fetchUrls = [];
  process.env.YOUTUBE_API_KEY = "test-key";
  global.fetch = jest.fn(async (u: RequestInfo | URL) => {
    const url = String(u);
    fetchUrls.push(url);
    const body = url.includes("/search?")
      ? { items: [LIVE_ROW], nextPageToken: "CDIQAA" }
      : { items: [{ id: "vLive000001", contentDetails: { duration: "PT3M" } }] };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
});
afterAll(() => {
  delete process.env.YOUTUBE_API_KEY;
});

const searchCalls = () => fetchUrls.filter((u) => u.includes("/youtube/v3/search?")).length;

describe("index tier", () => {
  it("answers a confident sing-mode query from the index with ZERO search.list calls", async () => {
    const res = await GET(req("escurinho do cinema karaoke"));
    const body = await res.json();
    expect(body.source).toBe("index");
    expect(body.results[0].videoId).toBe("vEscurinho1");
    expect(body.nextPageToken).toBe(INDEX_MORE_TOKEN);
    expect(fetchUrls).toEqual([]);
  });

  it("works without an API key (index needs none)", async () => {
    delete process.env.YOUTUBE_API_KEY;
    const body = await (await GET(req("evidencias karaoke"))).json();
    expect(body.source).toBe("index");
    expect(body.degraded).toBeUndefined();
  });

  it("falls back to ONE live call when the index has no good match", async () => {
    const body = await (await GET(req("bohemian rhapsody karaoke"))).json();
    expect(body.source).toBeUndefined();
    expect(body.results[0].videoId).toBe("vLive000001");
    expect(searchCalls()).toBe(1);
  });

  it("falls back to live when the index is unavailable", async () => {
    mockIndex = null;
    await GET(req("escurinho do cinema karaoke"));
    expect(searchCalls()).toBe(1);
  });

  it("listen-mode queries (no 'karaoke') always go live, without even loading the index", async () => {
    indexLoads = 0;
    await GET(req("escurinho do cinema"));
    expect(searchCalls()).toBe(1);
    expect(indexLoads).toBe(0);
  });

  it("the cache stays in front of the index", async () => {
    mockIndex = null;
    await GET(req("escurinho do cinema karaoke")); // live, now cached
    mockIndex = new KaraokeIndex([SHARD]);
    const body = await (await GET(req("escurinho do cinema karaoke"))).json();
    expect(body.cached).toBe(true);
    expect(body.results[0].videoId).toBe("vLive000001");
    expect(searchCalls()).toBe(1);
  });

  it("'load more' past an index answer runs the LIVE first page (no Google cursor sent)", async () => {
    const body = await (
      await GET(req("escurinho do cinema karaoke", `&page=2&pageToken=${INDEX_MORE_TOKEN}`))
    ).json();
    expect(body.results[0].videoId).toBe("vLive000001");
    expect(searchCalls()).toBe(1);
    const searchUrl = new URL(fetchUrls.find((u) => u.includes("/search?")) as string);
    expect(searchUrl.searchParams.has("pageToken")).toBe(false);
    // ...and that live page is cached under the FIRST-page key.
    const again = await (await GET(req("escurinho do cinema karaoke"))).json();
    expect(again.cached).toBe(true);
    expect(searchCalls()).toBe(1);
  });
});
