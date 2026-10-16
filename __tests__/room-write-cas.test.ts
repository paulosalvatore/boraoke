/**
 * TICKET-127 — the compare-and-set contract itself, and what each caller does
 * when a write cannot commit. The pair-by-pair interleavings live in
 * room-write-race.test.ts; the real Lua runs in room-cas-lua.integration.test.ts.
 */
import { NextRequest } from "next/server";
import {
  claimCookieName,
  hostCookieName,
  issueSession,
  requireHost,
  verifySessionValue,
} from "@/lib/host-auth";
import { POST as claimRoute } from "@/app/api/host/claim/route";
import { GET as sessionProbe, POST as logoutRoute } from "@/app/api/host/session/route";
import { POST as modeRoute } from "@/app/api/host/mode/route";
import {
  ROOM_WRITE_ATTEMPTS,
  RoomWriteConflictError,
  createRoom,
  getRoom,
  getRoomMode,
  issueRoomClaimToken,
  normaliseRoomRev,
  revokeRoomClaimToken,
  roomBackend,
  setRoomLanguage,
  setRoomMode,
  setRoomModeration,
  verifyRoomClaimToken,
  type Room,
} from "@/lib/rooms";

let n = 0;
async function room(): Promise<{ id: string; hostCode: string }> {
  const created = await createRoom(`Bar Cas 127 ${++n}`);
  if (!created) throw new Error("room ceiling hit in test");
  return { id: created.room.id, hostCode: created.hostCode };
}

function hostReq(path: string, roomId: string, cookies: Record<string, string>, init: RequestInit = {}) {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest(`http://127.0.0.1:3040${path}?room=${encodeURIComponent(roomId)}`, {
    ...init,
    headers: { host: "127.0.0.1:3040", "x-forwarded-for": "203.0.113.127", cookie, ...(init.headers ?? {}) },
  } as ConstructorParameters<typeof NextRequest>[1]);
}

/** Every compare-and-set write reports a conflict, as if another write always committed first. */
function alwaysConflict() {
  return jest.spyOn(roomBackend, "update").mockImplementation(async () => "conflict");
}

afterEach(() => jest.restoreAllMocks());

describe("the memory backend's compare-and-set", () => {
  it("a legacy record (no rev) reads as revision 0 and its first write stamps 1", async () => {
    const r = await room();
    const before = (await getRoom(r.id))!;
    expect(before.rev).toBeUndefined();
    expect(normaliseRoomRev(before.rev)).toBe(0);
    expect(await roomBackend.update({ ...before, name: "x" })).toBe("ok");
    expect((await getRoom(r.id))!.rev).toBe(1);
  });

  it("refuses a write from an older snapshot and leaves the record as the newer write left it", async () => {
    const r = await room();
    const a = (await getRoom(r.id))!;
    const b = (await getRoom(r.id))!;
    expect(await roomBackend.update({ ...a, name: "A" })).toBe("ok");
    expect(await roomBackend.update({ ...b, name: "B" })).toBe("conflict");
    expect((await getRoom(r.id))!).toMatchObject({ name: "A", rev: 1 });
  });

  it("never creates a record", async () => {
    const ghost: Room = {
      id: "nao-existe-127",
      name: "x",
      hostCodeHash: "h",
      createdAt: "2026-10-16T00:00:00.000Z",
      settings: { mode: "full-karaoke" },
    };
    expect(await roomBackend.update(ghost)).toBe("missing");
    expect(await getRoom(ghost.id)).toBeNull();
  });

  it("a mutator cannot pick its own revision: mutateRoom writes against the one it read", async () => {
    const r = await room();
    await setRoomMode(r.id, "per-table-2");
    await setRoomLanguage(r.id, "en");
    await setRoomModeration(r.id, true);
    expect((await getRoom(r.id))!.rev).toBe(3);
  });
});

