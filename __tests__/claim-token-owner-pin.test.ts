/**
 * TICKET-120 — the claim-token cap must count DEVICES, and other people's logins
 * must never evict the room creator's device.
 *
 * The scenario that filed the ticket: the owner creates the room on their phone,
 * then over the evening five staff members type the host code on the tablet or
 * their own phones. Before this fix the fifth login silently evicted the owner's
 * credential, putting them back on a shown-once code they no longer have — the
 * dead end TICKET-104 exists to remove.
 *
 * This is an AUTHENTICATION path, and every mechanism that wrote on it has
 * recreated a lockout (MANAGER-LOG), so the load-bearing test is a CONCURRENCY
 * PROBE: 30 logins from distinct clients, fired concurrently against a room
 * backend whose reads and writes interleave with random delays, and the owner's
 * token must still verify afterwards. It must FAIL against the pre-fix
 * `slice(-MAX_CLAIM_TOKENS)` (see the dev report for the verbatim reverse check).
 */
import { NextRequest } from "next/server";
import { POST as loginRoute } from "@/app/api/host/login/route";
import { POST as roomsRoute } from "@/app/api/rooms/route";
import { POST as logoutRoute } from "@/app/api/host/session/route";
import { _clearLoginThrottle, claimCookieName, hostCookieName } from "@/lib/host-auth";
import {
  capClaimHashes,
  createRoom,
  getRoom,
  hashClaimToken,
  issueRoomClaimToken,
  MAX_CLAIM_TOKENS,
  roomBackend,
  setRoomMode,
  verifyRoomClaimToken,
} from "@/lib/rooms";

/** Read a Set-Cookie value for `name` off a route response. */
function setCookie(res: Response, name: string): string | undefined {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const [k, ...rest] = pair.split("=");
    if (k.trim() === name) return rest.join("=");
  }
  return undefined;
}

let ipN = 0;
function nextIp(): string {
  ipN++;
  return `198.51.${Math.floor(ipN / 250)}.${ipN % 250}`;
}

/** The owner creates a room: returns its id, host code and the owner's claim token. */
async function ownerCreatesRoom(name: string) {
  const res = await roomsRoute(
    new NextRequest("http://127.0.0.1:3040/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": nextIp() },
      body: JSON.stringify({ name }),
    }),
  );
  expect(res.status).toBe(201);
  const body = await res.json();
  const ownerToken = setCookie(res, claimCookieName(body.id));
  if (!ownerToken) throw new Error("creator got no claim cookie");
  return { roomId: body.id as string, hostCode: body.hostCode as string, ownerToken };
}

