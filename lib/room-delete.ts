/**
 * Room deletion engine (ops path, driven by scripts/delete-room.ts).
 *
 * Deletes ONE room's Redis footprint by an explicit key list derived from the
 * key builders the app itself writes with, never by a wildcard delete. A SCAN is
 * used only as a cross-check that reports keys the code-derived list missed, and
 * any such key makes the plan non-applicable. Every deletion is preceded by a
 * snapshot (value + TTL of every key) so the operation can be reversed.
 *
 * Race with `mutateRoom`: the record is deleted FIRST. `ROOM_CAS_SCRIPT` returns
 * "missing" for an absent record and never creates one, so a compare-and-set that
 * lands after the delete cannot resurrect the room, and one that lands before it
 * is deleted along with the record it wrote. Keys that other writers can re-create
 * after the delete (a queue push, the session-epoch counter) are caught by the
 * post-delete verification, which reports them; a rerun removes them because they
 * are all on the code-derived list.
 *
 * Pure of `server-only` itself; the key builders it imports carry that marker, so
 * the CLI stubs it before requiring this module.
 */
import { roomKey, roomSessionEpochKey, isValidRoomId } from "./rooms";
import { keys as queueKeys } from "./store/types";
import { pendingKeys } from "./pending-store";
import { revokeKey } from "./host-auth";
import { redisKey as counterKey } from "./rate-limit-counter";
import { identityKeys } from "./identity-store";

export type KvType = "string" | "list" | "set" | "zset" | "hash";

