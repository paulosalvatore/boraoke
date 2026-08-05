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
 * TICKET-61 — non-blocking embeddability warning on the PASTE path.
 *
 * The YouTube Data API is mocked at the network boundary (global.fetch), so the
 * REAL `checkEmbeddable` code path in lib/youtube.ts runs — the route wiring and
 * the fail-open behavior are both exercised, and nothing touches the network.
 * ------------------------------------------------------------------------- */
describe("POST /api/queue — embeddability warning (TICKET-61)", () => {
  const PT_WARNING =
    "esse vídeo não permite reprodução em telões — pode não tocar";
  const realFetch = global.fetch;
  const realKey = process.env.YOUTUBE_API_KEY;
  let fetchMock: jest.Mock;

  // Distinct uuid/video per test: the submit rate limit is per-uuid and
  // `checkSubmit` refuses a duplicate (same uuid + same video).
  let n = 0;
  function freshBody(overrides: Record<string, unknown> = {}) {
    n += 1;
    return validBody({
      patronUuid: `123e4567-e89b-42d3-a456-4266141740${String(10 + n).slice(-2)}`,
      videoId: `vid${String(n).padStart(2, "0")}xxxxxx`,
      ...overrides,
    });
  }

  function ytResponse(body: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }

  beforeEach(async () => {
    await store.clear(DEFAULT_ROOM);
    process.env.YOUTUBE_API_KEY = "test-key";
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = realFetch;
    if (realKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = realKey;
  });

  it("AC1: a NON-EMBEDDABLE pasted video still succeeds (201) and carries a warning", async () => {
    const body = freshBody({ source: "paste" });
    fetchMock.mockResolvedValue(
      ytResponse({ items: [{ id: body.videoId, status: { embeddable: false } }] }),
    );

    const res = await POST(makeRequest(body));
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.warning).toBe(PT_WARNING);
    // The submit is NEVER blocked: the entry really is in the queue.
    expect(await store.getQueue(DEFAULT_ROOM)).toHaveLength(1);
  });

  it("AC1b: the response stays trimmed — warning is a plain string, no echoed entry fields", async () => {
    const body = freshBody({ source: "paste" });
    fetchMock.mockResolvedValue(
      ytResponse({ items: [{ id: body.videoId, status: { embeddable: false } }] }),
    );

    const json = await (await POST(makeRequest(body))).json();
    expect(Object.keys(json).sort()).toEqual(["ok", "warning"]);
    expect(typeof json.warning).toBe("string");
    expect(json).not.toHaveProperty("patronUuid");
    expect(json).not.toHaveProperty("entry");
    expect(json).not.toHaveProperty("videoId");
  });

  it("AC2: an EMBEDDABLE pasted video gets no warning", async () => {
    const body = freshBody({ source: "paste" });
    fetchMock.mockResolvedValue(
      ytResponse({ items: [{ id: body.videoId, status: { embeddable: true } }] }),
    );

    const res = await POST(makeRequest(body));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });

  describe("AC3: fail-open — a broken check never degrades the endpoint", () => {
    it("quota exhausted (403 quotaExceeded) → 201, no warning", async () => {
      fetchMock.mockResolvedValue(
        ytResponse({ error: { errors: [{ reason: "quotaExceeded" }] } }, 403),
      );
      const res = await POST(makeRequest(freshBody({ source: "paste" })));
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ ok: true });
    });

    it("API 5xx → 201, no warning", async () => {
      fetchMock.mockResolvedValue(ytResponse({}, 500));
      const res = await POST(makeRequest(freshBody({ source: "paste" })));
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ ok: true });
    });

    it("network error / timeout → 201, no warning, no 5xx", async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new Error("aborted"), { name: "TimeoutError" }),
      );
      const res = await POST(makeRequest(freshBody({ source: "paste" })));
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ ok: true });
      expect(await store.getQueue(DEFAULT_ROOM)).toHaveLength(1);
    });

    it("no API key configured → 201, no warning, and no outbound call", async () => {
      delete process.env.YOUTUBE_API_KEY;
      const res = await POST(makeRequest(freshBody({ source: "paste" })));
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ ok: true });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("AC4: the SEARCH path skips the check entirely (no quota spent)", () => {
    it("source:'search' with a pre-parsed videoId makes no outbound call", async () => {
      const res = await POST(makeRequest(freshBody({ source: "search" })));
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ ok: true });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a legacy client (videoId, no source) is treated as search — no outbound call", async () => {
      const res = await POST(makeRequest(freshBody()));
      expect(res.status).toBe(201);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("an unrecognised source value is treated as search — no outbound call", async () => {
      const res = await POST(makeRequest(freshBody({ source: "wat" })));
      expect(res.status).toBe(201);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("a URL-only body (no pre-parsed videoId) is inherently a paste and IS checked", async () => {
    n += 1;
    const body = {
      youtubeUrl: `https://youtu.be/${VALID_VIDEO_ID}`,
      nickname: "Alice",
      patronUuid: "99999999-9999-4999-8999-999999999999",
      mode: "sing",
    };
    fetchMock.mockResolvedValue(
      ytResponse({ items: [{ id: VALID_VIDEO_ID, status: { embeddable: false } }] }),
    );

    const res = await POST(makeRequest(body));
    expect(res.status).toBe(201);
    expect((await res.json()).warning).toBe(PT_WARNING);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("spends exactly ONE quota unit per checked paste (part=status videos.list)", async () => {
    const body = freshBody({ source: "paste" });
    fetchMock.mockResolvedValue(
      ytResponse({ items: [{ id: body.videoId, status: { embeddable: true } }] }),
    );
    await POST(makeRequest(body));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/youtube/v3/videos");
    expect(url.searchParams.get("part")).toBe("status");
    expect(url.searchParams.get("id")).toBe(body.videoId);
  });

  describe("a refused submit never reaches the check (no quota spent)", () => {
    it("validation failure (400) short-circuits before the pre-check", async () => {
      const res = await POST(makeRequest(freshBody({ source: "paste", videoId: "short" })));
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a rotation-rule refusal (409 duplicate) spends no quota", async () => {
      // Same uuid + same video twice: the second is refused by `checkSubmit`,
      // which runs BEFORE the pre-check. The first submit is a search-path
      // submit so it spends nothing either.
      const body = freshBody({ source: "search" });
      expect((await POST(makeRequest(body))).status).toBe(201);
      fetchMock.mockClear();

      const res = await POST(makeRequest({ ...body, source: "paste" }));
      expect(res.status).toBe(409);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("AC1c: the 202 moderation path also carries the warning (and stays trimmed)", async () => {
    // TICKET-44 moderation ON: the entry is diverted to the pending keyspace and
    // the route answers 202. The advisory must ride along there too.
    const { createRoom, setRoomModeration } = await import("@/lib/rooms");
    const created = await createRoom("Bar Embeddable 61");
    if (!created) throw new Error("room ceiling hit in test");
    await setRoomModeration(created.room.id, true);

    const body = freshBody({ source: "paste", room: created.room.id });
    fetchMock.mockResolvedValue(
      ytResponse({ items: [{ id: body.videoId, status: { embeddable: false } }] }),
    );

    const res = await POST(makeRequest(body));
    expect(res.status).toBe(202);

    const json = await res.json();
    expect(json.pending).toBe(true);
    expect(typeof json.pendingId).toBe("string");
    expect(json.warning).toBe(PT_WARNING);
    // Still trimmed: no echoed entry / patronUuid (TICKET-54).
    expect(Object.keys(json).sort()).toEqual(["pending", "pendingId", "warning"]);
  });
});
