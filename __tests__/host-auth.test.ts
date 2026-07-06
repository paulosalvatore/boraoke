/**
 * Host auth unit tests (TICKET-7).
 *
 * Covers the token/session model and the production-locked / dev-fallback
 * branches. `resolveRoomToken` reads env at call time, so mutating
 * process.env between cases is enough.
 */
import {
  DEV_FALLBACK_TOKEN,
  resolveRoomToken,
  isHostConfigured,
  verifyHostToken,
  issueSession,
  verifySessionValue,
  isLoginThrottled,
  registerLoginFailure,
  resetLoginThrottle,
  _clearLoginThrottle,
} from "@/lib/host-auth";

const ROOM = "default";
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("resolveRoomToken", () => {
  it("returns the configured HOST_TOKEN when set", () => {
    process.env.HOST_TOKEN = "s3cr3t";
    expect(resolveRoomToken(ROOM)).toBe("s3cr3t");
    expect(isHostConfigured(ROOM)).toBe(true);
  });

  it("falls back to the dev token outside production when unset", () => {
    delete process.env.HOST_TOKEN;
    process.env.NODE_ENV = "test";
    expect(resolveRoomToken(ROOM)).toBe(DEV_FALLBACK_TOKEN);
    expect(isHostConfigured(ROOM)).toBe(true);
  });

  it("is LOCKED (null) in production with no token", () => {
    delete process.env.HOST_TOKEN;
    process.env.NODE_ENV = "production";
    expect(resolveRoomToken(ROOM)).toBeNull();
    expect(isHostConfigured(ROOM)).toBe(false);
  });

  it("prefers HOST_TOKEN over the dev fallback", () => {
    process.env.NODE_ENV = "development";
    process.env.HOST_TOKEN = "real";
    expect(resolveRoomToken(ROOM)).toBe("real");
  });
});

describe("verifyHostToken", () => {
  beforeEach(() => {
    process.env.HOST_TOKEN = "correct-horse";
  });

  it("accepts the correct token", () => {
    expect(verifyHostToken(ROOM, "correct-horse")).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(verifyHostToken(ROOM, "wrong")).toBe(false);
  });

  it("rejects empty / non-string tokens", () => {
    expect(verifyHostToken(ROOM, "")).toBe(false);
    expect(verifyHostToken(ROOM, undefined)).toBe(false);
    expect(verifyHostToken(ROOM, 12345)).toBe(false);
    expect(verifyHostToken(ROOM, null)).toBe(false);
  });

  it("rejects everything when locked in production", () => {
    delete process.env.HOST_TOKEN;
    process.env.NODE_ENV = "production";
    expect(verifyHostToken(ROOM, "anything")).toBe(false);
    expect(verifyHostToken(ROOM, DEV_FALLBACK_TOKEN)).toBe(false);
  });
});

describe("session value round-trip", () => {
  beforeEach(() => {
    process.env.HOST_TOKEN = "correct-horse";
  });

  it("issues a session that verifies against the same token", () => {
    const session = issueSession(ROOM);
    expect(session).toBeTruthy();
    expect(verifySessionValue(ROOM, session)).toBe(true);
  });

  it("does not leak the raw token in the session value", () => {
    const session = issueSession(ROOM)!;
    expect(session).not.toContain("correct-horse");
  });

  it("rejects a tampered session value", () => {
    const session = issueSession(ROOM)!;
    expect(verifySessionValue(ROOM, session + "x")).toBe(false);
    expect(verifySessionValue(ROOM, "")).toBe(false);
    expect(verifySessionValue(ROOM, undefined)).toBe(false);
  });

  it("rejects a session minted for a different token", () => {
    const session = issueSession(ROOM)!;
    process.env.HOST_TOKEN = "rotated";
    expect(verifySessionValue(ROOM, session)).toBe(false);
  });

  it("returns null / rejects when locked in production", () => {
    delete process.env.HOST_TOKEN;
    process.env.NODE_ENV = "production";
    expect(issueSession(ROOM)).toBeNull();
    expect(verifySessionValue(ROOM, "whatever")).toBe(false);
  });
});

describe("login throttle helpers (security M-1)", () => {
  beforeEach(() => _clearLoginThrottle());
  afterEach(() => jest.useRealTimers());

  it("trips at the failure cap and resets explicitly", () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < 10; i++) {
      expect(isLoginThrottled(ip)).toBe(false);
      registerLoginFailure(ip);
    }
    expect(isLoginThrottled(ip)).toBe(true);
    resetLoginThrottle(ip);
    expect(isLoginThrottled(ip)).toBe(false);
  });

  it("expires the window after 60s", () => {
    jest.useFakeTimers();
    const ip = "203.0.113.51";
    for (let i = 0; i < 10; i++) registerLoginFailure(ip);
    expect(isLoginThrottled(ip)).toBe(true);
    jest.advanceTimersByTime(60_001);
    expect(isLoginThrottled(ip)).toBe(false);
  });

  it("caps tracked IPs (LRU eviction, no unbounded growth)", () => {
    // Fill beyond the 1000-IP cap; the oldest bucket gets evicted.
    registerLoginFailure("first-ip");
    for (let i = 0; i < 1000; i++) registerLoginFailure(`flood-${i}`);
    for (let i = 0; i < 9; i++) registerLoginFailure("first-ip");
    // 10 total failures for first-ip, but its original bucket was evicted by
    // the flood, so it restarted counting — still not throttled at 9-in-window.
    expect(isLoginThrottled("first-ip")).toBe(false);
  });
});
