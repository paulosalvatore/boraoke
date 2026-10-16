/**
 * TICKET-127 — the room-record writers and the worst-order harness, shared by
 * room-write-race.test.ts (memory backend) and room-cas-lua.integration.test.ts
 * (the same pairs over a real Redis). Public room API only, so it also runs
 * against the pre-fix `lib/` for the reverse check. See room-write-race.test.ts
 * for what the harness proves.
 */
import { issueSession, verifySessionValue } from "@/lib/host-auth";
import {
  createRoom,
  getRoom,
  getRoomLanguage,
  getRoomMode,
  getRoomModeration,
  getRoomSessionEpoch,
  hashClaimToken,
  issueRoomClaimToken,
  revokeRoomClaimToken,
  revokeRoomHostSessions,
  roomBackend,
  setRoomLanguage,
  setRoomMode,
  setRoomModeration,
  verifyRoomClaimToken,
} from "@/lib/rooms";

export type Slot = "A" | "B";

export interface Ctx {
  roomId: string;
  owner: string;
  staff: [string, string];
  oldSession: string;
  epochBefore: number;
  minted: Partial<Record<Slot, string | null>>;
  revoked?: Awaited<ReturnType<typeof revokeRoomHostSessions>>;
}

export interface Writer {
  run(ctx: Ctx, slot: Slot): Promise<unknown>;
  check(ctx: Ctx, slot: Slot): Promise<void>;
}

/** The staff device a logout in this slot signs out. Different per slot, so logout x logout is two devices. */
const logoutToken = (ctx: Ctx, slot: Slot) => (slot === "A" ? ctx.staff[1] : ctx.staff[0]);

export const WRITERS: Record<string, Writer> = {
  mint: {
    run: async (ctx, slot) => (ctx.minted[slot] = await issueRoomClaimToken(ctx.roomId)),
    check: async (ctx, slot) => {
      // The device that typed the code holds a live claim token (scenario 1).
      expect(await verifyRoomClaimToken(ctx.roomId, ctx.minted[slot])).toBe(true);
    },
  },
  ownerMint: {
    run: async (ctx, slot) => (ctx.minted[slot] = await issueRoomClaimToken(ctx.roomId, { owner: true })),
    check: async (ctx, slot) => {
      expect(await verifyRoomClaimToken(ctx.roomId, ctx.minted[slot])).toBe(true);
    },
  },
  logout: {
    run: (ctx, slot) => revokeRoomClaimToken(ctx.roomId, logoutToken(ctx, slot)),
    check: async (ctx, slot) => {
      // A device that logged out stays logged out (no stale write restores its hash).
      expect(await verifyRoomClaimToken(ctx.roomId, logoutToken(ctx, slot))).toBe(false);
    },
  },
  revoke: {
    run: async (ctx) => (ctx.revoked = await revokeRoomHostSessions(ctx.roomId, { presentedClaimToken: ctx.owner })),
    check: async (ctx) => {
      expect(ctx.revoked).toMatchObject({ ok: true });
      // Sessions half: the epoch went up and the pre-revoke session is dead.
      expect(await getRoomSessionEpoch(ctx.roomId)).toBeGreaterThan(ctx.epochBefore);
      expect(await verifySessionValue(ctx.roomId, ctx.oldSession)).toBe(false);
      // Claims half: the owner kept its credential, a pruned staff claim stays dead.
      expect(await verifyRoomClaimToken(ctx.roomId, ctx.owner)).toBe(true);
      expect(await verifyRoomClaimToken(ctx.roomId, ctx.staff[0])).toBe(false);
    },
  },
  mode: {
    run: (ctx) => setRoomMode(ctx.roomId, "per-table-2"),
    check: async (ctx) => expect(await getRoomMode(ctx.roomId)).toBe("per-table-2"),
  },
  language: {
    run: (ctx) => setRoomLanguage(ctx.roomId, "es"),
    check: async (ctx) => expect(await getRoomLanguage(ctx.roomId)).toBe("es"),
  },
  moderation: {
    run: (ctx) => setRoomModeration(ctx.roomId, true),
    check: async (ctx) => expect(await getRoomModeration(ctx.roomId)).toBe(true),
  },
};

const SETTINGS = new Set(["mode", "language", "moderation"]);

