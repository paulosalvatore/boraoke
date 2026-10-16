/**
 * TICKET-127 — every pair of room-record writers, in the worst order.
 *
 * Each room mutation reads the record, changes it, and writes it back. The
 * dangerous order for any two writers A and B is: A reads, B commits, A writes.
 * If A's write is accepted, it carries A's pre-B snapshot and erases B. These
 * tests force exactly that order, deterministically and with no timers:
 *
 *   1. start A and HOLD its first `roomBackend.update` call (A has read);
 *   2. run B to completion (its writes pass straight through);
 *   3. release A's held write and let A finish (any retry passes through).
 *
 * Then they check each writer's own effect and the global owner invariant. With
 * a plain whole-record SET (the pre-fix backend), A's held write lands and B's
 * effect is gone. With the compare-and-set backend, A's held write is refused
 * because B moved the record's revision, and A recomputes from the record that
 * includes B.
 *
 * Deliberately written against the public room API only, so the same file runs
 * against the pre-fix `lib/` (the prove-your-test-can-fail reverse check).
 *
 * Writers: login mint, owner mint (creation, revoke fallback), logout of one staff
 * device, "sign out other devices" (owner), and the three host settings.
 */
import { verifySessionValue } from "@/lib/host-auth";
import {
  getRoomSessionEpoch,
  issueRoomClaimToken,
  revokeRoomClaimToken,
  revokeRoomHostSessions,
  roomBackend,
  verifyRoomClaimToken,
} from "@/lib/rooms";
import { PAIRS, WRITERS, expectOwnerPinIntact, runPair, setup } from "./helpers/room-writers";

afterEach(() => jest.restoreAllMocks());

describe("TICKET-127: A reads, B commits, A writes — B's effect survives, for every pair", () => {
  it.each(PAIRS)("stale %s, interleaved %s", (a, b) => runPair(a, b));

  it("covers every ordered writer pair except the documented skips", () => {
    const n = Object.keys(WRITERS).length;
    expect(PAIRS.length).toBe(n * n - 4);
  });
});

/**
 * The one revoke-vs-logout shape the pair matrix cannot reach. A device logs in by
 * code AFTER the revoke bumped the epoch, so the rebind carries its hash as a
 * post-bump one. The rebind reads, that device logs out, then the rebind's write
 * lands. A blind write puts the logged-out device's hash back, and its claim is
 * live again. The compare-and-set write is refused and recomputes without it.
 */
describe("TICKET-127: a post-revoke login that logs out while the rebind is held", () => {
  it("the logout is not undone by the revoke's write", async () => {
    const ctx = await setup("Bar Corrida 127 post-revoke");
    const realBump = roomBackend.bumpSessionEpoch.bind(roomBackend);
    const realUpdate = roomBackend.update.bind(roomBackend) as (...args: unknown[]) => Promise<unknown>;
    let lateDevice: string | null = null;
    let reached!: () => void;
    const atRebindWrite = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    jest.spyOn(roomBackend, "bumpSessionEpoch").mockImplementation(async (id: string, floor: number) => {
      const epoch = await realBump(id, floor);
      // The sessions are ended; a device now logs in by typing the host code.
      lateDevice = await issueRoomClaimToken(ctx.roomId);
      // Hold the revoke's next write: the rebind, which has read the late hash.
      let held = false;
      jest.spyOn(roomBackend, "update").mockImplementation((async (...args: unknown[]) => {
        if (!held) {
          held = true;
          reached();
          await gate;
        }
        return realUpdate(...args);
      }) as never);
      return epoch;
    });

    const pending = revokeRoomHostSessions(ctx.roomId, { presentedClaimToken: ctx.owner });
    await atRebindWrite;
    expect(lateDevice).not.toBeNull();
    expect(await verifyRoomClaimToken(ctx.roomId, lateDevice)).toBe(true);
    await revokeRoomClaimToken(ctx.roomId, lateDevice!);
    release();
    const result = await pending;
    jest.restoreAllMocks();

    expect(result).toMatchObject({ ok: true });
    // The logout's effect survives the rebind's write.
    expect(await verifyRoomClaimToken(ctx.roomId, lateDevice)).toBe(false);
    // The revoke's own effects hold too.
    expect(await getRoomSessionEpoch(ctx.roomId)).toBeGreaterThan(ctx.epochBefore);
    expect(await verifySessionValue(ctx.roomId, ctx.oldSession)).toBe(false);
    expect(await verifyRoomClaimToken(ctx.roomId, ctx.owner)).toBe(true);
    expect(await verifyRoomClaimToken(ctx.roomId, ctx.staff[0])).toBe(false);
    await expectOwnerPinIntact(ctx);
  });
});
