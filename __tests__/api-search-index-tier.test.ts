/**
 * GET /api/search with the karaoke index tier: cache -> index -> live.
 * The index store is mocked with a tiny in-memory index; fetch is stubbed, so
 * every Data API call is counted and none reaches Google.
 */
import type { NextRequest } from "next/server";

import { KaraokeIndex } from "@/lib/karaoke-index/matcher";
import type { ChannelShard } from "@/lib/karaoke-index/types";

let mockIndex: KaraokeIndex | null = null;
jest.mock("@/lib/karaoke-index/store", () => ({
  getKaraokeIndex: async () => mockIndex,
}));

import { GET } from "@/app/api/search/route";
import { INDEX_MORE_TOKEN } from "@/lib/karaoke-index/tier";
import { _resetCache, _resetRateLimit } from "@/lib/youtube-search";
import { _resetSearchBudget } from "@/lib/search-budget";
import { _resetLiveGate, LIVE_COOLDOWN_MS } from "@/lib/live-search-gate";

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
  _resetLiveGate();
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
    const body = await (await GET(req("bohemian rhapsody karaoke", "&live=1"))).json();
    expect(body.source).toBeUndefined();
    expect(body.results[0].videoId).toBe("vLive000001");
    expect(searchCalls()).toBe(1);
  });

  it("falls back to live when the index is unavailable", async () => {
    mockIndex = null;
    await GET(req("escurinho do cinema karaoke", "&live=1"));
    expect(searchCalls()).toBe(1);
  });

  it("listen-mode queries (no 'karaoke') always go live", async () => {
    await GET(req("escurinho do cinema", "&live=1"));
    expect(searchCalls()).toBe(1);
  });

  it("the cache stays in front of the index", async () => {
    mockIndex = null;
    await GET(req("escurinho do cinema karaoke", "&live=1")); // live, now cached
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

// ── TICKET-125: only an explicit live request may bill ───────────────────────

const PATRON = "123e4567-e89b-42d3-a456-999999999999";
function reqAs(q: string, uuid: string, extra = "", ip = "198.51.100.7"): NextRequest {
  return new Request(
    `http://127.0.0.1:3040/api/search?q=${encodeURIComponent(q)}&uuid=${uuid}${extra}`,
    { headers: { "x-forwarded-for": ip } },
  ) as unknown as NextRequest;
}

describe("index-only vs live-allowed requests", () => {
  afterEach(() => jest.restoreAllMocks());

  it("an index-only request the index cannot answer bills NOTHING and says liveRequired", async () => {
    const body = await (await GET(req("bohemian rhapsody karaoke"))).json();
    expect(body).toEqual({ results: [], liveRequired: true });
    expect(fetchUrls).toEqual([]);
  });

  it("an index-only listen-mode request never bills either", async () => {
    const body = await (await GET(req("bohemian rhapsody"))).json();
    expect(body.liveRequired).toBe(true);
    expect(fetchUrls).toEqual([]);
  });

  it("an index-only miss needs no API key and is not reported as degraded", async () => {
    delete process.env.YOUTUBE_API_KEY;
    const body = await (await GET(req("bohemian rhapsody karaoke"))).json();
    expect(body.liveRequired).toBe(true);
    expect(body.degraded).toBeUndefined();
  });

  it("only live=1 unlocks billing: other spellings stay index-only", async () => {
    for (const v of ["0", "true", "yes", "", "11"]) {
      const body = await (await GET(req(`bohemian rhapsody karaoke ${v}x`, `&live=${v}`))).json();
      expect(body.liveRequired).toBe(true);
    }
    expect(fetchUrls).toEqual([]);
  });

  it("index-only requests are still served from the cache (free)", async () => {
    await GET(req("bohemian rhapsody karaoke", "&live=1")); // billed once, now cached
    const body = await (await GET(req("bohemian rhapsody karaoke"))).json();
    expect(body.cached).toBe(true);
    expect(body.results[0].videoId).toBe("vLive000001");
    expect(searchCalls()).toBe(1);
  });

  it("a client sending live=1 on EVERY keystroke bills at most once per cooldown", async () => {
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    // Four keystrokes: a fifth live request inside 10 s would trip the
    // pre-existing per-uuid rate limit (5/10 s), which would mask the cooldown.
    const keystrokes = ["bohe", "bohem", "bohemi", "bohemia"];
    const bodies = [];
    for (const k of keystrokes) {
      bodies.push(await (await GET(reqAs(`${k} karaoke`, PATRON, "&live=1"))).json());
      now += 250; // a fast phone typist
    }
    expect(searchCalls()).toBe(1);
    const deferred = bodies.filter((b) => b.deferred === "live-cooldown");
    expect(deferred).toHaveLength(3);
    for (const b of deferred) {
      expect(b.results).toEqual([]);
      expect(b.retryAfterMs).toBeGreaterThan(0);
      expect(b.retryAfterMs).toBeLessThanOrEqual(LIVE_COOLDOWN_MS);
    }
    // Once the cooldown has passed, a deliberate live search bills again.
    now = 1_000_000 + LIVE_COOLDOWN_MS;
    await GET(reqAs("bohemian rhapsody karaoke", PATRON, "&live=1"));
    expect(searchCalls()).toBe(2);
  });

  it("the cooldown also covers 'load more' (a page-2 escape cannot be used per keystroke)", async () => {
    let now = 2_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    await GET(reqAs("bohe karaoke", PATRON, "&live=1"));
    now += 300;
    const body = await (
      await GET(reqAs("bohem karaoke", PATRON, `&page=2&pageToken=${INDEX_MORE_TOKEN}`))
    ).json();
    expect(body.deferred).toBe("live-cooldown");
    expect(searchCalls()).toBe(1);
  });

  it("the cooldown is per uuid: two patrons in the same bar are independent", async () => {
    const other = "123e4567-e89b-42d3-a456-888888888888";
    await GET(reqAs("bohemian rhapsody karaoke", PATRON, "&live=1"));
    await GET(reqAs("tempo perdido karaoke", other, "&live=1"));
    expect(searchCalls()).toBe(2);
  });

  it("pre-boot 'anon' callers get a per-IP cooldown, not one shared by everyone", async () => {
    await GET(reqAs("bohemian rhapsody karaoke", "anon", "&live=1", "198.51.100.20"));
    await GET(reqAs("tempo perdido karaoke", "anon", "&live=1", "198.51.100.21"));
    expect(searchCalls()).toBe(2);
  });

  it("as-you-type lookups use their own rate bucket and never starve the patron's Enter", async () => {
    for (let i = 0; i < 12; i++) {
      const res = await GET(reqAs(`bohemian rhapsody karaoke ${i}`, PATRON));
      expect(res.status).toBe(200);
    }
    expect(fetchUrls).toEqual([]);
    const body = await (await GET(reqAs("bohemian rhapsody karaoke", PATRON, "&live=1"))).json();
    expect(body.results[0].videoId).toBe("vLive000001");
    expect(searchCalls()).toBe(1);
  });
});
