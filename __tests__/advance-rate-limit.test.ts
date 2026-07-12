/**
 * TICKET-45 — per-room advance rate limiter: unit tests for the dual-bucket
 * (per-room) sliding window, plus a route-level check that an over-limit advance
 * gets a 429 and never reaches the store.
 */
import { NextRequest } from "next/server";
import {
  advanceRateLimitOk,
  ADVANCE_RATE_ROOM_MAX,
  ADVANCE_RATE_UNPLAYABLE_ROOM_MAX,
  ADVANCE_RATE_WINDOW_MS,
  _resetAdvanceRateLimit,
} from "@/lib/advance-rate-limit";
import { store, DEFAULT_ROOM } from "@/lib/store";
import { POST } from "@/app/api/queue/advance/route";
import { mintScreenToken, SCREEN_TOKEN_HEADER } from "@/lib/screen-token";

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  _resetAdvanceRateLimit();
  await store.clear(DEFAULT_ROOM);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("advanceRateLimitOk (unit)", () => {
  const NOW = 2_000_000;

  it("allows up to the per-room cap, then trips", () => {
    for (let i = 0; i < ADVANCE_RATE_ROOM_MAX; i++) {
      expect(advanceRateLimitOk("roomA", NOW + i)).toBe(true);
    }
    expect(advanceRateLimitOk("roomA", NOW + 50)).toBe(false);
  });

  it("buckets are independent per room", () => {
    for (let i = 0; i < ADVANCE_RATE_ROOM_MAX; i++) {
      advanceRateLimitOk("roomA", NOW + i);
    }
    expect(advanceRateLimitOk("roomA", NOW + 50)).toBe(false);
    // a different room is unaffected
    expect(advanceRateLimitOk("roomB", NOW + 51)).toBe(true);
  });

  it("frees after the window slides", () => {
    for (let i = 0; i < ADVANCE_RATE_ROOM_MAX; i++) {
      advanceRateLimitOk("roomA", NOW + i);
    }
    expect(advanceRateLimitOk("roomA", NOW + 100)).toBe(false);
    expect(advanceRateLimitOk("roomA", NOW + ADVANCE_RATE_WINDOW_MS + 101)).toBe(true);
  });

  // ── TICKET-47: two-bucket split ────────────────────────────────────────────

  it("non-unplayable bucket ceiling is EXACTLY 12, then trips (unchanged)", () => {
    expect(ADVANCE_RATE_ROOM_MAX).toBe(12);
    for (let i = 0; i < 12; i++) {
      expect(advanceRateLimitOk("roomA", { unplayable: false }, NOW + i)).toBe(true);
    }
    // the 13th non-unplayable advance in-window still 429s
    expect(advanceRateLimitOk("roomA", { unplayable: false }, NOW + 50)).toBe(false);
  });

  it("unplayable bucket allows ≥13 (past the old 12 cap), trips past its higher ceiling", () => {
    expect(ADVANCE_RATE_UNPLAYABLE_ROOM_MAX).toBe(40);
    // 13 consecutive unplayable drains no longer wedge (old cap was 12)
    for (let i = 0; i < 13; i++) {
      expect(advanceRateLimitOk("roomA", { unplayable: true }, NOW + i)).toBe(true);
    }
    // fill the rest of the unplayable bucket up to its ceiling
    for (let i = 13; i < ADVANCE_RATE_UNPLAYABLE_ROOM_MAX; i++) {
      expect(advanceRateLimitOk("roomA", { unplayable: true }, NOW + i)).toBe(true);
    }
    // one past the ceiling trips
    expect(advanceRateLimitOk("roomA", { unplayable: true }, NOW + 100)).toBe(false);
  });

  it("the two buckets are independent — exhausting one leaves the other free", () => {
    // exhaust the singer-skip bucket
    for (let i = 0; i < ADVANCE_RATE_ROOM_MAX; i++) {
      advanceRateLimitOk("roomA", { unplayable: false }, NOW + i);
    }
    expect(advanceRateLimitOk("roomA", { unplayable: false }, NOW + 50)).toBe(false);
    // unplayable bucket for the SAME room is untouched
    expect(advanceRateLimitOk("roomA", { unplayable: true }, NOW + 51)).toBe(true);

    // conversely: exhaust the unplayable bucket on a fresh room
    for (let i = 0; i < ADVANCE_RATE_UNPLAYABLE_ROOM_MAX; i++) {
      advanceRateLimitOk("roomB", { unplayable: true }, NOW + i);
    }
    expect(advanceRateLimitOk("roomB", { unplayable: true }, NOW + 50)).toBe(false);
    // singer-skip bucket for roomB still free
    expect(advanceRateLimitOk("roomB", { unplayable: false }, NOW + 51)).toBe(true);
  });

  it("legacy 2-arg call (roomId, now) still charges the singer-skip bucket", () => {
    for (let i = 0; i < ADVANCE_RATE_ROOM_MAX; i++) {
      expect(advanceRateLimitOk("roomA", NOW + i)).toBe(true);
    }
    expect(advanceRateLimitOk("roomA", NOW + 50)).toBe(false);
    // proves it charged the singer-skip bucket, not the unplayable one
    expect(advanceRateLimitOk("roomA", { unplayable: true }, NOW + 51)).toBe(true);
  });
});

