/**
 * Room-creation throttle unit tests (security HIGH-1, TICKET-9).
 *
 * The throttle now delegates to the shared `lib/rate-limit-counter` helper
 * (TICKET-52). These tests assert the SAME externally-observable properties as
 * before against the (now async) API: trips at the limit, resets after the 1h
 * window, the ROOM_CREATE_LIMIT env override is respected, and independent keys
 * do not cross-count. The memory path is byte-behavior identical to the prior
 * standalone Map/LRU (fixed window anchored at the first hit), so on Upstash the
 * same fixed-window semantics run cross-instance.
 */
import {
  isRoomCreateThrottled,
  registerRoomCreation,
  roomCreateLimit,
  _clearRoomCreateThrottle,
} from "@/lib/room-create-throttle";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => _clearRoomCreateThrottle());
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.useRealTimers();
});

describe("roomCreateLimit", () => {
  it("defaults to 3 and honors ROOM_CREATE_LIMIT", () => {
    delete process.env.ROOM_CREATE_LIMIT;
    expect(roomCreateLimit()).toBe(3);
    process.env.ROOM_CREATE_LIMIT = "10";
    expect(roomCreateLimit()).toBe(10);
    process.env.ROOM_CREATE_LIMIT = "junk";
    expect(roomCreateLimit()).toBe(3);
  });
});

describe("per-IP creation throttle", () => {
  it("trips at the limit", async () => {
    const ip = "203.0.113.10";
    for (let i = 0; i < 3; i++) {
      expect(await isRoomCreateThrottled(ip)).toBe(false);
      await registerRoomCreation(ip);
    }
    expect(await isRoomCreateThrottled(ip)).toBe(true);
  });

  it("respects a raised ROOM_CREATE_LIMIT (evaluated at call time)", async () => {
    process.env.ROOM_CREATE_LIMIT = "5";
    const ip = "203.0.113.12";
    for (let i = 0; i < 5; i++) {
      expect(await isRoomCreateThrottled(ip)).toBe(false);
      await registerRoomCreation(ip);
    }
    expect(await isRoomCreateThrottled(ip)).toBe(true);
  });

  it("expires the window after an hour", async () => {
    jest.useFakeTimers();
    const ip = "203.0.113.11";
    for (let i = 0; i < 3; i++) await registerRoomCreation(ip);
    expect(await isRoomCreateThrottled(ip)).toBe(true);
    jest.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(await isRoomCreateThrottled(ip)).toBe(false);
  });

  it("keeps independent IPs from cross-counting", async () => {
    const a = "203.0.113.20";
    const b = "203.0.113.21";
    for (let i = 0; i < 3; i++) await registerRoomCreation(a);
    // `a` is exhausted; `b` has its own untouched budget.
    expect(await isRoomCreateThrottled(a)).toBe(true);
    expect(await isRoomCreateThrottled(b)).toBe(false);
    await registerRoomCreation(b);
    expect(await isRoomCreateThrottled(b)).toBe(false);
  });
});
