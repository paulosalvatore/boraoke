/**
 * API input-validation tests for POST /api/queue (security MEDIUMs #1 and #2).
 * The handler only uses req.text(), so a standard Request suffices.
 */
import { POST } from "@/app/api/queue/route";
import { store, DEFAULT_ROOM } from "@/lib/store";
import type { NextRequest } from "next/server";

const VALID_UUID = "123e4567-e89b-42d3-a456-426614174000";
const VALID_VIDEO_ID = "dQw4w9WgXcQ";

function makeRequest(body: unknown): NextRequest {
  return new Request("http://127.0.0.1:3040/api/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    videoId: VALID_VIDEO_ID,
    nickname: "Alice",
    patronUuid: VALID_UUID,
    mode: "sing",
    ...overrides,
  };
}

describe("POST /api/queue validation", () => {
  beforeEach(async () => {
    await store.clear(DEFAULT_ROOM);
  });

  it("accepts a valid entry", async () => {
    const res = await POST(makeRequest(validBody()));
    expect(res.status).toBe(201);
    expect(await store.getQueue(DEFAULT_ROOM)).toHaveLength(1);
  });

  describe("videoId validation on the direct path (MEDIUM #1)", () => {
    it("rejects a direct videoId that is not 11 chars", async () => {
      const res = await POST(makeRequest(validBody({ videoId: "short" })));
      expect(res.status).toBe(400);
      expect(await store.getQueue(DEFAULT_ROOM)).toHaveLength(0);
    });

    it("rejects a direct videoId with invalid characters", async () => {
      const res = await POST(
        makeRequest(validBody({ videoId: "<script>ale" }))
      );
      expect(res.status).toBe(400);
    });

    it("rejects a direct videoId that is a URL", async () => {
      const res = await POST(
        makeRequest(validBody({ videoId: "https://youtu.be/dQw4w9WgXcQ" }))
      );
      expect(res.status).toBe(400);
    });
  });

  describe("field length limits (MEDIUM #2)", () => {
    it("rejects nickname over 30 chars", async () => {
      const res = await POST(
        makeRequest(validBody({ nickname: "x".repeat(31) }))
      );
      expect(res.status).toBe(400);
    });

    it("accepts nickname at exactly 30 chars", async () => {
      const res = await POST(
        makeRequest(validBody({ nickname: "x".repeat(30) }))
      );
      expect(res.status).toBe(201);
    });

    it("rejects title over 120 chars", async () => {
      const res = await POST(
        makeRequest(validBody({ title: "t".repeat(121) }))
      );
      expect(res.status).toBe(400);
    });

    it("rejects table over 10 chars", async () => {
      const res = await POST(
        makeRequest(validBody({ table: "1".repeat(11) }))
      );
      expect(res.status).toBe(400);
    });

    it("rejects a non-UUID patronUuid", async () => {
      const res = await POST(
        makeRequest(validBody({ patronUuid: "not-a-uuid" }))
      );
      expect(res.status).toBe(400);
    });

    it("rejects an oversized request body", async () => {
      const res = await POST(
        makeRequest(validBody({ title: "x".repeat(5000) }))
      );
      expect(res.status).toBe(400);
    });
  });

  describe("queue-full rejection (MEDIUM #3, API level)", () => {
    it("returns 429 when the queue is full", async () => {
      // Fill the queue via the store directly for speed
      const { QUEUE_MAX } = await import("@/lib/store");
      for (let i = 0; i < QUEUE_MAX; i++) {
        await store.addEntry(DEFAULT_ROOM, {
          id: `e${i}`,
          videoId: VALID_VIDEO_ID,
          nickname: "Filler",
          patronUuid: VALID_UUID,
          mode: "sing",
          submittedAt: new Date().toISOString(),
        });
      }
      // Submit a DISTINCT entry (different uuid + video) so the rejection is the
      // capacity 429, not the TICKET-10 duplicate 409 (the filler rows all share
      // VALID_UUID/VALID_VIDEO_ID).
      const res = await POST(
        makeRequest(
          validBody({
            videoId: "abcdefghijk",
            patronUuid: "11111111-1111-4111-8111-111111111111",
          }),
        ),
      );
      expect(res.status).toBe(429);
      expect(await store.getQueue(DEFAULT_ROOM)).toHaveLength(QUEUE_MAX);
    });
  });
});