describe("the authentication path still never writes, and still reads once (TICKET-118 P1)", () => {
  it("requireHost, the session probe and a claim make zero writes", async () => {
    const r = await room();
    const claim = (await issueRoomClaimToken(r.id, { owner: true }))!;
    const session = (await issueSession(r.id))!;
    const update = jest.spyOn(roomBackend, "update");
    const get = jest.spyOn(roomBackend, "get");

    expect(await requireHost(hostReq("/api/host/mode", r.id, { [hostCookieName(r.id)]: session }), r.id)).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);

    const probe = await sessionProbe(hostReq("/api/host/session", r.id, { [hostCookieName(r.id)]: session }));
    expect(probe.status).toBe(200);
    const claimed = await claimRoute(
      hostReq("/api/host/claim", r.id, { [claimCookieName(r.id)]: claim }, { method: "POST" }),
    );
    expect(claimed.status).toBe(200);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("when a write can never commit, every caller fails closed", () => {
  it("a login mint returns null after exactly ROOM_WRITE_ATTEMPTS tries, and changes nothing", async () => {
    const r = await room();
    const owner = (await issueRoomClaimToken(r.id, { owner: true }))!;
    const before = await getRoom(r.id);
    const spy = alwaysConflict();
    expect(await issueRoomClaimToken(r.id)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(ROOM_WRITE_ATTEMPTS);
    spy.mockRestore();
    expect(await getRoom(r.id)).toEqual(before);
    expect(await verifyRoomClaimToken(r.id, owner)).toBe(true);
  });

  it("a logout throws before the route clears anything, so the client is never told it logged out", async () => {
    const r = await room();
    const staff = (await issueRoomClaimToken(r.id))!;
    const session = (await issueSession(r.id))!;
    alwaysConflict();
    await expect(revokeRoomClaimToken(r.id, staff)).rejects.toBeInstanceOf(RoomWriteConflictError);
    await expect(
      logoutRoute(
        hostReq(
          "/api/host/session",
          r.id,
          { [hostCookieName(r.id)]: session, [claimCookieName(r.id)]: staff },
          { method: "POST", headers: { "sec-fetch-site": "same-origin" } },
        ),
      ),
    ).rejects.toBeInstanceOf(RoomWriteConflictError);
    jest.restoreAllMocks();
    // Nothing was revoked, nothing was reported: the device can retry.
    expect(await verifyRoomClaimToken(r.id, staff)).toBe(true);
    expect(await verifySessionValue(r.id, session)).toBe(true);
  });

  it("a settings change throws rather than reporting a change it did not make", async () => {
    const r = await room();
    const session = (await issueSession(r.id))!;
    alwaysConflict();
    await expect(setRoomMode(r.id, "per-table-2")).rejects.toBeInstanceOf(RoomWriteConflictError);
    await expect(setRoomLanguage(r.id, "es")).rejects.toBeInstanceOf(RoomWriteConflictError);
    await expect(setRoomModeration(r.id, true)).rejects.toBeInstanceOf(RoomWriteConflictError);
    await expect(
      modeRoute(
        hostReq("/api/host/mode", r.id, { [hostCookieName(r.id)]: session }, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "per-table-2" }),
        }),
      ),
    ).rejects.toBeInstanceOf(RoomWriteConflictError);
    jest.restoreAllMocks();
    expect(await getRoomMode(r.id)).toBe("full-karaoke");
  });

  it("a write that loses fewer than ROOM_WRITE_ATTEMPTS races still commits", async () => {
    const r = await room();
    const real = roomBackend.update.bind(roomBackend);
    let calls = 0;
    jest.spyOn(roomBackend, "update").mockImplementation(async (rec) =>
      ++calls < ROOM_WRITE_ATTEMPTS ? "conflict" : real(rec),
    );
    expect(await setRoomMode(r.id, "per-table-2")).toBe("per-table-2");
    expect(calls).toBe(ROOM_WRITE_ATTEMPTS);
    jest.restoreAllMocks();
    expect(await getRoomMode(r.id)).toBe("per-table-2");
  });
});