/** The Redis subset the engine needs; implemented over Upstash REST (CLI) and over raw RESP (tests). */
export interface Kv {
  scan(match: string): Promise<string[]>;
  type(key: string): Promise<KvType | "none">;
  pttl(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  lrange(key: string): Promise<string[]>;
  smembers(key: string): Promise<string[]>;
  zrange(key: string): Promise<Array<[string, number]>>;
  hgetall(key: string): Promise<Record<string, string>>;
  del(...keys: string[]): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  set(key: string, value: string): Promise<void>;
  rpush(key: string, ...values: string[]): Promise<void>;
  sadd(key: string, ...members: string[]): Promise<void>;
  zadd(key: string, entries: Array<[string, number]>): Promise<void>;
  hset(key: string, record: Record<string, string>): Promise<void>;
  pexpire(key: string, ms: number): Promise<void>;
}

export interface PlannedKey {
  key: string;
  source: string;
}

export interface DeletePlan {
  slug: string;
  /** Code-derived keys that currently exist, with where in the code they come from. */
  keys: PlannedKey[];
  /** Code-derived keys that do not exist right now (informational). */
  absent: string[];
  /** `identity:<uuid>:rooms` sets that contain the slug. */
  memberships: string[];
  /** Keys under `room:<slug>:` that the code-derived list did not account for. Non-empty = refuse to apply. */
  unaccounted: string[];
}

export interface SnapshotKey {
  key: string;
  type: KvType;
  /** Remaining TTL in ms at snapshot time; -1 = no expiry. */
  pttl: number;
  value: unknown;
}

export interface Snapshot {
  version: 1;
  slug: string;
  takenAt: string;
  keys: SnapshotKey[];
  memberships: string[];
}

/** Where each code-derived key comes from, for the printed plan. */
const SRC = {
  meta: "lib/rooms.ts roomKey",
  epoch: "lib/rooms.ts roomSessionEpochKey",
  queue: "lib/store/types.ts keys.queue",
  paused: "lib/store/types.ts keys.paused",
  pendingIndex: "lib/pending-store.ts pendingKeys.index",
  pendingItem: "lib/pending-store.ts pendingKeys.item (ids from the pending index)",
  revoke: "lib/host-auth.ts revokeKey via lib/rate-limit-counter.ts redisKey",
} as const;

export class RoomDeleteError extends Error {}

export function assertSlug(slug: unknown): asserts slug is string {
  if (!isValidRoomId(slug)) throw new RoomDeleteError(`not a valid room slug: ${JSON.stringify(slug)}`);
}

export async function buildPlan(kv: Kv, slug: string): Promise<DeletePlan> {
  assertSlug(slug);
  const derived: PlannedKey[] = [
    { key: roomKey(slug), source: SRC.meta },
    { key: roomSessionEpochKey(slug), source: SRC.epoch },
    { key: queueKeys.queue(slug), source: SRC.queue },
    { key: queueKeys.paused(slug), source: SRC.paused },
    { key: pendingKeys.index(slug), source: SRC.pendingIndex },
    { key: counterKey(revokeKey(slug)), source: SRC.revoke },
  ];
  const indexKey = pendingKeys.index(slug);
  if ((await kv.type(indexKey)) === "list") {
    for (const id of await kv.lrange(indexKey)) {
      derived.push({ key: pendingKeys.item(slug, id), source: SRC.pendingItem });
    }
  }
  const existing: PlannedKey[] = [];
  const absent: string[] = [];
  for (const d of derived) {
    if ((await kv.type(d.key)) === "none") absent.push(d.key);
    else existing.push(d);
  }

  // Cross-check only: report, never delete, anything the list above missed.
  const known = new Set(derived.map((d) => d.key));
  const found = await kv.scan(`room:${slug}:*`);
  const unaccounted = found.filter((k) => !known.has(k)).sort();

  // Membership: the room record names its creator when the code linked one; the
  // read-only scan over identity sets also finds legacy rooms with no creator link.
  const memberships = new Set<string>();
  const metaRaw = await kv.get(roomKey(slug));
  if (metaRaw) {
    try {
      const creator = (JSON.parse(metaRaw) as { creatorUuid?: unknown }).creatorUuid;
      if (typeof creator === "string" && creator) {
        const setKey = identityKeys.rooms(creator);
        if ((await kv.type(setKey)) === "set" && (await kv.smembers(setKey)).includes(slug)) {
          memberships.add(setKey);
        }
      }
    } catch {
      /* unparseable record: the scan below still finds memberships */
    }
  }
  for (const setKey of await kv.scan("identity:*:rooms")) {
    if ((await kv.type(setKey)) === "set" && (await kv.smembers(setKey)).includes(slug)) {
      memberships.add(setKey);
    }
  }

  return {
    slug,
    keys: existing,
    absent,
    memberships: [...memberships].sort(),
    unaccounted,
  };
}

export function isApplicable(plan: DeletePlan): { ok: true } | { ok: false; reason: string } {
  if (plan.unaccounted.length > 0) {
    return { ok: false, reason: `refusing: keys under room:${plan.slug}: not on the code-derived list: ${plan.unaccounted.join(", ")}` };
  }
  if (plan.keys.length === 0 && plan.memberships.length === 0) {
    return { ok: false, reason: `nothing to delete: no key or membership exists for room "${plan.slug}"` };
  }
  return { ok: true };
}

export async function takeSnapshot(kv: Kv, plan: DeletePlan): Promise<Snapshot> {
  const out: SnapshotKey[] = [];
  for (const { key } of plan.keys) {
    const type = await kv.type(key);
    if (type === "none") continue; // expired between plan and snapshot
    const pttl = await kv.pttl(key);
    let value: unknown;
    if (type === "string") value = await kv.get(key);
    else if (type === "list") value = await kv.lrange(key);
    else if (type === "set") value = await kv.smembers(key);
    else if (type === "zset") value = await kv.zrange(key);
    else if (type === "hash") value = await kv.hgetall(key);
    else throw new RoomDeleteError(`unsupported type ${String(type)} at ${key}; refusing`);
    out.push({ key, type, pttl, value });
  }
  return { version: 1, slug: plan.slug, takenAt: new Date().toISOString(), keys: out, memberships: plan.memberships };
}

export async function applyDelete(kv: Kv, plan: DeletePlan): Promise<{ leftoverKeys: string[]; leftoverMemberships: string[] }> {
  const gate = isApplicable(plan);
  if (!gate.ok) throw new RoomDeleteError(gate.reason);
  // Record first: from here on no compare-and-set can commit to this room.
  const meta = roomKey(plan.slug);
  if (plan.keys.some((k) => k.key === meta)) await kv.del(meta);
  const rest = plan.keys.map((k) => k.key).filter((k) => k !== meta);
  if (rest.length > 0) await kv.del(...rest);
  for (const setKey of plan.memberships) await kv.srem(setKey, plan.slug);

  const after = await buildPlan(kv, plan.slug);
  return { leftoverKeys: [...after.keys.map((k) => k.key), ...after.unaccounted], leftoverMemberships: after.memberships };
}

export async function restoreSnapshot(kv: Kv, snap: Snapshot): Promise<void> {
  if (snap?.version !== 1) throw new RoomDeleteError("unrecognised snapshot version");
  assertSlug(snap.slug);
  const clashes: string[] = [];
  for (const k of snap.keys) {
    if ((await kv.type(k.key)) !== "none") clashes.push(k.key);
  }
  if (clashes.length > 0) {
    throw new RoomDeleteError(`refusing to restore over existing keys: ${clashes.join(", ")}`);
  }
  // The record goes back LAST, so the room only reappears once it is complete.
  const meta = roomKey(snap.slug);
  const ordered = [...snap.keys.filter((k) => k.key !== meta), ...snap.keys.filter((k) => k.key === meta)];
  for (const k of ordered) {
    if (k.type === "string") await kv.set(k.key, k.value as string);
    else if (k.type === "list") await kv.rpush(k.key, ...(k.value as string[]));
    else if (k.type === "set") await kv.sadd(k.key, ...(k.value as string[]));
    else if (k.type === "zset") await kv.zadd(k.key, k.value as Array<[string, number]>);
    else if (k.type === "hash") await kv.hset(k.key, k.value as Record<string, string>);
    else throw new RoomDeleteError(`unsupported type in snapshot at ${k.key}`);
    if (k.pttl > 0) await kv.pexpire(k.key, k.pttl);
  }
  for (const setKey of snap.memberships) await kv.sadd(setKey, snap.slug);
}

export type RunStatus = "dry-run" | "refused" | "confirmation-mismatch" | "deleted" | "deleted-with-leftovers";

export interface RunOptions {
  slug: string;
  apply: boolean;
  /** Called with the plan right after it is built, before any confirmation is asked, so the operator sees what will go first. */
  onPlan?: (plan: DeletePlan) => void;
  /** Asked for only after the plan is applicable and `apply` is set; must return exactly the slug. */
  confirm: () => Promise<string>;
  /** Persists the snapshot and returns where it went; a throw aborts before anything is deleted. */
  saveSnapshot: (snap: Snapshot) => string;
}

export interface RunResult {
  status: RunStatus;
  plan: DeletePlan;
  reason?: string;
  snapshotPath?: string;
  snapshot?: Snapshot;
  leftovers?: string[];
}

/** The whole gated flow, so the dry-run default and the confirmation gate are testable. */
export async function runDelete(kv: Kv, opts: RunOptions): Promise<RunResult> {
  const plan = await buildPlan(kv, opts.slug);
  opts.onPlan?.(plan);
  const gate = isApplicable(plan);
  if (!opts.apply) return { status: "dry-run", plan, reason: gate.ok ? undefined : gate.reason };
  if (!gate.ok) return { status: "refused", plan, reason: gate.reason };
  if ((await opts.confirm()) !== plan.slug) return { status: "confirmation-mismatch", plan };
  const snapshot = await takeSnapshot(kv, plan);
  const snapshotPath = opts.saveSnapshot(snapshot);
  const left = await applyDelete(kv, plan);
  const leftovers = [...left.leftoverKeys, ...left.leftoverMemberships];
  return { status: leftovers.length ? "deleted-with-leftovers" : "deleted", plan, snapshot, snapshotPath, leftovers };
}