describe("POST /api/queue/advance rate limiting (route)", () => {
  async function authedAdvance(reason?: string): Promise<NextRequest> {
    const token = await mintScreenToken(DEFAULT_ROOM);
    const url = reason
      ? `http://127.0.0.1:3045/api/queue/advance?reason=${reason}`
      : "http://127.0.0.1:3045/api/queue/advance";
    return new NextRequest(url, {
      method: "POST",
      headers: token ? { [SCREEN_TOKEN_HEADER]: token } : {},
    });
  }

  it("429s once the room exceeds its per-minute advance cap", async () => {
    // dev-fallback secret so the token authorizes; enforce mode so auth is real.
    delete process.env.HOST_TOKEN;
    process.env.NODE_ENV = "test";
    process.env.ADVANCE_AUTH = "enforce";

    let saw429 = false;
    for (let i = 0; i < ADVANCE_RATE_ROOM_MAX + 2; i++) {
      const res = await POST(await authedAdvance());
      if (res.status === 429) {
        saw429 = true;
        const body = await res.json();
        expect(body.reason).toBe("rate");
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(saw429).toBe(true);
  });

  it("charges a reason=unplayable advance to the unplayable bucket, not the singer-skip one (TICKET-47)", async () => {
    delete process.env.HOST_TOKEN;
    process.env.NODE_ENV = "test";
    process.env.ADVANCE_AUTH = "enforce";

    // 13 consecutive unplayable advances — past the old 12 singer-skip cap.
    // Under the two-bucket split these all succeed (unplayable ceiling is 40),
    // proving they are NOT charged to the singer-skip bucket.
    for (let i = 0; i < 13; i++) {
      const res = await POST(await authedAdvance("unplayable"));
      expect(res.status).toBe(200);
    }

    // The singer-skip bucket is untouched: a full run of 12 non-unplayable
    // advances still all succeed, then the 13th 429s — exactly 12/60s intact.
    for (let i = 0; i < ADVANCE_RATE_ROOM_MAX; i++) {
      const res = await POST(await authedAdvance());
      expect(res.status).toBe(200);
    }
    const overLimit = await POST(await authedAdvance());
    expect(overLimit.status).toBe(429);
    expect((await overLimit.json()).reason).toBe("rate");
  });

  // ── TICKET-51 (TICKET-47 FU-2): junk/non-allowlisted reason → STRICT bucket ──
  // The advance route allowlists reasons to `"unplayable"` only; ANY other value
  // resolves to skipReason=null and is charged to the anti-grief singer-skip
  // bucket (12/60s), NOT the generous unplayable bucket (40/60s). This is the
  // fail-safe: a forger cannot bypass the throttle by sending a junk reason.
  it("charges a junk/non-allowlisted reason to the STRICT singer-skip bucket (12/60s), not the generous unplayable bucket (TICKET-51)", async () => {
    delete process.env.HOST_TOKEN;
    process.env.NODE_ENV = "test";
    process.env.ADVANCE_AUTH = "enforce";

    // A non-allowlisted reason ("bogus") must be counted against the STRICT
    // bucket: exactly 12 succeed in-window, then the 13th 429s — the same
    // 12/60s anti-grief ceiling as a reasonless advance. If junk reasons were
    // (mis)routed to the generous unplayable bucket, all 13 would succeed.
    for (let i = 0; i < ADVANCE_RATE_ROOM_MAX; i++) {
      const res = await POST(await authedAdvance("bogus"));
      expect(res.status).toBe(200);
    }
    const overLimit = await POST(await authedAdvance("bogus"));
    expect(overLimit.status).toBe(429);
    expect((await overLimit.json()).reason).toBe("rate");
  });

  it("junk-reason advances SHARE the strict bucket with reasonless advances — a run of junk exhausts the singer-skip cap (TICKET-51)", async () => {
    delete process.env.HOST_TOKEN;
    process.env.NODE_ENV = "test";
    process.env.ADVANCE_AUTH = "enforce";

    // Interleave junk-reason and reasonless advances: because both resolve to
    // skipReason=null they charge the SAME strict bucket. Twelve combined
    // succeed; the 13th (regardless of reason) 429s. This proves junk reasons
    // do NOT get their own allowance and do NOT leak into the unplayable bucket.
    const junkReasons = ["junk", "", "skip", "griefer", "unplayable-ish", "advance"];
    for (let i = 0; i < ADVANCE_RATE_ROOM_MAX; i++) {
      // alternate: half junk, half reasonless — all strict-bucket
      const req =
        i % 2 === 0
          ? await authedAdvance(junkReasons[i % junkReasons.length])
          : await authedAdvance();
      const res = await POST(req);
      expect(res.status).toBe(200);
    }
    const overLimit = await POST(await authedAdvance("junk"));
    expect(overLimit.status).toBe(429);
    expect((await overLimit.json()).reason).toBe("rate");

    // Proof the junk run did NOT touch the unplayable bucket: it is still fully
    // free — a reason=unplayable advance in the SAME room/window still succeeds.
    const stillOk = await POST(await authedAdvance("unplayable"));
    expect(stillOk.status).toBe(200);
  });
});
