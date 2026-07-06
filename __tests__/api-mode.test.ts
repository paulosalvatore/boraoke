/**
 * TICKET-10 — POST /api/host/mode route tests: host-auth guard, validation,
 * persistence via the additive room mutator, and the live re-lay that reorders
 * the stored queue under the new policy (host-switches-mode → queue-reorders).
 */
import { NextRequest } from "next/server";
import { store, type QueueEntry } from "@/lib/store";
import { hostCookieName, issueSession } from "@/lib/host-auth";
import { createRoom, getRoomMode } from "@/lib/rooms";

import { POST as setMode } from "@/app/api/host/mode/route";

let roomId: string;
let sessionValue: string;

function req(opts: { body?: unknown; authed?: boolean } = {}): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.authed) headers.cookie = `${hostCookieName(roomId)}=${sessionValue}`;
  return new NextRequest(`http://127.0.0.1:3040/api/host/mode?room=${roomId}`, {
    method: "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

function seed(id: string, p: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id,
    videoId: p.videoId ?? `vid-${id}`,
    nickname: p.nickname ?? `nick-${id}`,
    patronUuid: p.patronUuid ?? `uuid-${id}`,
    table: p.table,
    mode: p.mode ?? "sing",
    submittedAt: p.submittedAt ?? `2026-07-06T00:00:${id}.000Z`,
  };
}

beforeEach(async () => {
  const created = await createRoom("Bar do Teste");
  roomId = created!.room.id;
  sessionValue = (await issueSession(roomId))!;
  await store.clear(roomId);
});

describe("POST /api/host/mode", () => {
  it("401s without a host session", async () => {
    const res = await setMode(req({ body: { mode: "per-person-1" } }));
    expect(res.status).toBe(401);
  });

  it("400s on an invalid mode", async () => {
    const res = await setMode(req({ authed: true, body: { mode: "chaos" } }));
    expect(res.status).toBe(400);
  });

  it("persists the new mode (readable via getRoomMode)", async () => {
    const res = await setMode(req({ authed: true, body: { mode: "per-person-1" } }));
    expect(res.status).toBe(200);
    expect(await getRoomMode(roomId)).toBe("per-person-1");
  });

  it("re-lays the queue under the new policy (host switch → reorder)", async () => {
    // Pending sings across two tables; index 0 is a listen so it doesn't seed a
    // sing group. Under per-table-2 the tables round-robin (t1,t2,t1).
    await store.addEntry(roomId, seed("01", { mode: "listen-dance", patronUuid: "np" }));
    await store.addEntry(roomId, seed("02", { table: "1", patronUuid: "u1" }));
    await store.addEntry(roomId, seed("03", { table: "1", patronUuid: "u2" }));
    await store.addEntry(roomId, seed("04", { table: "2", patronUuid: "u3" }));

    const res = await setMode(req({ authed: true, body: { mode: "per-table-2" } }));
    expect(res.status).toBe(200);

    const order = (await store.getQueue(roomId)).map((e) => e.id);
    expect(order[0]).toBe("01"); // now-playing pinned
    // per-table round-robin: t1(02), t2(04), t1(03)
    expect(order.slice(1)).toEqual(["02", "04", "03"]);
  });
});
