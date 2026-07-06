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
      const res = await POST(makeRequest(validBody()));
      expect(res.status).toBe(429);
      expect(await store.getQueue(DEFAULT_ROOM)).toHaveLength(QUEUE_MAX);
    });
  });
});
