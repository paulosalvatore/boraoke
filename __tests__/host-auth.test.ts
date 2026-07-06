/**
 * Host auth unit tests (TICKET-7, updated for per-room codes in TICKET-9).
 *
 * The token lookup is now async (the per-room host code lives in the room
 * store). The legacy `default` room still resolves from env `HOST_TOKEN`; real
 * rooms resolve from their own `hostCode`.
 */
import {
  DEV_FALLBACK_TOKEN,
  resolveRoomToken,
  isHostConfigured,
  verifyHostToken,
  issueSession,
  verifySessionValue,
  hostCookieName,
  HOST_COOKIE,
  isLoginThrottled,
  registerLoginFailure,
  resetLoginThrottle,
  _clearLoginThrottle,
} from "@/lib/host-auth";
import { createRoom, hashHostCode } from "@/lib/rooms";

/** Create a room in tests, asserting the ROOM_MAX ceiling didn't reject it. */
async function mustCreateRoom(name: string) {
  const created = await createRoom(name);
  if (!created) throw new Error("room ceiling hit in test");
  return created;
}

const ROOM = "default";
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("resolveRoomToken — legacy default room (env token)", () => {
  it("returns the configured HOST_TOKEN when set", async () => {
    process.env.HOST_TOKEN = "s3cr3t";
    expect(await resolveRoomToken(ROOM)).toBe("s3cr3t");
    expect(await isHostConfigured(ROOM)).toBe(true);
  });

  it("falls back to the dev token outside production when unset", async () => {
    delete process.env.HOST_TOKEN;
    process.env.NODE_ENV = "test";
    expect(await resolveRoomToken(ROOM)).toBe(DEV_FALLBACK_TOKEN);
    expect(await isHostConfigured(ROOM)).toBe(true);
  });

  it("is LOCKED (null) in production with no token", async () => {
    delete process.env.HOST_TOKEN;
    process.env.NODE_ENV = "production";
    expect(await resolveRoomToken(ROOM)).toBeNull();
    expect(await isHostConfigured(ROOM)).toBe(false);
  });

  it("prefers HOST_TOKEN over the dev fallback", async () => {
    process.env.NODE_ENV = "development";
    process.env.HOST_TOKEN = "real";
    expect(await resolveRoomToken(ROOM)).toBe("real");
  });
});

describe("resolveRoomToken — per-room host codes (TICKET-9)", () => {
  it("resolves a created room to its host-code HASH, ignoring env HOST_TOKEN", async () => {
    process.env.HOST_TOKEN = "global-env-token";
    const { room, hostCode } = await mustCreateRoom("Bar Teste");
    // Stored secret is the hash — never the raw code (security MEDIUM-2).
    expect(await resolveRoomToken(room.id)).toBe(hashHostCode(hostCode));
    expect(await resolveRoomToken(room.id)).not.toBe(hostCode);
    expect(hostCode).not.toBe("global-env-token");
  });

  it("verifies the RAW submitted host code against the stored hash", async () => {
    const { room, hostCode } = await mustCreateRoom("Bar Hash");
    expect(await verifyHostToken(room.id, hostCode)).toBe(true);
    expect(await verifyHostToken(room.id, "wrong-code")).toBe(false);
    // The hash itself must NOT work as a login token (no pass-the-hash).
    expect(await verifyHostToken(room.id, hashHostCode(hostCode))).toBe(false);
  });

  it("LOCKS an unknown non-default room even with a global env token set", async () => {
    process.env.HOST_TOKEN = "global-env-token";
    expect(await resolveRoomToken("no-such-room-xyz")).toBeNull();
    expect(await isHostConfigured("no-such-room-xyz")).toBe(false);
  });

  it("a session for room A does not verify for room B", async () => {
    const { room: a } = await mustCreateRoom("Bar A");
    const { room: b } = await mustCreateRoom("Bar B");
    const sessionA = await issueSession(a.id);
    expect(sessionA).toBeTruthy();
    expect(await verifySessionValue(a.id, sessionA)).toBe(true);
    expect(await verifySessionValue(b.id, sessionA)).toBe(false);
  });
});

describe("hostCookieName", () => {
  it("keeps the bare cookie name for the default room", () => {
    expect(hostCookieName("default")).toBe(HOST_COOKIE);
  });
  it("scopes the cookie name per room otherwise", () => {
    expect(hostCookieName("bar-do-ze-k7q2")).toBe(`${HOST_COOKIE}_bar-do-ze-k7q2`);
  });
});

describe("verifyHostToken", () => {
  beforeEach(() => {
    process.env.HOST_TOKEN = "correct-horse";
  });

  it("accepts the correct token", async () => {
    expect(await verifyHostToken(ROOM, "correct-horse")).toBe(true);
  });

  it("rejects a wrong token", async () => {
    expect(await verifyHostToken(ROOM, "wrong")).toBe(false);
  });

  it("rejects empty / non-string tokens", async () => {
    expect(await verifyHostToken(ROOM, "")).toBe(false);
    expect(await verifyHostToken(ROOM, undefined)).toBe(false);
    expect(await verifyHostToken(ROOM, 12345)).toBe(false);
    expect(await verifyHostToken(ROOM, null)).toBe(false);
  });

  it("rejects everything when locked in production", async () => {
    delete process.env.HOST_TOKEN;
    process.env.NODE_ENV = "production";
    expect(await verifyHostToken(ROOM, "anything")).toBe(false);
    expect(await verifyHostToken(ROOM, DEV_FALLBACK_TOKEN)).toBe(false);
  });
});

describe("session value round-trip", () => {
  beforeEach(() => {
    process.env.HOST_TOKEN = "correct-horse";
  });

  it("issues a session that verifies against the same token", async () => {
    const session = await issueSession(ROOM);
    expect(session).toBeTruthy();
    expect(await verifySessionValue(ROOM, session)).toBe(true);
  });

  it("does not leak the raw token in the session value", async () => {
    const session = (await issueSession(ROOM))!;
    expect(session).not.toContain("correct-horse");
  });

  it("rejects a tampered session value", async () => {
    const session = (await issueSession(ROOM))!;
    expect(await verifySessionValue(ROOM, session + "x")).toBe(false);
    expect(await verifySessionValue(ROOM, "")).toBe(false);
    expect(await verifySessionValue(ROOM, undefined)).toBe(false);
  });

  it("rejects a session minted for a different token", async () => {
    const session = (await issueSession(ROOM))!;
    process.env.HOST_TOKEN = "rotated";
    expect(await verifySessionValue(ROOM, session)).toBe(false);
  });

  it("returns null / rejects when locked in production", async () => {
    delete process.env.HOST_TOKEN;
    process.env.NODE_ENV = "production";
    expect(await issueSession(ROOM)).toBeNull();
    expect(await verifySessionValue(ROOM, "whatever")).toBe(false);
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
    registerLoginFailure("first-ip");
    for (let i = 0; i < 1000; i++) registerLoginFailure(`flood-${i}`);
    for (let i = 0; i < 9; i++) registerLoginFailure("first-ip");
    expect(isLoginThrottled("first-ip")).toBe(false);
  });
});
