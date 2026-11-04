/**
 * REAL-REDIS host-login flood, ported from the TICKET-127 Cyber probe (C3). Opt-in:
 *   docker run --rm -d -p 6458:6379 redis:7-alpine
 *   REDIS_TEST_URL=redis://127.0.0.1:6458 npx jest host-login-flood.integration
 * Unset, it skips. Attackers hold the host code and run login loops on a room
 * while its owner presses "Sign out other devices" (the real revoke route). Each
 * hop to the store is delayed to model Upstash REST round trips. The test
 * asserts the owner pin survives every trial and prints the measurement
 * (`FLOOD ...` lines): pin losses, and store commands per attacker request.
 *
 * It imports nothing introduced by the fix, so the same file runs unchanged
 * against the pre-fix code to reproduce the loss. FLOOD_MODES (comma list of
 * lib,route-ip,route-many), FLOOD_SIZES and FLOOD_TRIALS narrow a run; the
 * assertion is enforced only when FLOOD_ENFORCE=1 (the default for this file).
 */
import type { Redis } from "@upstash/redis";
import { NextRequest } from "next/server";
import { _clearLoginThrottle, claimCookieName, hostCookieName, issueSession } from "@/lib/host-auth";
import { POST as loginRoute } from "@/app/api/host/login/route";
import { POST as revokeRoute } from "@/app/api/host/revoke-sessions/route";
import {
  RoomWriteConflictError,
  UpstashRoomBackend,
  createRoom,
  getRoom,
  issueRoomClaimToken,
  roomBackend,
} from "@/lib/rooms";
import { Resp } from "./helpers/resp";

const REDIS_URL = process.env.REDIS_TEST_URL;
const maybe = REDIS_URL ? describe : describe.skip;
if (!REDIS_URL) it("SKIPPED: set REDIS_TEST_URL to run the real-Redis flood", () => undefined);

jest.setTimeout(1_200_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE_MS = 5;
const JITTER_MS = 3;
const stats = { cmds: 0 };

function parse(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    const out = JSON.parse(v);
    return typeof out === "number" && out.toString() !== v ? v : out;
  } catch {
    return v;
  }
}
const serialize = (v: unknown) => (typeof v === "string" || typeof v === "number" ? v : JSON.stringify(v));
const hop = () => sleep(BASE_MS + Math.random() * JITTER_MS);

class RespUpstash {
  constructor(private readonly r: Resp) {}
  private async c(...args: (string | number)[]) {
    stats.cmds++;
    await hop();
    const out = await this.r.cmd(...args);
    await hop();
    return out;
  }
  async get(k: string) {
    return parse(await this.c("GET", k));
  }
  async mget(...keys: string[]) {
    const raw = (await this.c("EVAL", "return cjson.encode(redis.call('MGET', unpack(KEYS)))", keys.length, ...keys)) as string;
    return (JSON.parse(raw) as unknown[]).map((v) => (v === false ? null : parse(v)));
  }
  async set(k: string, v: unknown, opts?: { ex?: number; px?: number; keepTtl?: boolean }) {
    const args: (string | number)[] = ["SET", k, serialize(v) as string];
    if (opts?.ex) args.push("EX", opts.ex);
    if (opts?.px) args.push("PX", opts.px);
    if (opts?.keepTtl) args.push("KEEPTTL");
    return this.c(...args);
  }
  del = (k: string) => this.c("DEL", k);
  incr = (k: string) => this.c("INCR", k);
  incrby = (k: string, by: number) => this.c("INCRBY", k, by);
  pttl = (k: string) => this.c("PTTL", k);
  pexpire = (k: string, ms: number) => this.c("PEXPIRE", k, ms);
  persist = (k: string) => this.c("PERSIST", k);
  async eval(script: string, keys: string[], args: unknown[]) {
    return parse(await this.c("EVAL", script, keys.length, ...keys, ...(args as (string | number)[])));
  }
}

let r: Resp;
const METHODS = ["get", "create", "update", "count", "bumpSessionEpoch", "holdFence", "releaseFence"] as const;
const original = new Map<string, unknown>();

beforeAll(async () => {
  if (!REDIS_URL) return;
  r = new Resp();
  await r.connect(REDIS_URL);
  await r.cmd("FLUSHDB");
  const be = new UpstashRoomBackend(new RespUpstash(r) as unknown as Redis);
  const target = roomBackend as unknown as Record<string, unknown>;
  for (const m of METHODS) {
    if (typeof (be as unknown as Record<string, unknown>)[m] !== "function") continue; // pre-fix code has no fence
    original.set(m, target[m]);
    target[m] = (be as unknown as Record<string, (...a: unknown[]) => unknown>)[m].bind(be);
  }
});
afterAll(() => {
  if (!REDIS_URL) return;
  const target = roomBackend as unknown as Record<string, unknown>;
  for (const m of original.keys()) target[m] = original.get(m);
  r?.end();
});

