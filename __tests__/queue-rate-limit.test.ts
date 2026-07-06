/**
 * TICKET-10 (security MEDIUM-1 track 2) — submit rate limiter: unit tests for
 * the dual-bucket window plus route-level tests that the 429 + pt-BR copy fire
 * on POST /api/queue and that over-limit callers never reach the store.
 */
import { NextRequest } from "next/server";
import {
  submitRateLimitOk,
  SUBMIT_RATE_UUID_MAX,
  SUBMIT_RATE_IP_MAX,
  SUBMIT_RATE_WINDOW_MS,
  SUBMIT_RATE_MESSAGE,
  _resetSubmitRateLimit,
} from "@/lib/queue-rate-limit";
import { store, DEFAULT_ROOM } from "@/lib/store";
import { POST } from "@/app/api/queue/route";

beforeEach(async () => {
  _resetSubmitRateLimit();
  await store.clear(DEFAULT_ROOM);
});

describe("submitRateLimitOk (unit)", () => {
  const NOW = 1_000_000;

  it("allows up to the uuid cap, then trips", () => {
    for (let i = 0; i < SUBMIT_RATE_UUID_MAX; i++) {
      expect(submitRateLimitOk("u1", "1.1.1.1", NOW + i)).toBe(true);
    }
    expect(submitRateLimitOk("u1", "1.1.1.1", NOW + 50)).toBe(false);
    // a different uuid on the same IP is still fine (IP cap is higher)
    expect(submitRateLimitOk("u2", "1.1.1.1", NOW + 51)).toBe(true);
  });

  it("uuid bucket frees after the window slides", () => {
    for (let i = 0; i < SUBMIT_RATE_UUID_MAX; i++) {
      submitRateLimitOk("u1", "", NOW + i);
    }
    expect(submitRateLimitOk("u1", "", NOW + 100)).toBe(false);
    expect(submitRateLimitOk("u1", "", NOW + SUBMIT_RATE_WINDOW_MS + 101)).toBe(true);
  });

  it("IP bucket trips across rotating uuids (rotation can't dodge it)", () => {
    for (let i = 0; i < SUBMIT_RATE_IP_MAX; i++) {
      expect(submitRateLimitOk(`rot-${i}`, "9.9.9.9", NOW + i)).toBe(true);
    }
    expect(submitRateLimitOk("rot-fresh", "9.9.9.9", NOW + 500)).toBe(false);
  });
});

describe("POST /api/queue rate limiting (route)", () => {
  function makeReq(uuid: string, i: number, ip = "8.8.8.8"): NextRequest {
    return new NextRequest("http://127.0.0.1:3040/api/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({
        videoId: "dQw4w9WgXcQ",
        title: `Song ${i}`,
        nickname: "Speedy",
        patronUuid: uuid,
        mode: "listen-dance", // listen: generous pending cap won't interfere first
      }),
    });
  }

  it("429s with the friendly pt-BR message past the per-uuid cap and stores nothing extra", async () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    let lastOkCount = 0;
    for (let i = 0; i < SUBMIT_RATE_UUID_MAX + 1; i++) {
      const res = await POST(makeReq(uuid, i));
      if (i < SUBMIT_RATE_UUID_MAX) {
        // listen anti-spam (3 pending) may 409 later submits — both are fine;
        // the point is none of the first N are RATE-limited.
        expect([201, 409]).toContain(res.status);
        if (res.status === 201) lastOkCount++;
      } else {
        expect(res.status).toBe(429);
        const body = await res.json();
        expect(body.reason).toBe("rate");
        expect(body.error).toBe(SUBMIT_RATE_MESSAGE);
      }
    }
    // over-limit call added nothing
    expect((await store.getQueue(DEFAULT_ROOM)).length).toBe(lastOkCount);
  });

  it("malformed submissions (bad uuid) do not charge the rate bucket", async () => {
    const bad = new NextRequest("http://127.0.0.1:3040/api/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "7.7.7.7" },
      body: JSON.stringify({
        videoId: "dQw4w9WgXcQ",
        nickname: "x",
        patronUuid: "not-a-uuid",
        mode: "sing",
      }),
    });
    for (let i = 0; i < SUBMIT_RATE_IP_MAX + 5; i++) {
      expect((await POST(bad.clone() as unknown as NextRequest)).status).toBe(400);
    }
    // a well-formed submit from the same IP still passes (bucket unburned)
    const ok = await POST(makeReq("123e4567-e89b-42d3-a456-426614174000", 0, "7.7.7.7"));
    expect(ok.status).toBe(201);
  });
});
