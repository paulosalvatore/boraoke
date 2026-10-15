/**
 * GET /api/video-meta — the paste preview (TICKET-140 gap 4), and the shared
 * display label (gap 3).
 *
 * YouTube is mocked at the network boundary (global.fetch). The endpoint must
 * only ever use keyless oEmbed: it is public, so it must never be able to
 * spend Data API quota.
 */
import { GET } from "@/app/api/video-meta/route";
import { _resetMetaCache } from "@/lib/video-meta";
import { _resetVideoMetaRateLimit, VIDEO_META_RATE_IP_MAX } from "@/lib/video-meta-rate-limit";
import { songLabel, songTitle } from "@/lib/song-label";
import { NextRequest } from "next/server";

function req(v: string, ip = "203.0.113.7"): NextRequest {
  return new NextRequest(`http://127.0.0.1:3040/api/video-meta?v=${encodeURIComponent(v)}`, {
    headers: { "x-forwarded-for": ip },
  });
}

function res(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe("GET /api/video-meta (TICKET-140)", () => {
  const realFetch = global.fetch;
  const realKey = process.env.YOUTUBE_API_KEY;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    _resetMetaCache();
    _resetVideoMetaRateLimit();
    process.env.YOUTUBE_API_KEY = "test-key"; // present, and still never used here
    fetchMock = jest.fn(async () => res({ title: "Evidências", author_name: "Chitãozinho & Xororó" }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = realKey;
  });

  it("returns title + channel from oEmbed, with zero Data API calls", async () => {
    const r = await GET(req("dQw4w9WgXcQ"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ title: "Evidências", channelTitle: "Chitãozinho & Xororó" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/oembed");
    expect(url.searchParams.get("key")).toBeNull();
  });

  it("is cached: a second patron asking for the same video makes no call", async () => {
    await GET(req("dQw4w9WgXcQ"));
    fetchMock.mockClear();
    const r = await GET(req("dQw4w9WgXcQ", "198.51.100.1"));
    expect(await r.json()).toEqual({ title: "Evidências", channelTitle: "Chitãozinho & Xororó" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unknown video answers {} (the placeholder stays) and the 'missing' is cached", async () => {
    fetchMock.mockResolvedValue(res({}, 404));
    expect(await (await GET(req("aaaaaaaaaa1"))).json()).toEqual({});
    fetchMock.mockClear();
    expect(await (await GET(req("aaaaaaaaaa1"))).json()).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a transient failure answers {} and is NOT cached", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    expect(await (await GET(req("bbbbbbbbbb2"))).json()).toEqual({});
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(res({ title: "Back" }));
    expect(await (await GET(req("bbbbbbbbbb2"))).json()).toEqual({ title: "Back" });
  });

  it("a found title may be cached by the browser; an empty answer never is", async () => {
    const found = await GET(req("dQw4w9WgXcQ"));
    expect(found.headers.get("cache-control")).toBe("private, max-age=600");
    fetchMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    const blip = await GET(req("ccccccccccc"));
    expect(await blip.json()).toEqual({});
    expect(blip.headers.get("cache-control")).toBe("no-store");
    fetchMock.mockResolvedValue(res({}, 404));
    const missing = await GET(req("ddddddddddd"));
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects an invalid id with 400 and makes no call", async () => {
    for (const v of ["", "short", "dQw4w9WgXcQ&x=1", "../../etc/pas"]) {
      expect((await GET(req(v))).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is rate-limited per IP", async () => {
    for (let i = 0; i < VIDEO_META_RATE_IP_MAX; i++) {
      expect((await GET(req("dQw4w9WgXcQ"))).status).toBe(200);
    }
    expect((await GET(req("dQw4w9WgXcQ"))).status).toBe(429);
    // Another address is unaffected.
    expect((await GET(req("dQw4w9WgXcQ", "198.51.100.9"))).status).toBe(200);
  });
});

describe("song label (TICKET-140 gap 3)", () => {
  const base = { videoId: "dQw4w9WgXcQ" };
  it("falls back to youtu.be/<id> without a title", () => {
    expect(songLabel(base)).toBe("youtu.be/dQw4w9WgXcQ");
    expect(songTitle(base)).toBe("youtu.be/dQw4w9WgXcQ");
  });
  it("shows title and channel, and the duration only when asked", () => {
    const e = { ...base, title: "T", channelTitle: "C", duration: "3:33" };
    expect(songLabel(e)).toBe("T · C");
    expect(songLabel(e, { duration: true })).toBe("T · C · 3:33");
    expect(songTitle(e)).toBe("T");
  });
});
