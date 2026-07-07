/**
 * TICKET-10 — rotation adapter (`lib/rotation.ts`) integration tests.
 *
 * These exercise the engine THROUGH the app boundary: app `QueueEntry` shapes,
 * the effective-order composition over a store queue (pinned now-playing), and
 * submit-time cap enforcement with the friendly pt-BR copy. They cover the spec
 * ACs that are visible at the adapter layer (AC1-AC5) plus the mode-switch
 * reorder and grace ordering.
 */

import { orderQueue, checkSubmit, relayQueue } from "@/lib/rotation";
import { store, type QueueEntry } from "@/lib/store";
import type { RoomMode } from "@/lib/rotation-modes";

let seq = 0;
function entry(p: Partial<QueueEntry> & { id: string }): QueueEntry {
  seq += 1;
  return {
    id: p.id,
    videoId: p.videoId ?? `vid-${p.id}`,
    title: p.title,
    nickname: p.nickname ?? `nick-${p.id}`,
    patronUuid: p.patronUuid ?? `uuid-${p.id}`,
    table: p.table,
    mode: p.mode ?? "sing",
    // deterministic increasing ISO timestamps in submission order
    submittedAt: p.submittedAt ?? `2026-07-06T00:00:${String(seq).padStart(2, "0")}.000Z`,
    graceRequeue: p.graceRequeue,
  };
}
const ids = (items: QueueEntry[]) => items.map((e) => e.id);

describe("orderQueue — effective order (now-playing pinned at index 0)", () => {
  it("AC1: full-karaoke is round-robin by uuid, not FIFO", () => {
    // A submits 3 (A1 now-playing), B submits 1 -> play order A1, B1, A2, A3.
    const items = [
      entry({ id: "A1", patronUuid: "A" }),
      entry({ id: "A2", patronUuid: "A" }),
      entry({ id: "A3", patronUuid: "A" }),
      entry({ id: "B1", patronUuid: "B" }),
    ];
    expect(ids(orderQueue(items, "full-karaoke"))).toEqual(["A1", "B1", "A2", "A3"]);
  });

  it("AC2: per-table-2 round-robins tables; a table's 3rd lands in round 2", () => {
    // Lead with a listen now-playing so it doesn't seed any sing group.
    const items = [
      entry({ id: "NP", mode: "listen-dance", patronUuid: "np" }),
      entry({ id: "T1a", table: "1", patronUuid: "u1" }),
      entry({ id: "T1b", table: "1", patronUuid: "u2" }),
      entry({ id: "T1c", table: "1", patronUuid: "u3" }),
      entry({ id: "T2a", table: "2", patronUuid: "u4" }),
      entry({ id: "T2b", table: "2", patronUuid: "u5" }),
    ];
    const order = ids(orderQueue(items, "per-table-2"));
    expect(order[0]).toBe("NP");
    // round 1: one from each table (interleaved), round 2: T1's third.
    expect(order.slice(1)).toEqual(["T1a", "T2a", "T1b", "T2b", "T1c"]);
    expect(order.indexOf("T1c")).toBe(5); // T1's 3rd is last (round 2)
  });

  it("AC4: listen entries play only after every pending sing (spec policy)", () => {
    const items = [
      entry({ id: "NP", patronUuid: "np" }), // sing now-playing
      entry({ id: "L1", mode: "listen-dance", patronUuid: "x" }),
      entry({ id: "S1", patronUuid: "u1" }),
      entry({ id: "L2", mode: "listen-dance", patronUuid: "y" }),
      entry({ id: "S2", patronUuid: "u2" }),
    ];
    const order = ids(orderQueue(items, "full-karaoke"));
    // every sing before any listen; listens keep FIFO among themselves
    expect(order).toEqual(["NP", "S1", "S2", "L1", "L2"]);
  });

  it("AC5: mode switch mid-queue reorders the SAME entries, losing none", () => {
    const items = [
      entry({ id: "NP", mode: "listen-dance", patronUuid: "np" }),
      entry({ id: "a", patronUuid: "u1", table: "1" }),
      entry({ id: "b", patronUuid: "u1", table: "1" }),
      entry({ id: "c", patronUuid: "u2", table: "2" }),
    ];
    const full = ids(orderQueue(items, "full-karaoke"));
    const person = ids(orderQueue(items, "per-person-1"));
    const table = ids(orderQueue(items, "per-table-2"));
    // full-karaoke & per-person share uuid round-robin: u1(a), u2(c), u1(b)
    expect(full.slice(1)).toEqual(["a", "c", "b"]);
    expect(person.slice(1)).toEqual(["a", "c", "b"]);
    // per-table round-robin by table: t1(a), t2(c), t1(b)
    expect(table.slice(1)).toEqual(["a", "c", "b"]);
    // every switch preserves the full set (no drops, no dupes)
    for (const ord of [full, person, table]) {
      expect([...ord].sort()).toEqual(["NP", "a", "b", "c"]);
    }
  });

  it("grace: a graceRequeue entry leads its group's slot", () => {
    const items = [
      entry({ id: "NP", mode: "listen-dance", patronUuid: "np" }),
      entry({ id: "a1", patronUuid: "u1" }),
      entry({ id: "a2", patronUuid: "u1" }),
      entry({ id: "g", patronUuid: "u1", graceRequeue: true }),
    ];
    // u1's bucket: grace first, then submission order
    expect(ids(orderQueue(items, "full-karaoke")).slice(1)).toEqual(["g", "a1", "a2"]);
  });

  it("orderQueue is idempotent (already-effective order is a fixpoint)", () => {
    const items = [
      entry({ id: "A1", patronUuid: "A" }),
      entry({ id: "A2", patronUuid: "A" }),
      entry({ id: "B1", patronUuid: "B" }),
    ];
    const once = orderQueue(items, "full-karaoke");
    const twice = orderQueue(once, "full-karaoke");
    expect(ids(twice)).toEqual(ids(once));
  });
});

