/**
 * Gated room deletion (lib/room-delete.ts): the same suite runs against an
 * in-memory fake (always) and a real Redis (set REDIS_TEST_URL, e.g.
 *   docker run --rm -d -p 6431:6379 redis:7-alpine
 *   REDIS_TEST_URL=redis://127.0.0.1:6431 npx jest room-delete
 * ). Key names come from the app's own key builders, so a renamed key breaks here.
 */
import {
  applyDelete, buildPlan, runDelete, runRestore, validateSnapshot, isApplicable, restoreSnapshot, takeSnapshot, RoomDeleteError, type Kv,
} from "@/lib/room-delete";
import { roomKey, roomSessionEpochKey, ROOM_CAS_SCRIPT } from "@/lib/rooms";
import { keys as qk } from "@/lib/store/types";
import { pendingKeys } from "@/lib/pending-store";
import { revokeKey } from "@/lib/host-auth";
import { redisKey } from "@/lib/rate-limit-counter";
import { identityKeys } from "@/lib/identity-store";
import { MemoryKv, RedisKv, RespClient } from "./helpers/kv-backends";

const REDIS_URL = process.env.REDIS_TEST_URL;
const TARGET = "t151-target";
const OTHER = "t151-other";
const CREATOR = "11111111-1111-4111-8111-111111111111";
const OTHER_CREATOR = "22222222-2222-4222-8222-222222222222";

async function seedRoom(kv: Kv, slug: string, creator: string | null) {
  await kv.set(roomKey(slug), JSON.stringify({ id: slug, name: slug, rev: 3, ...(creator ? { creatorUuid: creator } : {}) }));
  await kv.pexpire(roomKey(slug), 3_600_000);
  await kv.set(roomSessionEpochKey(slug), "2");
  await kv.rpush(qk.queue(slug), JSON.stringify({ id: "q1" }), JSON.stringify({ id: "q2" }));
  await kv.set(qk.paused(slug), "1");
  await kv.rpush(pendingKeys.index(slug), "p1", "p2");
  await kv.set(pendingKeys.item(slug, "p1"), JSON.stringify({ pendingId: "p1" }));
  await kv.set(pendingKeys.item(slug, "p2"), JSON.stringify({ pendingId: "p2" }));
  await kv.set(redisKey(revokeKey(slug)), "2");
  if (creator) await kv.sadd(identityKeys.rooms(creator), slug);
}

const everything = async (kv: Kv) => (await kv.scan("*")).sort();

