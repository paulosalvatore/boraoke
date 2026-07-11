/**
 * Pending-moderation store tests (TICKET-44) — exercises BOTH drivers against the
 * same contract: the in-process memory driver AND the Upstash driver (via an
 * injected fake redis, so no network/credentials). Covers add / listRoom /
 * listForUuid (uuid isolation) / get / take (approval pop) / reject / the room
 * and per-uuid pending-count caps / clear. Mirrors `feedback-store.test.ts`.
 */
import {
  MemoryPendingStore,
  UpstashPendingStore,
  type PendingRedisLike,
  type PendingStore,
} from "@/lib/pending-store";
import { generatePendingId, type PendingEntry } from "@/lib/pending-types";
import type { QueueEntry } from "@/lib/store";

/** Minimal in-memory fake of the Redis subset the pending store uses. */
class FakeRedis implements PendingRedisLike {
  private kv = new Map<string, string>();
  private lists = new Map<string, string[]>();

  async rpush(key: string, ...values: unknown[]): Promise<number> {
    const arr = this.lists.get(key) ?? [];
    for (const v of values) arr.push(v as string);
    this.lists.set(key, arr);
    return arr.length;
  }
  async lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]> {
    const arr = this.lists.get(key) ?? [];
    const end = stop === -1 ? arr.length : stop + 1;
    return arr.slice(start, end) as unknown as T[];
  }
  async lrem(key: string, _count: number, value: unknown): Promise<number> {
    const arr = this.lists.get(key) ?? [];
    const next = arr.filter((v) => v !== value);
    this.lists.set(key, next);
    return arr.length - next.length;
  }
  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = this.kv.get(key);
    return raw != null ? (JSON.parse(raw) as T) : null;
  }
  async set(key: string, value: unknown): Promise<unknown> {
    this.kv.set(key, JSON.stringify(value));
    return "OK";
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.kv.delete(k)) n++;
      if (this.lists.delete(k)) n++;
    }
    return n;
  }
}

const ROOM = "bar-do-ze";
const UUID_A = "123e4567-e89b-42d3-a456-426614174000";
const UUID_B = "223e4567-e89b-42d3-a456-426614174111";

function makeEntry(uuid: string, over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: crypto.randomUUID(),
    videoId: "dQw4w9WgXcQ",
    title: "A song",
    nickname: "Zé",
    patronUuid: uuid,
    mode: "sing",
    submittedAt: new Date().toISOString(),
    ...over,
  };
}