describe("checkSubmit — submit-time enforcement + friendly copy", () => {
  const mk = (id: string, p: Partial<QueueEntry> = {}) => entry({ id, ...p });

  it("AC3: per-person-1 rejects a 3rd sing but still accepts a listen", () => {
    const q = [mk("a", { patronUuid: "U" }), mk("b", { patronUuid: "U" })];
    const sing = checkSubmit(q, mk("c", { patronUuid: "U" }), "per-person-1");
    expect(sing.ok).toBe(false);
    if (!sing.ok) {
      expect(sing.reason).toBe("cap");
      expect(sing.message).toMatch(/já tem 2 músicas/i);
    }
    const listen = checkSubmit(q, mk("d", { patronUuid: "U", mode: "listen-dance" }), "per-person-1");
    expect(listen.ok).toBe(true);
  });

  it("per-table-2 rejects the 5th queued sing for a table (cap 4)", () => {
    const q = ["a", "b", "c", "d"].map((id, i) => mk(id, { table: "7", patronUuid: `u${i}` }));
    const r = checkSubmit(q, mk("e", { table: "7", patronUuid: "u9" }), "per-table-2");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/mesa já tem 4/i);
  });

  it("per-table-2 requires a table for a sing entry (AC8 guardrail)", () => {
    const r = checkSubmit([], mk("x", { table: undefined }), "per-table-2");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("table-required");
      expect(r.message).toMatch(/informe o número da sua mesa/i);
    }
    // listen entries don't need a table
    expect(checkSubmit([], mk("l", { mode: "listen-dance", table: undefined }), "per-table-2").ok).toBe(true);
  });

  it("rejects an exact duplicate (same uuid + video + mode); allows a different singer", () => {
    const q = [mk("a", { patronUuid: "U", videoId: "song1" })];
    const dup = checkSubmit(q, mk("b", { patronUuid: "U", videoId: "song1" }), "full-karaoke");
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toBe("duplicate");
    const other = checkSubmit(q, mk("c", { patronUuid: "V", videoId: "song1" }), "full-karaoke");
    expect(other.ok).toBe(true);
  });

  it("caps pending listen entries per uuid (anti-spam, 3)", () => {
    const q = ["a", "b", "c"].map((id) => mk(id, { patronUuid: "U", mode: "listen-dance" }));
    const r = checkSubmit(q, mk("d", { patronUuid: "U", mode: "listen-dance" }), "full-karaoke");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/3 pedidos/);
  });

  it("full-karaoke never caps sing submissions", () => {
    const q = ["a", "b", "c", "d", "e"].map((id) => mk(id, { patronUuid: "U", videoId: `v${id}` }));
    expect(checkSubmit(q, mk("f", { patronUuid: "U", videoId: "vf" }), "full-karaoke").ok).toBe(true);
  });
});

describe("relayQueue — single bulk store op (security MEDIUM-1, PR #14)", () => {
  const ROOM = "relay-room";
  afterEach(async () => {
    jest.restoreAllMocks();
    await store.clear(ROOM);
  });

  it("issues exactly ONE store.rewrite call and ZERO reorder calls", async () => {
    await store.addEntry(ROOM, entry({ id: "A1", patronUuid: "A" }));
    await store.addEntry(ROOM, entry({ id: "A2", patronUuid: "A" }));
    await store.addEntry(ROOM, entry({ id: "B1", patronUuid: "B" }));

    const rewriteSpy = jest.spyOn(store, "rewrite");
    const reorderSpy = jest.spyOn(store, "reorder");
    await relayQueue(ROOM, "full-karaoke");

    expect(rewriteSpy).toHaveBeenCalledTimes(1);
    expect(reorderSpy).not.toHaveBeenCalled();
    // and the store now holds the effective order (A1 pinned, then RR)
    expect((await store.getQueue(ROOM)).map((e) => e.id)).toEqual(["A1", "B1", "A2"]);
  });

  it("no-ops (no store write) on a 0/1-entry queue", async () => {
    await store.addEntry(ROOM, entry({ id: "only" }));
    const rewriteSpy = jest.spyOn(store, "rewrite");
    await relayQueue(ROOM, "per-table-2");
    expect(rewriteSpy).not.toHaveBeenCalled();
  });

  it("CONCURRENCY REGRESSION: a submit that races the relay is never lost (TICKET-21)", async () => {
    // The exact PR #14 opus-review failure, end-to-end through relayQueue: a
    // concurrent addEntry lands AFTER the relay reads but BEFORE it writes.
    await store.addEntry(ROOM, entry({ id: "np", patronUuid: "A" }));
    await store.addEntry(ROOM, entry({ id: "x", patronUuid: "B" }));

    // The relay will read this stale snapshot (it never sees "late")...
    const stale = await store.getQueue(ROOM); // [np, x]
    jest.spyOn(store, "getQueue").mockResolvedValueOnce(stale);
    // ...while a concurrent patron submit is durably appended.
    await store.addEntry(ROOM, entry({ id: "late", patronUuid: "C" }));

    await relayQueue(ROOM, "full-karaoke");

    // Under the old wholesale rewrite, "late" was permanently dropped. The merge
    // preserves it (re-appended after the relaid order).
    const ids = (await store.getQueue(ROOM)).map((e) => e.id);
    expect(ids).toContain("late");
  });
});

// keep RoomMode referenced (type-only import guard for isolatedModules)
const _modes: RoomMode[] = ["full-karaoke", "per-table-2", "per-person-1"];
void _modes;