/** A host-code login from a client, optionally presenting a claim cookie it already holds. */
async function login(roomId: string, hostCode: string, presented?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-forwarded-for": nextIp() };
  if (presented) headers.cookie = `${claimCookieName(roomId)}=${presented}`;
  const res = await loginRoute(
    new NextRequest(`http://127.0.0.1:3040/api/host/login?room=${encodeURIComponent(roomId)}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ token: hostCode }),
    }),
  );
  expect(res.status).toBe(200);
  return setCookie(res, claimCookieName(roomId));
}

/** Seeded PRNG so a failing interleaving is reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Make the room backend's reads and writes yield for a random few ms, so
 * concurrent logins genuinely interleave their read-modify-writes (the memory
 * backend otherwise completes each one in a single microtask burst).
 */
function jitterRoomBackend(seed: number) {
  const rand = rng(seed);
  const pause = () => new Promise<void>((r) => setTimeout(r, Math.floor(rand() * 5)));
  const realGet = roomBackend.get.bind(roomBackend);
  const realUpdate = roomBackend.update.bind(roomBackend);
  jest.spyOn(roomBackend, "get").mockImplementation(async (id: string) => {
    await pause();
    const r = await realGet(id);
    await pause();
    return r;
  });
  jest.spyOn(roomBackend, "update").mockImplementation(async (room) => {
    await pause();
    return realUpdate(room);
  });
}

beforeEach(() => {
  _clearLoginThrottle();
});
afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * The two concurrency probes run on REAL timers (that is what makes the
 * read-modify-writes interleave), so their wall time scales with host load:
 * ~0.2-0.7 s idle, measured up to 4.8 s at load ~170 with 16 jest workers,
 * against jest's 5 s default. Past the default they failed as a TIMEOUT that
 * reads exactly like an owner lockout in a summary line. The budget is
 * explicit and generous so a slow host can only make them slow, never red.
 * The assertions are the only thing that can fail them.
 */
const CONCURRENCY_PROBE_TIMEOUT_MS = 60_000;

describe("the owner survives other people's logins (TICKET-120)", () => {
  it("30 CONCURRENT logins from distinct clients never evict the owner (8 interleavings)", async () => {
    const survived: boolean[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const { roomId, hostCode, ownerToken } = await ownerCreatesRoom(`Bar Probe ${seed}`);
      jitterRoomBackend(seed);
      // All 30 are in flight together, but ARRIVE spread over ~60 ms, the way
      // staff logins do. Without the spread every login reads the record before
      // any writes, the lost updates keep the owner's hash by accident, and the
      // probe would pass on the pre-fix code too (measured: it did).
      const start = rng(seed * 7919);
      let inFlight = 0;
      let maxInFlight = 0;
      await Promise.all(
        Array.from({ length: 30 }, async () => {
          await new Promise((r) => setTimeout(r, Math.floor(start() * 60)));
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try {
            await login(roomId, hostCode);
          } finally {
            inFlight--;
          }
        }),
      );
      jest.restoreAllMocks();
      expect(maxInFlight).toBeGreaterThan(1); // genuinely concurrent, not serialised
      const room = await getRoom(roomId);
      survived.push(await verifyRoomClaimToken(roomId, ownerToken));
      expect(room?.claimTokenHashes?.length).toBeLessThanOrEqual(MAX_CLAIM_TOKENS);
      expect(room?.ownerClaimTokenHash).toBe(hashClaimToken(ownerToken));
    }
    expect(survived).toEqual([true, true, true, true, true, true, true, true]);
  }, CONCURRENCY_PROBE_TIMEOUT_MS);

  it("30 logins in six concurrent waves: the owner verifies after EVERY wave", async () => {
    const { roomId, hostCode, ownerToken } = await ownerCreatesRoom("Bar Waves");
    jitterRoomBackend(120);
    const afterWave: boolean[] = [];
    for (let wave = 0; wave < 6; wave++) {
      await Promise.all(Array.from({ length: 5 }, () => login(roomId, hostCode)));
      afterWave.push(await verifyRoomClaimToken(roomId, ownerToken));
    }
    expect(afterWave).toEqual([true, true, true, true, true, true]);
  }, CONCURRENCY_PROBE_TIMEOUT_MS);

  it("worst-case lost updates, no timers: every read lands before any write, writes released in a seeded random order (200 interleavings)", async () => {
    // The timer probes above sample interleavings; this one forces the worst
    // case for a whole-record read-modify-write deterministically:
    // 30 concurrent writers (staff mints plus host mode changes) all read the
    // record, then their writes land in a shuffled order. Independent of host
    // load. Fails against the pre-fix `slice(-MAX_CLAIM_TOKENS)`.
    const lockedOut: number[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed);
      const created = await createRoom(`Bar Barrier ${seed}`);
      const roomId = created!.room.id;
      const ownerToken = (await issueRoomClaimToken(roomId, { owner: true }))!;
      const preFilled = Math.floor(rand() * 8); // sometimes already at the cap
      for (let i = 0; i < preFilled; i++) await issueRoomClaimToken(roomId);

      const realUpdate = roomBackend.update.bind(roomBackend);
      const held: Array<() => Promise<void>> = [];
      jest.spyOn(roomBackend, "update").mockImplementation(
        (room) => new Promise<void>((done) => held.push(() => realUpdate(room).then(done))),
      );
      const writers = Array.from({ length: 30 }, (_, i) =>
        i % 7 === 3
          ? setRoomMode(roomId, rand() < 0.5 ? "per-table-2" : "full-karaoke")
          : issueRoomClaimToken(roomId),
      );
      while (held.length < writers.length) await new Promise((r) => setImmediate(r));
      for (let i = held.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [held[i], held[j]] = [held[j], held[i]];
      }
      for (const write of held) await write();
      await Promise.all(writers);
      jest.restoreAllMocks();

      const room = (await getRoom(roomId))!;
      const ownerIn =
        (await verifyRoomClaimToken(roomId, ownerToken)) &&
        room.ownerClaimTokenHash === hashClaimToken(ownerToken) &&
        room.claimTokenHashes!.length <= MAX_CLAIM_TOKENS;
      if (!ownerIn) lockedOut.push(seed);
    }
    expect(lockedOut).toEqual([]);
  });

  it("the ticket's own scenario, sequentially: five staff logins, owner still in", async () => {
    const { roomId, hostCode, ownerToken } = await ownerCreatesRoom("Bar Staff");
    const staff: string[] = [];
    for (let i = 0; i < 5; i++) staff.push((await login(roomId, hostCode))!);
    expect(await verifyRoomClaimToken(roomId, ownerToken)).toBe(true);
    // The cap is still real: with the owner pinned, the OLDEST staff device is the one out.
    expect(await verifyRoomClaimToken(roomId, staff[0])).toBe(false);
    for (const t of staff.slice(1)) expect(await verifyRoomClaimToken(roomId, t)).toBe(true);
  });
});

describe("the cap counts DEVICES on the login path too", () => {
  it("a device that presents its live token gets it back, with NO new slot and NO store write", async () => {
    const { roomId, hostCode, ownerToken } = await ownerCreatesRoom("Bar Tablet");
    const tablet = (await login(roomId, hostCode))!;
    const before = (await getRoom(roomId))!.claimTokenHashes!.slice();
    const update = jest.spyOn(roomBackend, "update");
    for (let i = 0; i < 5; i++) {
      expect(await login(roomId, hostCode, tablet)).toBe(tablet);
    }
    expect(update).not.toHaveBeenCalled();
    expect((await getRoom(roomId))!.claimTokenHashes).toEqual(before);
    expect(await verifyRoomClaimToken(roomId, ownerToken)).toBe(true);
  });

  it("a device presenting a DEAD token (revoked, or another room's) still gets a fresh one", async () => {
    const { roomId, hostCode } = await ownerCreatesRoom("Bar Dead Token");
    const fresh = await login(roomId, hostCode, "not-a-live-token");
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe("not-a-live-token");
    expect(await verifyRoomClaimToken(roomId, fresh)).toBe(true);
  });
});

describe("the owner pointer is bookkeeping, never a credential", () => {
  it("a pointer with no matching hash grants nothing", async () => {
    const { roomId, ownerToken } = await ownerCreatesRoom("Bar Pointer");
    const room = (await getRoom(roomId))!;
    await roomBackend.update({ ...room, claimTokenHashes: [] });
    expect((await getRoom(roomId))!.ownerClaimTokenHash).toBe(hashClaimToken(ownerToken));
    expect(await verifyRoomClaimToken(roomId, ownerToken)).toBe(false);
  });

  it("logout clears the hashes AND the pointer; the next login is not re-pinned as owner", async () => {
    const { roomId, hostCode, ownerToken } = await ownerCreatesRoom("Bar Logout");
    const session = await (async () => {
      const res = await loginRoute(
        new NextRequest(`http://127.0.0.1:3040/api/host/login?room=${encodeURIComponent(roomId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": nextIp() },
          body: JSON.stringify({ token: hostCode }),
        }),
      );
      return setCookie(res, hostCookieName(roomId))!;
    })();
    const out = await logoutRoute(
      new NextRequest(`http://127.0.0.1:3040/api/host/session?room=${encodeURIComponent(roomId)}`, {
        method: "POST",
        headers: { host: "127.0.0.1:3040", cookie: `${hostCookieName(roomId)}=${session}`, "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:3040" },
      }),
    );
    expect(out.status).toBeLessThan(300);
    const after = (await getRoom(roomId))!;
    expect(after.claimTokenHashes).toBeUndefined();
    expect(after.ownerClaimTokenHash).toBeUndefined();
    expect(await verifyRoomClaimToken(roomId, ownerToken)).toBe(false);

    await login(roomId, hostCode);
    expect((await getRoom(roomId))!.ownerClaimTokenHash).toBeUndefined();
  });
});

