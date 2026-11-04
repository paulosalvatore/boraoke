/**
 * Gated room deletion (ops script).
 *
 *   npm run room:delete -- --room <slug>                     # dry run (default): prints the plan, writes nothing
 *   npm run room:delete -- --room <slug> --apply             # snapshot, then delete after typing the slug to confirm
 *   npm run room:delete -- --room <slug> --apply --confirm <slug>   # same, non-interactive
 *   npm run room:delete -- --restore <snapshot.json>         # put a deleted room back
 *
 * Needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in the environment
 * (never printed). The engine lives in lib/room-delete.ts.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

// The lib modules this engine reuses for their key builders carry `server-only`,
// which throws under plain node. Stub it before they are required.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require("node:module");
const origLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === "server-only") return {};
  // The `@/` alias is type-level only under ts-node; resolve it to the repo root.
  if (request.startsWith("@/")) return origLoad.call(this, join(__dirname, "..", request.slice(2)), ...rest);
  return origLoad.call(this, request, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const engine: typeof import("../lib/room-delete") = require("../lib/room-delete");
const { Redis }: typeof import("@upstash/redis") = require("@upstash/redis");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { Kv, KvType, Snapshot } from "../lib/room-delete";

function parseArgs(argv: string[]) {
  const a: { room?: string; apply: boolean; confirm?: string; restore?: string } = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--room") a.room = argv[++i];
    else if (v === "--apply") a.apply = true;
    else if (v === "--confirm") a.confirm = argv[++i];
    else if (v === "--restore") a.restore = argv[++i];
    else throw new Error(`unknown argument: ${v}`);
  }
  return a;
}

function upstashKv(): Kv {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set");
  // Raw strings in and out: the snapshot must hold exactly what is stored.
  const r = new Redis({ url, token, automaticDeserialization: false });
  const scanAll = async (match: string) => {
    const out: string[] = [];
    let cursor: string | number = "0";
    do {
      const [next, batch]: [string | number, string[]] = await r.scan(cursor, { match, count: 500 });
      out.push(...batch);
      cursor = next;
    } while (String(cursor) !== "0");
    return [...new Set(out)];
  };
  return {
    scan: scanAll,
    type: async (k) => (await r.type(k)) as KvType | "none",
    pttl: (k) => r.pttl(k),
    get: async (k) => (await r.get<string | null>(k)) ?? null,
    lrange: (k) => r.lrange<string>(k, 0, -1),
    smembers: (k) => r.smembers(k),
    zrange: async (k) => {
      const flat = (await r.zrange<string[]>(k, 0, -1, { withScores: true })) as unknown[];
      const out: Array<[string, number]> = [];
      for (let i = 0; i < flat.length; i += 2) out.push([String(flat[i]), Number(flat[i + 1])]);
      return out;
    },
    hgetall: async (k) => ((await r.hgetall<Record<string, string>>(k)) ?? {}),
    del: async (...ks) => void (await r.del(...ks)),
    srem: async (k, m) => void (await r.srem(k, m)),
    set: async (k, v) => void (await r.set(k, v)),
    rpush: async (k, ...vs) => void (await r.rpush(k, ...vs)),
    sadd: async (k, ...ms) => void (await r.sadd(k, ms[0], ...ms.slice(1))),
    zadd: async (k, es) => void (await r.zadd(k, { score: es[0][1], member: es[0][0] }, ...es.slice(1).map(([member, score]) => ({ score, member })))),
    hset: async (k, rec) => void (await r.hset(k, rec)),
    pexpire: async (k, ms) => void (await r.pexpire(k, ms)),
  };
}

function printPlan(plan: Awaited<ReturnType<typeof engine.buildPlan>>) {
  console.log(`Room: ${plan.slug}`);
  console.log(`Keys that would be deleted (${plan.keys.length}):`);
  for (const k of plan.keys) console.log(`  ${k.key}    [${k.source}]`);
  console.log(`Code-derived keys not present (${plan.absent.length}):`);
  for (const k of plan.absent) console.log(`  ${k}`);
  console.log(`identity memberships that would be removed (${plan.memberships.length}):`);
  for (const m of plan.memberships) console.log(`  SREM ${m} ${plan.slug}`);
  if (plan.unaccounted.length > 0) {
    console.log(`UNACCOUNTED keys under room:${plan.slug}: (${plan.unaccounted.length}), not on the code-derived list:`);
    for (const k of plan.unaccounted) console.log(`  ${k}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kv = upstashKv();

  if (args.restore) {
    const snap = JSON.parse(readFileSync(resolve(args.restore), "utf8")) as Snapshot;
    await engine.restoreSnapshot(kv, snap);
    console.log(`Restored room ${snap.slug}: ${snap.keys.length} key(s), ${snap.memberships.length} membership(s).`);
    return;
  }

  if (!args.room) throw new Error("--room <slug> is required");
  const res = await engine.runDelete(kv, {
    slug: args.room,
    apply: args.apply,
    confirm: async () => {
      if (args.confirm !== undefined) return args.confirm;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const typed = await rl.question(`\nType the room slug (${args.room}) to confirm deletion: `);
      rl.close();
      return typed;
    },
    saveSnapshot: (snap) => {
      const dir = join(process.cwd(), ".room-delete-snapshots");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${snap.slug}-${snap.takenAt.replace(/[:.]/g, "-")}.json`);
      writeFileSync(file, JSON.stringify(snap, null, 2), { mode: 0o600 });
      console.log(`\nSnapshot written: ${file}`);
      console.log(`Undo with: npm run room:delete -- --restore ${file}`);
      return file;
    },
  });
  if (res.status !== "refused" || res.plan.keys.length > 0 || res.plan.unaccounted.length > 0) printPlan(res.plan);
  switch (res.status) {
    case "dry-run":
      console.log(res.reason ? `\nDRY RUN: ${res.reason}` : "\nDRY RUN: nothing was written. Re-run with --apply to delete.");
      process.exitCode = res.reason ? 1 : 0;
      break;
    case "refused":
      console.error(`\n${res.reason}`);
      process.exitCode = 1;
      break;
    case "confirmation-mismatch":
      console.error("\nConfirmation did not match the slug. Nothing was deleted.");
      process.exitCode = 1;
      break;
    case "deleted-with-leftovers":
      console.error(`\nDeleted, but a concurrent writer re-created: ${(res.leftovers ?? []).join(", ")}. Re-run to remove.`);
      process.exitCode = 2;
      break;
    case "deleted":
      console.log(`\nDeleted ${res.snapshot?.keys.length} key(s) and ${res.plan.memberships.length} membership(s). Verified: no room:${res.plan.slug}:* key and no membership remains.`);
      break;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
