/**
 * A host-code login flood must not cost a room its owner pin. Covers the three
 * mechanisms: the cap on successful claim mints (per IP and per room, owner
 * exempt), jittered backoff with per-caller attempt bounds in `mutateRoom`, and a
 * revoke fallback owner mint that survives a flood that kills an ordinary mint.
 * The real-Redis flood measurement is in host-login-flood.integration.test.ts.
 */
import { NextRequest } from "next/server";
import { createHmac } from "crypto";
import {
  LOGIN_MINT_LIMITS,
  _clearLoginThrottle,
  claimCookieName,
  hostCookieName,
  issueSession,
} from "@/lib/host-auth";
import { POST as loginRoute } from "@/app/api/host/login/route";
import { POST as revokeRoute } from "@/app/api/host/revoke-sessions/route";
import {
  NON_OWNER_MINT_ATTEMPTS,
  OWNER_MINT_FENCED_ATTEMPTS,
  OWNER_MINT_OPEN_ATTEMPTS,
  ROOM_BACKOFF_CAP_MS,
  ROOM_WRITE_ATTEMPTS,
  createRoom,
  getRoom,
  issueRoomClaimToken,
  roomBackend,
  roomRetryDelayMs,
  setRoomMode,
  verifyRoomClaimToken,
} from "@/lib/rooms";

const claimHash = (t: string) => createHmac("sha256", "boraoke-claim-token-v1").update(t).digest("hex");

let n = 0;
async function room() {
  const created = await createRoom(`Bar Flood 158 ${++n}`);
  if (!created) throw new Error("room ceiling hit in test");
  return created;
}

