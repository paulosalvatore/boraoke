/**
 * Host API route tests (TICKET-7) — auth guard + thin-wrapper behavior.
 * All host routes must 401 without a valid session cookie and act on the store
 * with one.
 */
import { NextRequest } from "next/server";
import { store, DEFAULT_ROOM, type QueueEntry } from "@/lib/store";
import { HOST_COOKIE, issueSession } from "@/lib/host-auth";

import { POST as login } from "@/app/api/host/login/route";
import { POST as skip } from "@/app/api/host/skip/route";
import { POST as remove } from "@/app/api/host/remove/route";
import { POST as reorder } from "@/app/api/host/reorder/route";
import { POST as pause } from "@/app/api/host/pause/route";
import { GET as session } from "@/app/api/host/session/route";

const TOKEN = "unit-test-host-token";

function seed(...ids: string[]): QueueEntry[] {
  return ids.map((id) => ({
    id,
    videoId: "dQw4w9WgXcQ",
    nickname: `nick-${id}`,
    patronUuid: `uuid-${id}`,
    mode: "sing" as const,
    submittedAt: new Date().toISOString(),
  }));
}

/** Build a NextRequest, optionally carrying a valid host session cookie. */
function req(url: string, opts: { body?: unknown; authed?: boolean } = {}): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.authed) headers.cookie = `${HOST_COOKIE}=${issueSession(DEFAULT_ROOM)}`;
  return new NextRequest(`http://127.0.0.1:3040${url}`, {
    method: "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

beforeEach(async () => {
  process.env.HOST_TOKEN = TOKEN;
  await store.clear(DEFAULT_ROOM);
});
afterEach(() => {
  delete process.env.HOST_TOKEN;
});

describe("POST /api/host/login", () => {
  it("sets a session cookie for the correct token", async () => {
    const res = await login(req("/api/host/login", { body: { token: TOKEN } }));
    expect(res.status).toBe(200);
    expect(res.cookies.get(HOST_COOKIE)?.value).toBeTruthy();
  });

  it("401s on a wrong token and sets no cookie", async () => {
    const res = await login(req("/api/host/login", { body: { token: "nope" } }));
    expect(res.status).toBe(401);
    expect(res.cookies.get(HOST_COOKIE)?.value).toBeFalsy();
  });
});

describe("auth guard — every mutating route 401s without a cookie", () => {
  const cases: [string, (r: NextRequest) => Promise<Response>, unknown][] = [
    ["skip", skip, undefined],
    ["remove", remove, { entryId: "x" }],
    ["reorder", reorder, { entryId: "x", newIndex: 0 }],
    ["pause", pause, { paused: true }],
  ];
  it.each(cases)("%s → 401 unauthenticated", async (name, handler, body) => {
    const res = await handler(req(`/api/host/${name}`, { body }));
    expect(res.status).toBe(401);
  });

  it("session probe → 401 unauthenticated", async () => {
    const res = await session(
      new NextRequest("http://127.0.0.1:3040/api/host/session"),
    );
    expect(res.status).toBe(401);
  });

  it("session probe → 200 with a valid cookie", async () => {
    const authedReq = new NextRequest("http://127.0.0.1:3040/api/host/session", {
      headers: { cookie: `${HOST_COOKIE}=${issueSession(DEFAULT_ROOM)}` },
    });
    const res = await session(authedReq);
    expect(res.status).toBe(200);
    expect((await res.json()).authed).toBe(true);
  });
});

describe("authenticated host actions act on the store", () => {
  it("skip advances the head", async () => {
    for (const e of seed("a", "b", "c")) await store.addEntry(DEFAULT_ROOM, e);
    const res = await skip(req("/api/host/skip", { authed: true }));
    expect(res.status).toBe(200);
    expect((await store.getQueue(DEFAULT_ROOM)).map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("remove deletes the entry by id", async () => {
    for (const e of seed("a", "b", "c")) await store.addEntry(DEFAULT_ROOM, e);
    const res = await remove(req("/api/host/remove", { authed: true, body: { entryId: "b" } }));
    expect(res.status).toBe(200);
    expect((await store.getQueue(DEFAULT_ROOM)).map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("remove 400s without an entryId", async () => {
    const res = await remove(req("/api/host/remove", { authed: true, body: {} }));
    expect(res.status).toBe(400);
  });

  it("reorder moves an entry to a new index", async () => {
    for (const e of seed("a", "b", "c")) await store.addEntry(DEFAULT_ROOM, e);
    const res = await reorder(
      req("/api/host/reorder", { authed: true, body: { entryId: "c", newIndex: 0 } }),
    );
    expect(res.status).toBe(200);
    expect((await store.getQueue(DEFAULT_ROOM)).map((e) => e.id)).toEqual(["c", "a", "b"]);
  });

  it("reorder 400s on a non-integer newIndex", async () => {
    const res = await reorder(
      req("/api/host/reorder", { authed: true, body: { entryId: "a", newIndex: "x" } }),
    );
    expect(res.status).toBe(400);
  });

  it("pause sets and clears the room flag", async () => {
    const on = await pause(req("/api/host/pause", { authed: true, body: { paused: true } }));
    expect(on.status).toBe(200);
    expect(await store.isPaused(DEFAULT_ROOM)).toBe(true);

    const off = await pause(req("/api/host/pause", { authed: true, body: { paused: false } }));
    expect(off.status).toBe(200);
    expect(await store.isPaused(DEFAULT_ROOM)).toBe(false);
  });

  it("pause 400s on a non-boolean", async () => {
    const res = await pause(req("/api/host/pause", { authed: true, body: { paused: "yes" } }));
    expect(res.status).toBe(400);
  });
});