function suite(name: string, make: () => Promise<{ kv: Kv; reset: () => Promise<void>; close?: () => void }>) {
  describe(name, () => {
    let kv: Kv;
    let reset: () => Promise<void>;
    let close: (() => void) | undefined;
    beforeAll(async () => ({ kv, reset, close } = await make()));
    afterAll(() => close?.());
    beforeEach(async () => {
      await reset();
      await seedRoom(kv, TARGET, CREATOR);
      await seedRoom(kv, OTHER, OTHER_CREATOR);
      // A second membership for the target in a set the record does not point at (legacy link).
      await kv.sadd(identityKeys.rooms(OTHER_CREATOR), TARGET);
    });

    it("delete leaves no room:<slug>:* key and no membership entry", async () => {
      const plan = await buildPlan(kv, TARGET);
      expect(plan.keys.map((k) => k.key)).toEqual(expect.arrayContaining([
        roomKey(TARGET), roomSessionEpochKey(TARGET), qk.queue(TARGET), qk.paused(TARGET),
        pendingKeys.index(TARGET), pendingKeys.item(TARGET, "p1"), pendingKeys.item(TARGET, "p2"),
        redisKey(revokeKey(TARGET)),
      ]));
      expect(plan.keys).toHaveLength(8);
      expect(plan.memberships).toEqual([identityKeys.rooms(CREATOR), identityKeys.rooms(OTHER_CREATOR)].sort());
      const left = await applyDelete(kv, plan);
      expect(left).toEqual({ leftoverKeys: [], leftoverMemberships: [] });
      expect(await kv.scan(`room:${TARGET}:*`)).toEqual([]);
      expect(await kv.scan(`*${TARGET}*`)).toEqual([]);
      for (const m of plan.memberships) {
        expect(await kv.smembers(m)).not.toContain(TARGET);
      }
    });

    it("leaves other rooms and their memberships untouched", async () => {
      const before = new Map<string, unknown>();
      for (const k of await kv.scan(`room:${OTHER}:*`)) before.set(k, await kv.type(k));
      await applyDelete(kv, await buildPlan(kv, TARGET));
      expect([...before.keys()].sort()).toEqual((await kv.scan(`room:${OTHER}:*`)).sort());
      expect(await kv.get(roomKey(OTHER))).not.toBeNull();
      expect(await kv.smembers(identityKeys.rooms(OTHER_CREATOR))).toEqual([OTHER]);
      expect(await kv.get(redisKey(revokeKey(OTHER)))).toBe("2");
    });

    it("a wrong slug deletes nothing", async () => {
      const snapshotBefore = await everything(kv);
      const plan = await buildPlan(kv, "t151-nope");
      expect(plan.keys).toEqual([]);
      expect(plan.memberships).toEqual([]);
      expect(isApplicable(plan).ok).toBe(false);
      await expect(applyDelete(kv, plan)).rejects.toThrow(RoomDeleteError);
      expect(await everything(kv)).toEqual(snapshotBefore);
      await expect(buildPlan(kv, "Bad Slug*")).rejects.toThrow(RoomDeleteError);
      await expect(buildPlan(kv, "*")).rejects.toThrow(RoomDeleteError);
    });

    it("dry run (buildPlan + takeSnapshot) writes nothing", async () => {
      const before = await everything(kv);
      const members = await kv.smembers(identityKeys.rooms(CREATOR));
      const plan = await buildPlan(kv, TARGET);
      await takeSnapshot(kv, plan);
      expect(await everything(kv)).toEqual(before);
      expect(await kv.smembers(identityKeys.rooms(CREATOR))).toEqual(members);
    });

    it("runDelete is a dry run by default and gates --apply on the typed slug", async () => {
      const before = await everything(kv);
      const save = jest.fn(() => "snap.json");
      const confirm = jest.fn(async () => TARGET);
      const dry = await runDelete(kv, { slug: TARGET, apply: false, confirm, saveSnapshot: save });
      expect(dry.status).toBe("dry-run");
      expect(save).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(await everything(kv)).toEqual(before);

      const wrong = await runDelete(kv, { slug: TARGET, apply: true, confirm: async () => OTHER, saveSnapshot: save });
      expect(wrong.status).toBe("confirmation-mismatch");
      expect(save).not.toHaveBeenCalled();
      expect(await everything(kv)).toEqual(before);

      const failedSave = runDelete(kv, { slug: TARGET, apply: true, confirm, saveSnapshot: () => { throw new Error("disk full"); } });
      await expect(failedSave).rejects.toThrow("disk full");
      expect(await everything(kv)).toEqual(before);

      const done = await runDelete(kv, { slug: TARGET, apply: true, confirm, saveSnapshot: save });
      expect(done.status).toBe("deleted");
      expect(save).toHaveBeenCalledTimes(1);
      expect(await kv.scan(`*${TARGET}*`)).toEqual([]);
    });

    it("shows the plan before the confirmation prompt, and a declined confirmation writes nothing", async () => {
      const before = await everything(kv);
      const order: string[] = [];
      const save = jest.fn(() => "snap.json");
      const res = await runDelete(kv, {
        slug: TARGET,
        apply: true,
        onPlan: (p) => order.push(`plan:${p.keys.length}:${p.memberships.length}`),
        confirm: async () => { order.push("prompt"); return ""; },
        saveSnapshot: save,
      });
      expect(order).toEqual(["plan:8:2", "prompt"]);
      expect(res.status).toBe("confirmation-mismatch");
      expect(save).not.toHaveBeenCalled();
      expect(await everything(kv)).toEqual(before);
    });

    it("refuses to apply when a room:<slug>:* key is not on the code-derived list", async () => {
      await kv.set(`room:${TARGET}:mystery`, "x");
      const plan = await buildPlan(kv, TARGET);
      expect(plan.unaccounted).toEqual([`room:${TARGET}:mystery`]);
      expect(isApplicable(plan).ok).toBe(false);
      await expect(applyDelete(kv, plan)).rejects.toThrow(/not on the code-derived list/);
      expect(await kv.get(roomKey(TARGET))).not.toBeNull();
    });

    it("restore round-trips the snapshot (values, TTL, order, memberships)", async () => {
      const plan = await buildPlan(kv, TARGET);
      const snap = JSON.parse(JSON.stringify(await takeSnapshot(kv, plan)));
      const queueBefore = await kv.lrange(qk.queue(TARGET));
      const metaBefore = await kv.get(roomKey(TARGET));
      await applyDelete(kv, plan);
      expect(await kv.get(roomKey(TARGET))).toBeNull();
      await restoreSnapshot(kv, snap);
      expect(await kv.get(roomKey(TARGET))).toBe(metaBefore);
      expect(await kv.lrange(qk.queue(TARGET))).toEqual(queueBefore);
      expect(await kv.get(qk.paused(TARGET))).toBe("1");
      const ttl = await kv.pttl(roomKey(TARGET));
      expect(ttl).toBeGreaterThan(3_000_000);
      expect(await kv.pttl(roomSessionEpochKey(TARGET))).toBe(-1);
      expect(await kv.smembers(identityKeys.rooms(CREATOR))).toContain(TARGET);
      expect(await kv.smembers(identityKeys.rooms(OTHER_CREATOR))).toEqual(expect.arrayContaining([TARGET, OTHER]));
      const again = await buildPlan(kv, TARGET);
      expect(again.keys.map((k) => k.key).sort()).toEqual(plan.keys.map((k) => k.key).sort());
    });

    describe("restore only writes keys inside the room's key set", () => {
      const legit = async () => JSON.parse(JSON.stringify(await takeSnapshot(kv, await buildPlan(kv, TARGET))));
      const wipe = async () => applyDelete(kv, await buildPlan(kv, TARGET));

      it("a forged foreign key writes nothing", async () => {
        const snap = await legit();
        await wipe();
        const after = await everything(kv);
        snap.keys.push({ key: "admin:secret", type: "string", pttl: -1, value: "x" });
        await expect(restoreSnapshot(kv, snap)).rejects.toThrow(/outside the room's key set/);
        expect(await everything(kv)).toEqual(after);
      });

      it("a foreign room's key, a foreign identity set as a key, and a pending item not in the index are refused", async () => {
        for (const key of [roomKey(OTHER), identityKeys.rooms(OTHER_CREATOR), pendingKeys.item(TARGET, "not-in-index"), `room:${TARGET}:mystery`]) {
          const snap = await legit();
          snap.keys.push({ key, type: "string", pttl: -1, value: "x" });
          expect(() => validateSnapshot(snap)).toThrow(/outside the room's key set/);
        }
      });

      it("a foreign slug, a foreign membership entry and a wrong-typed value are refused", async () => {
        const bad = await legit(); bad.slug = "Bad*Slug";
        expect(() => validateSnapshot(bad)).toThrow(RoomDeleteError);
        for (const m of ["admin:secret", "identity:*:rooms", "identity:x:rooms:extra", { key: "identity:a:rooms", member: "other" }]) {
          const snap = await legit(); snap.memberships.push(m);
          expect(() => validateSnapshot(snap)).toThrow(/outside identity/);
        }
        const typed = await legit(); typed.keys.find((k: { key: string }) => k.key === qk.queue(TARGET)).type = "set";
        expect(() => validateSnapshot(typed)).toThrow(/unexpected type/);
      });

      it("a malformed value (empty list, wrong type, non-string items) refuses the whole snapshot with zero writes", async () => {
        const base = await legit();
        await wipe();
        const after = await everything(kv);
        const q = qk.queue(TARGET);
        for (const bad of [[], "not-a-list", [1, 2], null]) {
          const snap = JSON.parse(JSON.stringify(base));
          snap.keys.find((k: { key: string }) => k.key === q).value = bad;
          await expect(restoreSnapshot(kv, snap)).rejects.toThrow(/unexpected shape/);
          expect(await everything(kv)).toEqual(after);
        }
        const str = JSON.parse(JSON.stringify(base));
        str.keys.find((k: { key: string }) => k.key === roomKey(TARGET)).value = { not: "a string" };
        await expect(restoreSnapshot(kv, str)).rejects.toThrow(/unexpected shape/);
        expect(await everything(kv)).toEqual(after);
      });

      it("a snapshot repeating a key with different values is refused with zero writes", async () => {
        const snap = await legit();
        await wipe();
        const after = await everything(kv);
        const meta = snap.keys.find((k: { key: string }) => k.key === roomKey(TARGET));
        snap.keys.push({ ...meta, value: JSON.stringify({ id: TARGET, name: "forged" }) });
        await expect(restoreSnapshot(kv, snap)).rejects.toThrow(/duplicate key/);
        expect(await everything(kv)).toEqual(after);
      });

      it("a forged snapshot never touches an existing membership set beyond SADD of its own slug", async () => {
        const snap = await legit();
        await wipe();
        const before = (await kv.smembers(identityKeys.rooms(OTHER_CREATOR))).sort();
        await restoreSnapshot(kv, snap);
        const afterSet = (await kv.smembers(identityKeys.rooms(OTHER_CREATOR))).sort();
        expect(afterSet).toEqual([...before, TARGET].sort());
        expect(await kv.smembers(identityKeys.rooms(OTHER_CREATOR))).toContain(OTHER);
      });

      it("runRestore is a dry run by default and gates --apply on the typed slug", async () => {
        const snap = await legit();
        await wipe();
        const after = await everything(kv);
        const seen: string[] = [];
        const dry = await runRestore(kv, snap, { apply: false, onPlan: () => seen.push("plan"), confirm: async () => { seen.push("prompt"); return TARGET; } });
        expect(dry.status).toBe("dry-run");
        expect(seen).toEqual(["plan"]);
        expect(await everything(kv)).toEqual(after);
        const wrong = await runRestore(kv, snap, { apply: true, confirm: async () => "nope" });
        expect(wrong.status).toBe("confirmation-mismatch");
        expect(await everything(kv)).toEqual(after);
        const ok = await runRestore(kv, snap, { apply: true, onPlan: () => seen.push("plan2"), confirm: async () => { seen.push("prompt2"); return TARGET; } });
        expect(ok.status).toBe("restored");
        expect(seen.slice(-2)).toEqual(["plan2", "prompt2"]);
        expect(await kv.get(roomKey(TARGET))).not.toBeNull();
      });
    });

    it("restore refuses to overwrite existing keys", async () => {
      const plan = await buildPlan(kv, TARGET);
      const snap = await takeSnapshot(kv, plan);
      await expect(restoreSnapshot(kv, snap)).rejects.toThrow(/refusing to restore over existing/);
    });

    it("reports (not hides) a key re-created by a concurrent writer after the delete", async () => {
      const plan = await buildPlan(kv, TARGET);
      const realDel = kv.del.bind(kv);
      let injected = false;
      kv.del = async (...ks: string[]) => {
        await realDel(...ks);
        if (!injected && ks.length > 1) { injected = true; await kv.rpush(qk.queue(TARGET), "late"); }
      };
      const left = await applyDelete(kv, plan);
      kv.del = realDel;
      expect(left.leftoverKeys).toEqual([qk.queue(TARGET)]);
      // A rerun removes it: it is on the code-derived list.
      const rerun = await applyDelete(kv, await buildPlan(kv, TARGET));
      expect(rerun.leftoverKeys).toEqual([]);
    });
  });
}

suite("room-delete on the in-memory fake", async () => {
  const kv = new MemoryKv();
  return { kv, reset: async () => kv.data.clear() };
});

const maybe = REDIS_URL ? suite : (n: string) => it.skip(`${n}: set REDIS_TEST_URL to run against a real Redis`, () => undefined);
(maybe as typeof suite)("room-delete on a real Redis", async () => {
  const r = new RespClient();
  await r.connect(REDIS_URL!);
  const kv = new RedisKv(r);
  return {
    kv,
    // Only this suite's own namespaces are cleared; the test DB is a throwaway container.
    reset: async () => {
      const ks = [...(await kv.scan(`*t151-*`)), ...(await kv.scan("identity:*"))];
      if (ks.length) await kv.del(...ks);
    },
    close: () => r.end(),
  };
});

if (REDIS_URL) {
  describe("mutateRoom's compare-and-set against a deleted room (real Redis)", () => {
    it("ROOM_CAS_SCRIPT returns 0 and creates nothing once the record is gone", async () => {
      const r = new RespClient();
      await r.connect(REDIS_URL);
      const kv = new RedisKv(r);
      await seedRoom(kv, TARGET, CREATOR);
      await applyDelete(kv, await buildPlan(kv, TARGET));
      const res = await r.cmd("EVAL", ROOM_CAS_SCRIPT, 1, roomKey(TARGET), "3", JSON.stringify({ id: TARGET, rev: 4 }), "0");
      expect(res).toBe(0);
      expect(await kv.type(roomKey(TARGET))).toBe("none");
      r.end();
    });
  });
}
