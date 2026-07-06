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