/**
 * Pairs left out, and why. Not lost updates, so there is nothing to prove:
 *  - the same setting twice: last writer wins on one field by design;
 *  - revoke x revoke: B's owner check runs while A's rebind is pending, so the
 *    claim list is tagged with the old epoch and B is refused as `not-owner`
 *    before it writes anything. Concurrent revokes are covered by the
 *    "CONCURRENT revokes" probe in host-session-revocation.test.ts.
 */
function skipped(a: string, b: string): boolean {
  return a === b && (SETTINGS.has(a) || a === "revoke");
}

export const PAIRS: Array<[string, string]> = [];
for (const a of Object.keys(WRITERS)) {
  for (const b of Object.keys(WRITERS)) if (!skipped(a, b)) PAIRS.push([a, b]);
}

let roomSeq = 0;
export async function setup(label = "Bar Corrida 127"): Promise<Ctx> {
  const created = await createRoom(`${label} ${++roomSeq}`);
  if (!created) throw new Error("room ceiling hit in test");
  const roomId = created.room.id;
  const owner = (await issueRoomClaimToken(roomId, { owner: true }))!;
  const staff: [string, string] = [(await issueRoomClaimToken(roomId))!, (await issueRoomClaimToken(roomId))!];
  return {
    roomId,
    owner,
    staff,
    oldSession: (await issueSession(roomId))!,
    epochBefore: await getRoomSessionEpoch(roomId),
    minted: {},
  };
}

/** A reads and is held at its first write; B runs to completion; then A's write is released. */
export async function worstOrder(a: () => Promise<unknown>, b: () => Promise<unknown>): Promise<void> {
  const real = roomBackend.update.bind(roomBackend) as (...args: unknown[]) => Promise<unknown>;
  let reached!: () => void;
  const atWrite = new Promise<void>((r) => (reached = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const spy = jest.spyOn(roomBackend, "update").mockImplementation((async (...args: unknown[]) => {
    if (calls++ === 0) {
      reached();
      await gate;
    }
    return real(...args);
  }) as never);
  try {
    const pendingA = a();
    await atWrite;
    await b();
    release();
    await pendingA;
  } finally {
    spy.mockRestore();
  }
}

/**
 * The global owner invariant (Cyber R-1): the room has an owner pin, the pinned
 * credential is live, and an ordinary code login afterwards keeps it pinned (R1f
 * lost the pin on exactly that login).
 */
export async function expectOwnerPinIntact(ctx: Ctx): Promise<void> {
  const room = (await getRoom(ctx.roomId))!;
  const candidates = [ctx.owner, ctx.minted.A, ctx.minted.B].filter((t): t is string => typeof t === "string");
  const pinned = candidates.find((t) => hashClaimToken(t) === room.ownerClaimTokenHash);
  expect(pinned).toBeDefined();
  expect(await verifyRoomClaimToken(ctx.roomId, pinned)).toBe(true);
  const later = (await issueRoomClaimToken(ctx.roomId))!;
  expect((await getRoom(ctx.roomId))!.ownerClaimTokenHash).toBe(hashClaimToken(pinned!));
  expect(await verifyRoomClaimToken(ctx.roomId, pinned)).toBe(true);
  expect(await verifyRoomClaimToken(ctx.roomId, later)).toBe(true);
}


/**
 * One ordered pair in the worst order, then every check: B's effect, A's effect,
 * an owner mint's pin when nothing else could legitimately move it, and the global
 * owner invariant.
 */
export async function runPair(a: string, b: string, label?: string): Promise<void> {
  const ctx = await setup(label);
  await worstOrder(
    () => WRITERS[a].run(ctx, "A"),
    () => WRITERS[b].run(ctx, "B"),
  );
  await WRITERS[b].check(ctx, "B");
  await WRITERS[a].check(ctx, "A");
  // An owner mint must hold the pin it set, unless a revoke (which re-pins the
  // acting owner) or a second owner mint could legitimately have moved it.
  const pinMayMove = a === "revoke" || b === "revoke" || (a === "ownerMint" && b === "ownerMint");
  for (const [name, slot] of [[a, "A"], [b, "B"]] as const) {
    if (name === "ownerMint" && !pinMayMove) {
      expect((await getRoom(ctx.roomId))!.ownerClaimTokenHash).toBe(hashClaimToken(ctx.minted[slot]!));
    }
  }
  await expectOwnerPinIntact(ctx);
}