describe("capClaimHashes", () => {
  const H = (n: number) => `h${n}`;
  it("is the identity at or under the cap", () => {
    expect(capClaimHashes([H(1), H(2)], H(1))).toEqual([H(1), H(2)]);
    expect(capClaimHashes([1, 2, 3, 4, 5].map(H), H(1))).toEqual([1, 2, 3, 4, 5].map(H));
  });
  it("keeps the owner and the NEWEST others, in order", () => {
    expect(capClaimHashes([1, 2, 3, 4, 5, 6].map(H), H(1))).toEqual([1, 3, 4, 5, 6].map(H));
    expect(capClaimHashes([2, 3, 1, 4, 5, 6, 7].map(H), H(1))).toEqual([1, 4, 5, 6, 7].map(H));
  });
  it("without an owner (or with a dangling one) it is the plain newest-N window", () => {
    expect(capClaimHashes([1, 2, 3, 4, 5, 6].map(H))).toEqual([2, 3, 4, 5, 6].map(H));
    expect(capClaimHashes([1, 2, 3, 4, 5, 6].map(H), "gone")).toEqual([2, 3, 4, 5, 6].map(H));
  });
  it("keeps an owner that is the newest entry too", () => {
    expect(capClaimHashes([1, 2, 3, 4, 5, 6].map(H), H(6))).toEqual([2, 3, 4, 5, 6].map(H));
  });
});
