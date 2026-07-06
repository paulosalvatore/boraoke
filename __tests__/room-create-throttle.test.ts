/**
 * Room-creation throttle unit tests (security HIGH-1, TICKET-9).
 * Same dual-bucket/LRU pattern as the TICKET-7 login throttle.
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
  it("trips at the limit", () => {
    const ip = "203.0.113.10";
    for (let i = 0; i < 3; i++) {
      expect(isRoomCreateThrottled(ip)).toBe(false);
      registerRoomCreation(ip);
    }
    expect(isRoomCreateThrottled(ip)).toBe(true);
  });

  it("expires the window after an hour", () => {
    jest.useFakeTimers();
    const ip = "203.0.113.11";
    for (let i = 0; i < 3; i++) registerRoomCreation(ip);
    expect(isRoomCreateThrottled(ip)).toBe(true);
    jest.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(isRoomCreateThrottled(ip)).toBe(false);
  });

  it("caps tracked IPs (LRU eviction, no unbounded growth)", () => {
    registerRoomCreation("first-ip");
    for (let i = 0; i < 1000; i++) registerRoomCreation(`flood-${i}`);
    // first-ip's original bucket was evicted by the flood; two fresh creations
    // start a new window — still under the limit.
    registerRoomCreation("first-ip");
    registerRoomCreation("first-ip");
    expect(isRoomCreateThrottled("first-ip")).toBe(false);
  });
});