function loginReq(roomId: string, hostCode: string, ip: string, claimToken?: string): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-forwarded-for": ip };
  if (claimToken) headers.cookie = `${claimCookieName(roomId)}=${claimToken}`;
  return new NextRequest(`http://127.0.0.1:3040/api/host/login?room=${roomId}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ token: hostCode }),
  });
}

function cookieOf(res: Response, name: string): string | undefined {
  const m = new RegExp(`${name}=([^;]+)`).exec(res.headers.get("set-cookie") ?? "");
  return m?.[1];
}

/** Retries sleep for no real time; the delays are recorded. */
function instantBackoff(): number[] {
  const delays: number[] = [];
  jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
  return delays;
}

beforeEach(() => _clearLoginThrottle());
afterEach(() => jest.restoreAllMocks());

describe("the cap on successful logins that mint a claim token", () => {
  it("refuses a single IP past its mint budget, with the failure throttle's own status and copy", async () => {
    const { room: r, hostCode } = await room();
    const ip = "198.51.100.158";
    for (let i = 0; i < LOGIN_MINT_LIMITS.perIp; i++) {
      expect((await loginRoute(loginReq(r.id, hostCode, ip))).status).toBe(200);
    }
    const update = jest.spyOn(roomBackend, "update");
    const refused = await loginRoute(loginReq(r.id, hostCode, ip));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "Too many failed attempts — try again in a minute." });
    expect(update).not.toHaveBeenCalled(); // refused before the store, no claim minted
    expect(cookieOf(refused, claimCookieName(r.id))).toBeUndefined();
  });

  it("caps the room across many IPs, so a distributed flood is bounded too", async () => {
    const { room: r, hostCode } = await room();
    let ok = 0;
    for (let i = 0; i < LOGIN_MINT_LIMITS.perRoom + 20; i++) {
      const res = await loginRoute(loginReq(r.id, hostCode, `198.51.100.${(i % 200) + 1}`));
      if (res.status === 200) ok++;
      else expect(res.status).toBe(429);
    }
    expect(ok).toBe(LOGIN_MINT_LIMITS.perRoom);
  });

  it("one IP cannot spend the room's shared budget past its own cap", async () => {
    const { room: r, hostCode } = await room();
    for (let i = 0; i < LOGIN_MINT_LIMITS.perIp + 40; i++) await loginRoute(loginReq(r.id, hostCode, "198.51.100.77"));
    // A different address still has the rest of the room's budget.
    expect((await loginRoute(loginReq(r.id, hostCode, "198.51.100.78"))).status).toBe(200);
  });

  it("never throttles a request presenting the live owner token, however many it sends", async () => {
    const { room: r, hostCode } = await room();
    const owner = (await issueRoomClaimToken(r.id, { owner: true }))!;
    const ip = "198.51.100.90";
    // Exhaust both budgets first.
    for (let i = 0; i < LOGIN_MINT_LIMITS.perRoom + 5; i++) await loginRoute(loginReq(r.id, hostCode, ip));
    expect((await loginRoute(loginReq(r.id, hostCode, ip))).status).toBe(429);
    for (let i = 0; i < 60; i++) {
      const res = await loginRoute(loginReq(r.id, hostCode, ip, owner));
      expect(res.status).toBe(200);
      expect((await res.json()).owner).toBe(true);
    }
    expect(await verifyRoomClaimToken(r.id, owner)).toBe(true);
  });

  it("a returning device with a live NON-owner claim token mints nothing and is never charged either", async () => {
    const { room: r, hostCode } = await room();
    const ip = "198.51.100.93";
    for (let i = 0; i < LOGIN_MINT_LIMITS.perRoom + 5; i++) await loginRoute(loginReq(r.id, hostCode, ip));
    expect((await loginRoute(loginReq(r.id, hostCode, ip))).status).toBe(429);
    const live = (await issueRoomClaimToken(r.id))!;
    const res = await loginRoute(loginReq(r.id, hostCode, ip, live));
    expect(res.status).toBe(200);
    expect((await res.json()).owner).toBe(false);
  });

  it("the legacy default room mints nothing, so it is never charged", async () => {
    const { chargeLoginMint } = await import("@/lib/host-auth");
    for (let i = 0; i < LOGIN_MINT_LIMITS.perRoom + 20; i++) expect(await chargeLoginMint("198.51.100.94", "default")).toBe(true);
  });

  it("a plain code login never takes the owner pin, capped or not", async () => {
    const { room: r, hostCode } = await room();
    // Room without a pin (as after a lost pin).
    const res = await loginRoute(loginReq(r.id, hostCode, "198.51.100.91"));
    expect(res.status).toBe(200);
    expect((await res.json()).owner).toBe(false);
    const after = (await getRoom(r.id))!;
    expect(after.ownerClaimTokenHash).toBeUndefined();
    expect(after.claimTokenHashes).toContain(claimHash(cookieOf(res, claimCookieName(r.id))!));
  });

  it("charges only the mint path: a wrong code is a failure, not a mint", async () => {
    const { room: r } = await room();
    const res = await loginRoute(loginReq(r.id, "not-the-code", "198.51.100.92"));
    expect(res.status).toBe(401);
  });
});

describe("jittered exponential backoff in mutateRoom", () => {
  it("roomRetryDelayMs doubles up to the cap and stays inside [0, ceiling)", () => {
    expect(roomRetryDelayMs(1, () => 0)).toBe(0);
    const top = (retry: number) => roomRetryDelayMs(retry, () => 0.999999);
    expect(top(1)).toBeLessThan(4);
    expect(top(2)).toBeGreaterThan(top(1));
    expect(top(3)).toBeGreaterThan(top(2));
    expect(top(40)).toBe(ROOM_BACKOFF_CAP_MS - 1);
    for (let retry = 1; retry < 40; retry++) {
      const d = roomRetryDelayMs(retry);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(ROOM_BACKOFF_CAP_MS);
    }
  });

  it("a conflicted write sleeps before each retry and never before the first attempt", async () => {
    const { room: r } = await room();
    const delays = instantBackoff();
    jest.spyOn(roomBackend, "update").mockImplementation(async () => "conflict");
    await expect(setRoomMode(r.id, "per-table-2")).rejects.toThrow(/did not commit/);
    // At most one sleep between each pair of attempts (a zero draw skips its sleep).
    expect(delays.length).toBeGreaterThan(ROOM_WRITE_ATTEMPTS / 2);
    expect(delays.length).toBeLessThanOrEqual(ROOM_WRITE_ATTEMPTS - 1);
    expect(Math.max(...delays)).toBeLessThan(ROOM_BACKOFF_CAP_MS);
    expect(Math.max(...delays)).toBeGreaterThan(0);
  });

  it("an uncontended write does not sleep at all", async () => {
    const { room: r } = await room();
    const delays = instantBackoff();
    await setRoomMode(r.id, "per-table-2");
    expect(delays).toEqual([]);
  });

  it("an ordinary mint gives up sooner than an owner mint, and settings keep the full bound", async () => {
    const { room: r } = await room();
    instantBackoff();
    const spy = jest.spyOn(roomBackend, "update").mockImplementation(async () => "conflict");
    expect(await issueRoomClaimToken(r.id)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(NON_OWNER_MINT_ATTEMPTS);
    spy.mockClear();
    expect(await issueRoomClaimToken(r.id, { owner: true })).toBeNull();
    expect(spy).toHaveBeenCalledTimes(OWNER_MINT_OPEN_ATTEMPTS + OWNER_MINT_FENCED_ATTEMPTS);
    expect(NON_OWNER_MINT_ATTEMPTS).toBeLessThan(ROOM_WRITE_ATTEMPTS);
  });
});

describe("the revoke's fallback owner mint under a flood", () => {
  /**
   * A flood, modelled as a writer that commits to the room between every other
   * writer's read and write: every NON-priority compare-and-set loses, forever.
   * A write that carries the owner-mint fence is the only one that can get through.
   */
  function floodedBackend() {
    const original = roomBackend.update.bind(roomBackend);
    return jest.spyOn(roomBackend, "update").mockImplementation(async (rec, opts) => {
      if (!opts?.priority) return "conflict";
      return original(rec, opts);
    });
  }

  it("commits the owner pin when the rebind and every open attempt lose", async () => {
    instantBackoff();
    const { room: r } = await room();
    const owner = (await issueRoomClaimToken(r.id, { owner: true }))!;
    const session = (await issueSession(r.id))!;
    floodedBackend();
    const res = await revokeRoute(
      new NextRequest(`http://127.0.0.1:3040/api/host/revoke-sessions?room=${r.id}`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:3040",
          cookie: `${hostCookieName(r.id)}=${session}; ${claimCookieName(r.id)}=${owner}`,
        },
      }),
    );
    expect(res.status).toBe(200);
    const minted = cookieOf(res, claimCookieName(r.id));
    expect(minted).toBeTruthy();
    expect(minted).not.toBe(owner);
    expect((await getRoom(r.id))!.ownerClaimTokenHash).toBe(claimHash(minted!));
    expect(await verifyRoomClaimToken(r.id, minted)).toBe(true);
  });

  it("the fence is raised only after the open attempts lose, and never for an uncontended owner mint", async () => {
    instantBackoff();
    const { room: r } = await room();
    const hold = jest.spyOn(roomBackend, "holdFence");
    expect(await issueRoomClaimToken(r.id, { owner: true })).toBeTruthy();
    expect(hold).not.toHaveBeenCalled();
    floodedBackend();
    expect(await issueRoomClaimToken(r.id, { owner: true })).toBeTruthy();
    expect(hold).toHaveBeenCalledTimes(1);
  });

  it("an ordinary mint is refused while the fence is up, and the fence is released afterwards", async () => {
    instantBackoff();
    const { room: r } = await room();
    await roomBackend.holdFence(r.id, 60_000);
    expect(await issueRoomClaimToken(r.id)).toBeNull();
    expect(await setRoomMode(r.id, "per-table-2").catch((e) => e)).toBeInstanceOf(Error);
    await roomBackend.releaseFence(r.id);
    expect(await issueRoomClaimToken(r.id)).toBeTruthy();

    // An owner mint under a flood raises the fence and always lowers it.
    const flooded = floodedBackend();
    expect(await issueRoomClaimToken(r.id, { owner: true })).toBeTruthy();
    flooded.mockRestore();
    expect(await issueRoomClaimToken(r.id)).toBeTruthy(); // fence is gone, ordinary writers are back
  });

  it("a plain code login on a pin-less room under the fence never becomes the owner", async () => {
    const { room: r } = await room();
    const token = (await issueRoomClaimToken(r.id))!;
    expect((await getRoom(r.id))!.ownerClaimTokenHash).toBeUndefined();
    expect(await verifyRoomClaimToken(r.id, token)).toBe(true);
  });
});