let seq = 0;
function makePending(uuid: string, over: Partial<QueueEntry> = {}): PendingEntry {
  // Distinct, monotonically-increasing pendingIds so chronological order is stable.
  const pendingId = generatePendingId(Date.now() + seq++);
  return {
    pendingId,
    roomId: ROOM,
    entry: makeEntry(uuid, over),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

const drivers: Array<[string, () => PendingStore]> = [
  ["MemoryPendingStore", () => new MemoryPendingStore()],
  ["UpstashPendingStore(FakeRedis)", () => new UpstashPendingStore(new FakeRedis())],
];

describe.each(drivers)("PendingStore conformance — %s", (_name, make) => {
  let s: PendingStore;
  beforeEach(async () => {
    s = make();
    await s.clear(ROOM);
  });

  it("add + listRoom returns entries oldest-first", async () => {
    const p1 = makePending(UUID_A);
    const p2 = makePending(UUID_B);
    await s.add(p1);
    await s.add(p2);
    const list = await s.listRoom(ROOM);
    expect(list.map((p) => p.pendingId)).toEqual([p1.pendingId, p2.pendingId]);
  });

  it("get fetches by id, null when absent", async () => {
    const p = makePending(UUID_A);
    await s.add(p);
    expect((await s.get(ROOM, p.pendingId))?.pendingId).toBe(p.pendingId);
    expect(await s.get(ROOM, "nope")).toBeNull();
  });

  it("listForUuid isolates one patron from another", async () => {
    const a1 = makePending(UUID_A);
    const a2 = makePending(UUID_A);
    const b1 = makePending(UUID_B);
    await s.add(a1);
    await s.add(b1);
    await s.add(a2);
    const forA = await s.listForUuid(ROOM, UUID_A);
    expect(forA.map((p) => p.pendingId).sort()).toEqual(
      [a1.pendingId, a2.pendingId].sort(),
    );
    expect(forA.every((p) => p.entry.patronUuid === UUID_A)).toBe(true);
    const forB = await s.listForUuid(ROOM, UUID_B);
    expect(forB.map((p) => p.pendingId)).toEqual([b1.pendingId]);
  });

  it("take pops the entry for approval and removes it", async () => {
    const p = makePending(UUID_A);
    await s.add(p);
    const taken = await s.take(ROOM, p.pendingId);
    expect(taken?.pendingId).toBe(p.pendingId);
    expect(taken?.entry.patronUuid).toBe(UUID_A);
    // Gone from every read after take.
    expect(await s.get(ROOM, p.pendingId)).toBeNull();
    expect(await s.listRoom(ROOM)).toEqual([]);
    // A second take is a no-op (null) — idempotent, never double-approves.
    expect(await s.take(ROOM, p.pendingId)).toBeNull();
  });

  it("reject flips status and keeps it readable, but off the count", async () => {
    const p = makePending(UUID_A);
    await s.add(p);
    const rejected = await s.reject(ROOM, p.pendingId);
    expect(rejected?.status).toBe("rejected");
    // Still visible to the patron's poll (so they see the rejected state)…
    const forA = await s.listForUuid(ROOM, UUID_A);
    expect(forA[0].status).toBe("rejected");
    // …but no longer counts against the caps, and can't be taken/approved.
    expect(await s.countRoom(ROOM)).toBe(0);
    expect(await s.take(ROOM, p.pendingId)).toBeNull();
    // Re-rejecting is a no-op.
    expect(await s.reject(ROOM, p.pendingId)).toBeNull();
  });

  it("rejectAllPending flips every pending entry, returns the count, is idempotent", async () => {
    const a1 = makePending(UUID_A);
    const a2 = makePending(UUID_A);
    const b1 = makePending(UUID_B);
    await s.add(a1);
    await s.add(a2);
    await s.add(b1);
    // Pre-reject one so it's already "rejected" and must be left untouched.
    await s.reject(ROOM, a1.pendingId);

    // Flips the two still-pending entries; the already-rejected one is skipped.
    expect(await s.rejectAllPending(ROOM)).toBe(2);
    expect(await s.countRoom(ROOM)).toBe(0);
    const all = await s.listRoom(ROOM);
    expect(all.every((p) => p.status === "rejected")).toBe(true);
    // The pre-rejected entry stayed readable/rejected (never touched).
    expect((await s.get(ROOM, a1.pendingId))?.status).toBe("rejected");
    expect(all).toHaveLength(3);
    // Patron polls still surface them as rejected (not deleted).
    expect((await s.listForUuid(ROOM, UUID_B))[0].status).toBe("rejected");

    // Idempotent: a second call finds nothing pending and rejects 0.
    expect(await s.rejectAllPending(ROOM)).toBe(0);
  });

  it("rejectAllPending on a room with no pending entries is a clean 0", async () => {
    expect(await s.rejectAllPending(ROOM)).toBe(0);
  });

  it("countRoom / countUuid count only PENDING entries", async () => {
    const a1 = makePending(UUID_A);
    const a2 = makePending(UUID_A);
    const b1 = makePending(UUID_B);
    await s.add(a1);
    await s.add(a2);
    await s.add(b1);
    expect(await s.countRoom(ROOM)).toBe(3);
    expect(await s.countUuid(ROOM, UUID_A)).toBe(2);
    expect(await s.countUuid(ROOM, UUID_B)).toBe(1);
    // Rejecting one A drops both the room and the A count.
    await s.reject(ROOM, a1.pendingId);
    expect(await s.countRoom(ROOM)).toBe(2);
    expect(await s.countUuid(ROOM, UUID_A)).toBe(1);
    // Approving (take) the other A drops it too.
    await s.take(ROOM, a2.pendingId);
    expect(await s.countUuid(ROOM, UUID_A)).toBe(0);
    expect(await s.countRoom(ROOM)).toBe(1);
  });

  it("clear wipes a room's pending state", async () => {
    await s.add(makePending(UUID_A));
    await s.add(makePending(UUID_B));
    await s.clear(ROOM);
    expect(await s.listRoom(ROOM)).toEqual([]);
    expect(await s.countRoom(ROOM)).toBe(0);
  });

  it("rooms are isolated from each other", async () => {
    const other = "outro-bar";
    await s.clear(other);
    const here = makePending(UUID_A);
    await s.add(here);
    expect((await s.listRoom(other)).length).toBe(0);
    expect(await s.countRoom(other)).toBe(0);
  });

  it("rejectAllPending is room-scoped — it never touches another room", async () => {
    const other = "outro-bar";
    await s.clear(other);
    const here = makePending(UUID_A);
    const there = { ...makePending(UUID_A), roomId: other };
    await s.add(here);
    await s.add(there);
    // Reject this room's pending; the other room's entry stays pending.
    expect(await s.rejectAllPending(ROOM)).toBe(1);
    expect(await s.countRoom(other)).toBe(1);
    expect((await s.get(other, there.pendingId))?.status).toBe("pending");
  });
});
