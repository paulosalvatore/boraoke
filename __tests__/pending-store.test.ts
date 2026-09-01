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
  REJECTED_PENDING_TTL_MS,
  pendingKeys,
  type PendingRedisLike,
  type PendingStore,
} from "@/lib/pending-store";
import { generatePendingId, type PendingEntry } from "@/lib/pending-types";
import type { QueueEntry } from "@/lib/store";

/** Minimal in-memory fake of the Redis subset the pending store uses. */
class FakeRedis implements PendingRedisLike {
  private kv = new Map<string, string>();
  private lists = new Map<string, string[]>();
  /** key → TTL(ms), set by pexpire. Deterministically drained by _expireNow. */
  private ttls = new Map<string, number>();

  /**
   * Call counters. `get`/`mget`/`set`/`eval` count commands the DRIVER issues
   * (i.e. network round-trips), so tests can assert batching — one mget and zero
   * per-id gets on listRoom, one eval and zero sets on the bulk reject.
   * `pexpire`/`lrem` additionally count the emulated script's own server-side
   * calls, matching what a real Redis would execute.
   */
  public calls = { get: 0, mget: 0, set: 0, pexpire: 0, lrem: 0, eval: 0 };

  /** Test-only: make EVAL fail, to exercise the driver's fail-open fallback. */
  public evalThrows = false;

  /**
   * Test-only: simulate a FULL Redis outage — every command throws, not just
   * EVAL. This is what separates an EVAL-specific blip (the fallback saves
   * the call) from an outage (the fallback throws too), which is the case
   * TICKET-56 FU-1b is about.
   */
  public allThrows = false;
  private outageGuard(): void {
    if (this.allThrows) throw new Error("Redis unreachable");
  }

  /** Test-only: simulate the TTL elapsing on a key — it vanishes like Redis expiry. */
  _expireNow(key: string): void {
    this.kv.delete(key);
    this.ttls.delete(key);
  }
  /** Test-only: read the TTL recorded on a key (undefined if none set). */
  _ttlOf(key: string): number | undefined {
    return this.ttls.get(key);
  }
  /** Test-only: current length of a list (index inspection). */
  _listLen(key: string): number {
    return (this.lists.get(key) ?? []).length;
  }

  async rpush(key: string, ...values: unknown[]): Promise<number> {
    const arr = this.lists.get(key) ?? [];
    for (const v of values) arr.push(v as string);
    this.lists.set(key, arr);
    return arr.length;
  }
  async lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]> {
    this.outageGuard();
    const arr = this.lists.get(key) ?? [];
    const end = stop === -1 ? arr.length : stop + 1;
    return arr.slice(start, end) as unknown as T[];
  }
  async lrem(key: string, _count: number, value: unknown): Promise<number> {
    this.calls.lrem++;
    const arr = this.lists.get(key) ?? [];
    const next = arr.filter((v) => v !== value);
    this.lists.set(key, next);
    return arr.length - next.length;
  }
  async get<T = unknown>(key: string): Promise<T | null> {
    this.calls.get++;
    const raw = this.kv.get(key);
    return raw != null ? (JSON.parse(raw) as T) : null;
  }
  async mget<T = unknown>(...keys: string[]): Promise<(T | null)[]> {
    this.outageGuard();
    this.calls.mget++;
    return keys.map((k) => {
      const raw = this.kv.get(k);
      return raw != null ? (JSON.parse(raw) as T) : null;
    });
  }
  async set(key: string, value: unknown): Promise<unknown> {
    this.outageGuard();
    this.calls.set++;
    this.kv.set(key, JSON.stringify(value));
    return "OK";
  }
  /**
   * Emulate REJECT_ALL_PENDING_SCRIPT. The real script runs on the Redis server
   * over the stored JSON strings; this fake applies the identical algorithm to
   * the same stored strings, synchronously — which models the script's
   * server-side atomicity (nothing can interleave mid-flip). Mirrors the
   * MERGE_SCRIPT emulation in `store.test.ts`.
   *
   * keys[0] = the room's pending index; args[0] = item-key prefix; args[1] = TTL ms.
   */
  async eval<T = unknown>(
    _script: string,
    keys: string[],
    args: unknown[],
  ): Promise<T> {
    this.calls.eval++;
    if (this.evalThrows) throw new Error("EVAL unsupported");
    const indexKey = keys[0];
    const prefix = args[0] as string;
    const ttl = Number(args[1]);
    let flipped = 0;
    for (const id of [...(this.lists.get(indexKey) ?? [])]) {
      const itemKey = prefix + id;
      const raw = this.kv.get(itemKey);
      if (raw == null) {
        // Lazy index prune: the record is gone (expired), drop its dead id.
        await this.lrem(indexKey, 0, id);
        continue;
      }
      const obj = JSON.parse(raw) as PendingEntry;
      if (obj.status !== "pending") continue;
      obj.status = "rejected";
      // Written straight to the store: this is the script's server-side SET, not
      // a driver round-trip, so it must not bump `calls.set`.
      this.kv.set(itemKey, JSON.stringify(obj));
      await this.pexpire(itemKey, ttl);
      flipped++;
    }
    return flipped as T;
  }
  async pexpire(key: string, ms: number): Promise<unknown> {
    this.calls.pexpire++;
    // Mirror Redis: PEXPIRE only sets a TTL on an existing key.
    if (this.kv.has(key)) this.ttls.set(key, ms);
    return 1;
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.kv.delete(k)) n++;
      if (this.lists.delete(k)) n++;
      this.ttls.delete(k);
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