/* ------------------------------------------------------------------------- *
 * TICKET-61 / TICKET-95 / TICKET-140 — the server-side video lookup.
 *
 * TICKET-140 changed three things, all tested here:
 *  - the embeddability check runs for EVERY submit, whatever `source` the
 *    client declares (gap 6);
 *  - a DEFINITE not-embeddable answer refuses the song with a 422 (gap 5),
 *    while every failure still lets it through (fail-open);
 *  - the stored title is the server's (videos.list snippet, else oEmbed); the
 *    client-sent title is only the fallback when every lookup failed (gap 3/6).
 *
 * YouTube is mocked at the network boundary (global.fetch), routed by path,
 * so the REAL lib/youtube.ts + lib/video-meta.ts code runs.
 * ------------------------------------------------------------------------- */
describe("POST /api/queue — server-side video lookup (TICKET-140)", () => {
  const PT_BLOCKED =
    "Esse vídeo não toca no telão do bar — o dono do vídeo não permite. Tenta outra versão da música.";
  const realFetch = global.fetch;
  const realKey = process.env.YOUTUBE_API_KEY;
  let fetchMock: jest.Mock;
  let videosHandler: (id: string) => Response | Promise<Response>;
  let oembedHandler: (id: string) => Response | Promise<Response>;

  let n = 0;
  function freshBody(overrides: Record<string, unknown> = {}) {
    n += 1;
    return validBody({
      patronUuid: `123e4567-e89b-42d3-a456-4266141740${String(10 + (n % 90)).slice(-2)}`,
      videoId: `vid${String(n).padStart(2, "0")}xxxxxx`.slice(0, 11),
      ...overrides,
    });
  }

  function res(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }

  function videoItem(id: string, embeddable: boolean, title = `Title of ${id}`) {
    return res({
      items: [
        {
          id,
          status: { embeddable },
          snippet: { title, channelTitle: "Sing King" },
          contentDetails: { duration: "PT4M5S" },
        },
      ],
    });
  }

  const videosCalls = () =>
    fetchMock.mock.calls.filter((c) => new URL(c[0] as string).pathname === "/youtube/v3/videos");
  const oembedCalls = () =>
    fetchMock.mock.calls.filter((c) => new URL(c[0] as string).pathname === "/oembed");

  beforeEach(async () => {
    await store.clear(DEFAULT_ROOM);
    const { _resetEmbedCache } = await import("@/lib/embed-cache");
    const { _resetMetaCache } = await import("@/lib/video-meta");
    const { _resetSubmitRateLimit } = await import("@/lib/queue-rate-limit");
    _resetEmbedCache();
    _resetMetaCache();
    _resetSubmitRateLimit();
    process.env.YOUTUBE_API_KEY = "test-key";
    videosHandler = (id) => videoItem(id, true);
    oembedHandler = () => res({}, 404);
    fetchMock = jest.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === "/youtube/v3/videos") return videosHandler(url.searchParams.get("id")!);
      if (url.pathname === "/oembed") {
        const v = new URL(url.searchParams.get("url")!).searchParams.get("v")!;
        return oembedHandler(v);
      }
      throw new Error(`unexpected outbound call ${input}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = realKey;
  });

  describe("gap 5: a definite not-embeddable answer blocks the song", () => {
    it("paste → 422 with friendly copy, nothing queued", async () => {
      videosHandler = (id) => videoItem(id, false);
      const r = await POST(makeRequest(freshBody({ source: "paste" })));
      expect(r.status).toBe(422);
      expect(await r.json()).toEqual({ error: PT_BLOCKED, reason: "not-embeddable" });
      expect(await store.getQueue(DEFAULT_ROOM)).toHaveLength(0);
    });

    it("a moderated room refuses it too — nothing reaches the pending list", async () => {
      const { createRoom, setRoomModeration } = await import("@/lib/rooms");
      const { pendingStore } = await import("@/lib/pending-store");
      const created = await createRoom("Bar Embeddable 140");
      if (!created) throw new Error("room ceiling hit in test");
      await setRoomModeration(created.room.id, true);
      videosHandler = (id) => videoItem(id, false);

      const r = await POST(makeRequest(freshBody({ source: "paste", room: created.room.id })));
      expect(r.status).toBe(422);
      expect(await pendingStore.countRoom(created.room.id)).toBe(0);
    });

    it("an embeddable video is queued (201, plain ack)", async () => {
      const r = await POST(makeRequest(freshBody({ source: "paste" })));
      expect(r.status).toBe(201);
      expect(await r.json()).toEqual({ ok: true });
    });

    describe("fail-open: anything short of a definite answer lets the song through", () => {
      it.each([
        ["quota exhausted (403)", () => res({ error: { errors: [{ reason: "quotaExceeded" }] } }, 403)],
        ["API 5xx", () => res({}, 500)],
        ["empty items (deleted/private)", () => res({ items: [] })],
        ["malformed body", () => res({ items: [{ id: "x" }] })],
      ])("%s → 201 queued", async (_name, handler) => {
        videosHandler = handler as () => Response;
        const r = await POST(makeRequest(freshBody({ source: "paste" })));
        expect(r.status).toBe(201);
        expect(await store.getQueue(DEFAULT_ROOM)).toHaveLength(1);
      });

      it("network error / timeout → 201 queued, no 5xx", async () => {
        videosHandler = () => {
          throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
        };
        oembedHandler = () => {
          throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
        };
        const r = await POST(makeRequest(freshBody({ source: "paste" })));
        expect(r.status).toBe(201);
        expect(await store.getQueue(DEFAULT_ROOM)).toHaveLength(1);
      });

      it("no API key → 201 queued, and zero videos.list calls (0 units)", async () => {
        delete process.env.YOUTUBE_API_KEY;
        const r = await POST(makeRequest(freshBody({ source: "paste" })));
        expect(r.status).toBe(201);
        expect(videosCalls()).toHaveLength(0);
      });
    });
  });

  describe("gap 6: the client's `source` no longer skips the check", () => {
    it.each([
      ["source:'search'", { source: "search" }],
      ["no source (legacy client)", {}],
      ["an unknown source", { source: "wat" }],
    ])("%s with a not-embeddable video is still refused", async (_name, extra) => {
      videosHandler = (id) => videoItem(id, false);
      const r = await POST(makeRequest(freshBody(extra)));
      expect(r.status).toBe(422);
      expect(videosCalls()).toHaveLength(1);
    });

    it("a URL-only body is checked too", async () => {
      videosHandler = (id) => videoItem(id, false);
      const r = await POST(
        makeRequest({
          youtubeUrl: `https://youtu.be/${VALID_VIDEO_ID}`,
          nickname: "Alice",
          patronUuid: "99999999-9999-4999-8999-999999999999",
          mode: "sing",
        }),
      );
      expect(r.status).toBe(422);
    });

    it("spends exactly ONE videos.list call per submit, for status+snippet+contentDetails", async () => {
      const body = freshBody({ source: "search" });
      await POST(makeRequest(body));
      expect(videosCalls()).toHaveLength(1);
      const url = new URL(videosCalls()[0][0] as string);
      expect(url.searchParams.get("part")).toBe("status,snippet,contentDetails");
      expect(url.searchParams.get("id")).toBe(body.videoId);
      expect(oembedCalls()).toHaveLength(0); // the snippet already gave the title
    });

    it("refused submits (400 validation, 409 duplicate) make no outbound call", async () => {
      expect((await POST(makeRequest(freshBody({ videoId: "short" })))).status).toBe(400);
      const body = freshBody();
      expect((await POST(makeRequest(body))).status).toBe(201);
      fetchMock.mockClear();
      expect((await POST(makeRequest(body))).status).toBe(409);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("gap 3/6: the stored title is the server's", () => {
    it("videos.list snippet replaces a client-sent title; channel and duration are stored", async () => {
      const body = freshBody({ source: "search", title: "Totally Not Spam www.evil.example" });
      videosHandler = (id) => videoItem(id, true, "Bohemian Rhapsody (Karaoke Version)");
      expect((await POST(makeRequest(body))).status).toBe(201);
      const [entry] = await store.getQueue(DEFAULT_ROOM);
      expect(entry.title).toBe("Bohemian Rhapsody (Karaoke Version)");
      expect(entry.channelTitle).toBe("Sing King");
      expect(entry.duration).toBe("4:05");
    });

    it("no key: the title comes from oEmbed — one oEmbed call, zero Data API calls", async () => {
      delete process.env.YOUTUBE_API_KEY;
      oembedHandler = () => res({ title: "Evidências (Karaokê)", author_name: "Karaokê BR" });
      expect((await POST(makeRequest(freshBody({ source: "paste" })))).status).toBe(201);
      const [entry] = await store.getQueue(DEFAULT_ROOM);
      expect(entry.title).toBe("Evidências (Karaokê)");
      expect(entry.channelTitle).toBe("Karaokê BR");
      expect(oembedCalls()).toHaveLength(1);
      expect(videosCalls()).toHaveLength(0);
    });

    it("videos.list fails: oEmbed is the fallback title source", async () => {
      videosHandler = () => res({}, 500);
      oembedHandler = () => res({ title: "From oEmbed", author_name: "Chan" });
      expect((await POST(makeRequest(freshBody()))).status).toBe(201);
      expect((await store.getQueue(DEFAULT_ROOM))[0].title).toBe("From oEmbed");
    });

    it("every lookup failed: the client title is kept (fallback), and absent stays absent", async () => {
      videosHandler = () => res({}, 500);
      oembedHandler = () => res({}, 503);
      await POST(makeRequest(freshBody({ title: "Typed by patron" })));
      await POST(makeRequest(freshBody()));
      const q = await store.getQueue(DEFAULT_ROOM);
      expect(q.map((e) => e.title)).toEqual(["Typed by patron", undefined]);
    });
  });

  describe("caches: repeats cost nothing", () => {
    it("two patrons, same video: one videos.list call total, and the title still lands", async () => {
      const videoId = "cachehit140";
      videosHandler = (id) => videoItem(id, true, "Cached Title");
      expect((await POST(makeRequest(freshBody({ videoId })))).status).toBe(201);
      fetchMock.mockClear();
      expect((await POST(makeRequest(freshBody({ videoId })))).status).toBe(201);
      expect(fetchMock).not.toHaveBeenCalled();
      const q = await store.getQueue(DEFAULT_ROOM);
      expect(q.map((e) => e.title)).toEqual(["Cached Title", "Cached Title"]);
    });

    it("a cached not-embeddable verdict refuses the repeat with zero calls", async () => {
      const videoId = "cachehit141";
      videosHandler = (id) => videoItem(id, false);
      expect((await POST(makeRequest(freshBody({ videoId })))).status).toBe(422);
      fetchMock.mockClear();
      expect((await POST(makeRequest(freshBody({ videoId })))).status).toBe(422);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("no key: a found oEmbed title is cached, the repeat makes no call", async () => {
      delete process.env.YOUTUBE_API_KEY;
      const videoId = "cachehit142";
      oembedHandler = () => res({ title: "Once", author_name: "C" });
      await POST(makeRequest(freshBody({ videoId })));
      fetchMock.mockClear();
      await POST(makeRequest(freshBody({ videoId })));
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("gap 1/2 through the route: the server parses youtubeUrl with the same parser", () => {
    function urlBody(youtubeUrl: string) {
      n += 1;
      return {
        youtubeUrl,
        nickname: "Alice",
        patronUuid: `323e4567-e89b-42d3-a456-4266141760${String(10 + (n % 90)).slice(-2)}`,
        mode: "sing",
      };
    }
    it.each([
      `https://music.youtube.com/watch?v=${VALID_VIDEO_ID}`,
      `https://www.youtube-nocookie.com/embed/${VALID_VIDEO_ID}`,
      `HTTPS://YOUTU.BE/${VALID_VIDEO_ID}/`,
      `olha esse https://youtu.be/${VALID_VIDEO_ID} 🔥`,
    ])("accepts %s", async (u) => {
      await store.clear(DEFAULT_ROOM);
      expect((await POST(makeRequest(urlBody(u)))).status).toBe(201);
      expect((await store.getQueue(DEFAULT_ROOM))[0].videoId).toBe(VALID_VIDEO_ID);
    });

    it("refuses an 11-letter word and a look-alike host", async () => {
      expect((await POST(makeRequest(urlBody("Imagination")))).status).toBe(400);
      expect(
        (await POST(makeRequest(urlBody(`https://youtube.com.evil.com/watch?v=${VALID_VIDEO_ID}`)))).status,
      ).toBe(400);
    });
  });
});