type Mode = "lib" | "route-ip" | "route-many";
const MODES = (process.env.FLOOD_MODES ?? "lib,route-ip,route-many").split(",") as Mode[];
const SIZES = (process.env.FLOOD_SIZES ?? "50,200,500").split(",").map(Number);
const TRIALS = Number(process.env.FLOOD_TRIALS ?? 6);

async function attacker(mode: Mode, idx: number, roomId: string, hostCode: string, stop: { v: boolean }, out: { reqs: number; ok: number }) {
  while (!stop.v) {
    out.reqs++;
    try {
      if (mode === "lib") {
        if (await issueRoomClaimToken(roomId)) out.ok++;
      } else {
        const ip = mode === "route-ip" ? "198.51.100.200" : `198.51.${(idx >> 8) & 255}.${(idx & 255) + 1}`;
        const res = await loginRoute(
          new NextRequest(`http://127.0.0.1:3040/api/host/login?room=${roomId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
            body: JSON.stringify({ token: hostCode }),
          }),
        );
        if (res.status === 200) out.ok++;
        else await sleep(1); // a refused attacker retries; never spin the event loop
      }
    } catch (e) {
      if (!(e instanceof RoomWriteConflictError)) throw e;
    }
  }
}

maybe.each(MODES.flatMap((m) => SIZES.map((s) => [m, s] as const)))("flood mode=%s attackers=%i", (mode, attackers) => {
  it("the owner pin survives the revoke in every trial", async () => {
    let lost = 0;
    let reqs = 0;
    let okLogins = 0;
    const cmds0 = stats.cmds;
    for (let t = 0; t < TRIALS; t++) {
      _clearLoginThrottle();
      const created = (await createRoom(`Flood ${mode} ${attackers} ${t} ${Date.now()}`))!;
      const roomId = created.room.id;
      const owner = (await issueRoomClaimToken(roomId, { owner: true }))!;
      const session = (await issueSession(roomId))!;
      const stop = { v: false };
      const out = { reqs: 0, ok: 0 };
      const floodDone = Promise.all(Array.from({ length: attackers }, (_, i) => attacker(mode, i, roomId, created.hostCode, stop, out)));
      await sleep(30 + BASE_MS * 4); // steady state
      const res = await revokeRoute(
        new NextRequest(`http://127.0.0.1:3040/api/host/revoke-sessions?room=${roomId}`, {
          method: "POST",
          headers: {
            host: "127.0.0.1:3040",
            cookie: `${hostCookieName(roomId)}=${session}; ${claimCookieName(roomId)}=${owner}`,
          },
        }),
      );
      stop.v = true;
      await floodDone;
      expect(res.status).toBe(200);
      const room = (await getRoom(roomId))!;
      if (!room.ownerClaimTokenHash) lost++;
      reqs += out.reqs;
      okLogins += out.ok;
    }
    const perReq = ((stats.cmds - cmds0) / Math.max(1, reqs)).toFixed(2);
    console.log(
      `FLOOD mode=${mode} attackers=${attackers} lat=${BASE_MS}+${JITTER_MS}ms trials=${TRIALS} pinLost=${lost}/${TRIALS} attackerReqs=${reqs} committedLogins=${okLogins} storeCmdsPerAttackerReq=${perReq}`,
    );
    expect(lost).toBe(0);
  });
});

maybe("the real CAS script and the owner-mint fence", () => {
  it("refuses a plain write while the fence key exists, lets the priority write through, and ignores a missing fence key", async () => {
    const { ROOM_CAS_SCRIPT, roomKey, roomOwnerFenceKey } = await import("@/lib/rooms");
    const created = (await createRoom(`Fence Lua ${Date.now()}`))!;
    const id = created.room.id;
    const rec = (await getRoom(id))!;
    const body = (rev: number) => JSON.stringify({ ...rec, rev });
    const evalCas = (flag: string, keys: string[]) =>
      r.cmd("EVAL", ROOM_CAS_SCRIPT, keys.length, ...keys, "0", body(1), "0", flag);
    await r.cmd("SET", roomOwnerFenceKey(id), "1", "PX", 5000);
    expect(await evalCas("0", [roomKey(id), roomOwnerFenceKey(id)])).toBe(-2);
    expect(await evalCas("1", [roomKey(id), roomOwnerFenceKey(id)])).toBe(1);
    await r.cmd("DEL", roomOwnerFenceKey(id));
    const rec2 = JSON.stringify({ ...rec, rev: 2 });
    expect(await r.cmd("EVAL", ROOM_CAS_SCRIPT, 2, roomKey(id), roomOwnerFenceKey(id), "1", rec2, "0", "0")).toBe(1);
    // An older caller that passes only the record key is never fenced.
    await r.cmd("SET", roomOwnerFenceKey(id), "1", "PX", 5000);
    expect(await r.cmd("EVAL", ROOM_CAS_SCRIPT, 1, roomKey(id), "2", JSON.stringify({ ...rec, rev: 3 }), "0")).toBe(1);
    await r.cmd("DEL", roomOwnerFenceKey(id));
  });
});