// ─────────────────────────────────────────────────────────────────────────────
// Upstash-driver-specific: MGET batching, TTL-on-reject, lazy index prune (T-53)
// ─────────────────────────────────────────────────────────────────────────────
describe("UpstashPendingStore — batch / TTL / lazy-prune (TICKET-53)", () => {
  let fake: FakeRedis;
  let s: UpstashPendingStore;
  beforeEach(async () => {
    fake = new FakeRedis();
    s = new UpstashPendingStore(fake);
    await s.clear(ROOM);
  });

  it("listRoom issues ONE mget for all ids, not N per-id gets", async () => {
    await s.add(makePending(UUID_A));
    await s.add(makePending(UUID_A));
    await s.add(makePending(UUID_B));
    fake.calls.get = 0;
    fake.calls.mget = 0;
    const list = await s.listRoom(ROOM);
    expect(list).toHaveLength(3);
    // Exactly one batched read, zero per-id gets.
    expect(fake.calls.mget).toBe(1);
    expect(fake.calls.get).toBe(0);
  });

  it("listRoom on an empty room returns [] WITHOUT calling mget", async () => {
    fake.calls.mget = 0;
    expect(await s.listRoom(ROOM)).toEqual([]);
    expect(fake.calls.mget).toBe(0);
  });

  it("reject sets a bounded TTL on the item key with the constant", async () => {
    const p = makePending(UUID_A);
    await s.add(p);
    fake.calls.pexpire = 0;
    await s.reject(ROOM, p.pendingId);
    const key = pendingKeys.item(ROOM, p.pendingId);
    expect(fake.calls.pexpire).toBe(1);
    expect(fake._ttlOf(key)).toBe(REJECTED_PENDING_TTL_MS);
  });

  it("rejectAllPending sets the TTL on each flipped item key", async () => {
    const a1 = makePending(UUID_A);
    const a2 = makePending(UUID_A);
    await s.add(a1);
    await s.add(a2);
    fake.calls.pexpire = 0;
    expect(await s.rejectAllPending(ROOM)).toBe(2);
    expect(fake.calls.pexpire).toBe(2);
    expect(fake._ttlOf(pendingKeys.item(ROOM, a1.pendingId))).toBe(
      REJECTED_PENDING_TTL_MS,
    );
    expect(fake._ttlOf(pendingKeys.item(ROOM, a2.pendingId))).toBe(
      REJECTED_PENDING_TTL_MS,
    );
  });

  it("rejectAllPending flips in ONE eval round-trip — no listing pass, no per-item sets", async () => {
    await s.add(makePending(UUID_A));
    await s.add(makePending(UUID_A));
    await s.add(makePending(UUID_B));
    fake.calls.eval = 0;
    fake.calls.set = 0;
    fake.calls.mget = 0;
    fake.calls.get = 0;

    expect(await s.rejectAllPending(ROOM)).toBe(3);

    // The whole flip is one atomic server-side script: no read pass to race
    // against, and no O(N) client-issued writes.
    expect(fake.calls.eval).toBe(1);
    expect(fake.calls.set).toBe(0);
    expect(fake.calls.mget).toBe(0);
    expect(fake.calls.get).toBe(0);
    // …and the flip really happened.
    expect((await s.listRoom(ROOM)).every((p) => p.status === "rejected")).toBe(
      true,
    );
  });

  it("rejectAllPending leaves the index intact so patron polls still see the rejections", async () => {
    const a1 = makePending(UUID_A);
    const a2 = makePending(UUID_B);
    await s.add(a1);
    await s.add(a2);
    const indexKey = pendingKeys.index(ROOM);

    expect(await s.rejectAllPending(ROOM)).toBe(2);

    expect(fake._listLen(indexKey)).toBe(2);
    expect(await fake.lrange<string>(indexKey, 0, -1)).toEqual([
      a1.pendingId,
      a2.pendingId,
    ]);
    expect(await s.listRoom(ROOM)).toHaveLength(2);
  });

  it("rejectAllPending lazily prunes an already-expired id from the index", async () => {
    const live = makePending(UUID_A);
    const doomed = makePending(UUID_A);
    await s.add(live);
    await s.add(doomed);
    // The record vanished (TTL elapsed) but its id still sits in the index.
    fake._expireNow(pendingKeys.item(ROOM, doomed.pendingId));
    fake.calls.lrem = 0;

    // Only the live entry is flipped; the dead id is dropped, not counted.
    expect(await s.rejectAllPending(ROOM)).toBe(1);
    expect(fake.calls.lrem).toBe(1);
    expect(await fake.lrange<string>(pendingKeys.index(ROOM), 0, -1)).toEqual([
      live.pendingId,
    ]);
  });

  it("rejectAllPending on an empty room is a clean 0 and writes nothing", async () => {
    fake.calls.set = 0;
    fake.calls.pexpire = 0;
    expect(await s.rejectAllPending(ROOM)).toBe(0);
    expect(fake.calls.set).toBe(0);
    expect(fake.calls.pexpire).toBe(0);
  });

  it("rejectAllPending falls back (never throws) when EVAL is unsupported", async () => {
    const a1 = makePending(UUID_A);
    const a2 = makePending(UUID_B);
    await s.add(a1);
    await s.add(a2);
    await s.reject(ROOM, a1.pendingId); // already rejected — must stay skipped
    fake.evalThrows = true;
    fake.calls.set = 0;
    fake.calls.pexpire = 0;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    // Same observable result as the atomic path: only the still-pending entry
    // flips, and the host's moderation toggle never sees an error.
    expect(await s.rejectAllPending(ROOM)).toBe(1);
    // …but the degradation is NOT silent — a permanent failure must be visible.
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("NON-ATOMIC");
    expect(await s.countRoom(ROOM)).toBe(0);
    expect((await s.listRoom(ROOM)).every((p) => p.status === "rejected")).toBe(
      true,
    );
    // The fallback is the pre-script per-item loop: one client set + TTL.
    expect(fake.calls.set).toBe(1);
    expect(fake.calls.pexpire).toBe(1);
    expect(fake._ttlOf(pendingKeys.item(ROOM, a2.pendingId))).toBe(
      REJECTED_PENDING_TTL_MS,
    );
    // Still idempotent on the fallback path.
    expect(await s.rejectAllPending(ROOM)).toBe(0);
    warn.mockRestore();
  });

  it("rejectAllPending never throws on a FULL outage — it reports 0 flipped, loudly (FU-1b)", async () => {
    await s.add(makePending(UUID_A));
    await s.add(makePending(UUID_B));
    // Both the script AND the fallback's own commands fail: a real outage, not
    // an EVAL-specific blip.
    fake.evalThrows = true;
    fake.allThrows = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    // The contract that matters: the caller (the host's moderation toggle) is
    // never handed a rejection. Before this, the throw propagated and 500-ed the
    // route AFTER the toggle had already committed.
    await expect(s.rejectAllPending(ROOM)).resolves.toBe(0);
    // Not silent: both the EVAL failure and the fallback failure are reported.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1][0])).toContain("FALLBACK also failed");

    // And the entries really are untouched — 0 is an honest count, not a
    // swallowed success. (Recovery is the caller's next moderation-OFF write.)
    fake.evalThrows = false;
    fake.allThrows = false;
    expect(await s.countRoom(ROOM)).toBe(2);
  });

  it("after a rejected item's TTL expires, listRoom omits it AND lazily lrem's its dead id", async () => {
    const live = makePending(UUID_A);
    const doomed = makePending(UUID_A);
    await s.add(live);
    await s.add(doomed);
    await s.reject(ROOM, doomed.pendingId);
    const indexKey = pendingKeys.index(ROOM);
    // Both ids still indexed right after reject (id lingers until pruned).
    expect(fake._listLen(indexKey)).toBe(2);

    // Simulate the TTL elapsing — the item record vanishes like real Redis expiry.
    fake._expireNow(pendingKeys.item(ROOM, doomed.pendingId));
    fake.calls.lrem = 0;

    const list = await s.listRoom(ROOM);
    // The expired entry is omitted; only the live one remains.
    expect(list.map((p) => p.pendingId)).toEqual([live.pendingId]);
    // Its dead id was lazily lrem'd, shrinking the index to just the live id.
    expect(fake.calls.lrem).toBe(1);
    expect(fake._listLen(indexKey)).toBe(1);
    // A live record's id is NEVER pruned.
    expect(await fake.lrange<string>(indexKey, 0, -1)).toEqual([live.pendingId]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TICKET-63 (TICKET-56 FU-5) — pin the cjson string/boolean-only invariant.
//
// REJECT_ALL_PENDING_SCRIPT (lib/pending-store.ts) decodes every persisted
// PendingEntry with Lua's `cjson.decode`, flips `status`, then re-encodes it
// with `cjson.encode`. That round-trip is documented as lossless "because
// every persisted field is a string or boolean" — but nothing enforces that
// claim except the code comment. cjson.encode reformats any Lua *number*
// through `%.14g` on the way back out, so a numeric field slipped into
// PendingEntry/QueueEntry (e.g. a `durationSeconds: number`) would silently
// come back reformatted/truncated in production, with no test ever failing.
//
// Two independent, complementary checks below (neither is a hand-maintained
// list of field names, so neither silently drifts as the shape evolves):
//
//   1. A recursive TYPE-LEVEL check over the REAL `PendingEntry`/`QueueEntry`
//      types, structurally covering every key (present or not, required or
//      optional) without naming any of them. This is a type-only construct —
//      ts-jest runs with `isolatedModules: true` (jest.config.ts), which
//      strips types before executing, so `npm test` alone can NEVER observe
//      this fail. It is enforced ONLY by running `npx tsc --noEmit` — that is
//      why this ticket's dev/reviewer verification runs tsc as a separate,
//      mandatory step, not merely `npm test`.
//   2. A RUNTIME check that drives the actual `UpstashPendingStore
//      .rejectAllPending` path (the real production code under test, against
//      the FakeRedis emulation of the Lua script already used above) with a
//      maximally-populated representative entry, then recursively walks the
//      round-tripped record asserting every leaf is a string/boolean/null —
//      i.e. it inspects the ACTUAL persisted shape that came back through the
//      cjson-emulating path, not a duplicated list of expected keys.
// ─────────────────────────────────────────────────────────────────────────────

/** Leaf types cjson can round-trip losslessly (see the hazard note above). */
type CjsonSafeLeaf = string | boolean | null | undefined;

/**
 * Recursively true only if every leaf of T is a `CjsonSafeLeaf`. Structural
 * over `keyof T` — it does not name a single field, so it automatically
 * covers any field added later to `PendingEntry` or `QueueEntry`. A numeric
 * (or any other non-string/boolean) leaf makes this resolve to `false`,
 * which fails the assignment below with a TS2322 error — but ONLY under
 * `tsc`, never under `jest` (see the file-header note: ts-jest here strips
 * types via `isolatedModules`).
 */
type AssertCjsonSafe<T> = T extends CjsonSafeLeaf
  ? true
  : T extends readonly (infer U)[]
    ? AssertCjsonSafe<U>
    : T extends object
      ? // `-?` strips the optional modifier from the MAPPED TYPE (not from the
        // value types): a homomorphic mapped type over a generic T otherwise
        // preserves each key's "?", and indexing `{...}[keyof T]` then folds in
        // a spurious extra `| undefined` for every optional field — which made
        // this evaluate to `false` even when every field was already safe.
        { [K in keyof T]-?: AssertCjsonSafe<T[K]> }[keyof T] extends true
        ? true
        : false
      : false;

// PIN: if a numeric field (or anything else that isn't string/boolean) is
// ever added to PendingEntry or QueueEntry, ONE of these two lines fails to
// compile under `npx tsc --noEmit` — jest/ts-jest will NOT catch it (see
// above). The failure is a generic TS2322 ("Type 'false' is not assignable
// to type 'true'") on the line below; when you see it, the field you just
// added is the reason: it can't safely cross `lib/pending-store.ts`'s Lua
// `cjson` round-trip (REJECT_ALL_PENDING_SCRIPT) without either a
// string-encoded representation or a script update. See TICKET-56 FU-5.
const _pendingEntryIsCjsonSafe: AssertCjsonSafe<PendingEntry> = true;
const _queueEntryIsCjsonSafe: AssertCjsonSafe<QueueEntry> = true;
void _pendingEntryIsCjsonSafe;
void _queueEntryIsCjsonSafe;

/**
 * Recursively assert that every leaf of `value` is a string, boolean, or
 * null (arrays/plain objects are walked). Throws an Error whose message
 * explains the cjson `%.14g` hazard and points at the offending path and the
 * source file, rather than a bare assertion failure.
 */
function assertCjsonSafeShape(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertCjsonSafeShape(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertCjsonSafeShape(v, `${path}.${k}`);
    }
    return;
  }
  throw new Error(
    `cjson round-trip hazard at ${path}: value is a ${typeof value} ` +
      `(${JSON.stringify(value)}), not a string/boolean/null.\n` +
      `lib/pending-store.ts's REJECT_ALL_PENDING_SCRIPT decodes every persisted ` +
      `PendingEntry with Lua's cjson.decode and re-encodes it with cjson.encode. ` +
      `That round-trip is lossless ONLY because every persisted field today is a ` +
      `string or boolean — cjson.encode reformats any Lua number through "%.14g" ` +
      `on the way back out, which would silently corrupt a large integer id or ` +
      `truncate a float's precision. A new numeric field needs an explicit ` +
      `string-encoded representation (or the Lua script needs updating) before ` +
      `it is safe to persist through this path. See TICKET-56 FU-5 / TICKET-63.`,
  );
}

describe("cjson string/boolean-only invariant (TICKET-56 FU-5 / TICKET-63)", () => {
  it("assertCjsonSafeShape is not a tautology: it throws on an injected numeric leaf", () => {
    expect(() =>
      assertCjsonSafeShape({ status: "pending", durationSeconds: 42 }, "PendingEntry"),
    ).toThrow(/cjson/i);
    expect(() =>
      assertCjsonSafeShape({ status: "pending", durationSeconds: 42 }, "PendingEntry"),
    ).toThrow(/%\.14g/);
  });

  it("assertCjsonSafeShape passes a string/boolean/null-only shape", () => {
    expect(() =>
      assertCjsonSafeShape(
        { a: "x", b: true, c: null, d: ["y", false], e: { f: "z" } },
        "root",
      ),
    ).not.toThrow();
  });

  it("the ACTUAL round-tripped PendingEntry (real rejectAllPending, Lua-emulating path) stays string/boolean/null-only", async () => {
    const fake = new FakeRedis();
    const s = new UpstashPendingStore(fake);
    await s.clear(ROOM);

    // Maximally populated: every optional QueueEntry/PendingEntry field set,
    // so this instance actually exercises the fields the type check covers.
    const full = makePending(UUID_A, {
      title: "Total Eclipse of the Heart",
      table: "12",
      graceRequeue: true,
    });
    await s.add(full);

    // Drives the real production method under test, against the same
    // Lua-script-emulating FakeRedis.eval used throughout this file.
    expect(await s.rejectAllPending(ROOM)).toBe(1);

    const roundTripped = await s.get(ROOM, full.pendingId);
    expect(roundTripped).not.toBeNull();
    expect(roundTripped?.status).toBe("rejected");

    // The actual persisted shape, not a hand-maintained list of field names.
    assertCjsonSafeShape(roundTripped, "PendingEntry");
  });
});
