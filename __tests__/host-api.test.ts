/**
 * Host API route tests (TICKET-7 — auth guard + thin-wrapper behavior; extended
 * for per-room scoping in TICKET-9). All host routes must 401 without a valid
 * session cookie and act on the store with one. Session issuance is now async.
 */
import { NextRequest } from "next/server";
import { store, DEFAULT_ROOM, type QueueEntry } from "@/lib/store";
import {
  hostCookieName,
  issueSession,
  _clearLoginThrottle,
} from "@/lib/host-auth";
import { createRoom } from "@/lib/rooms";
import * as telemetry from "@/lib/telemetry";

import { POST as login } from "@/app/api/host/login/route";
import { POST as skip } from "@/app/api/host/skip/route";
import { POST as remove } from "@/app/api/host/remove/route";
import { POST as reorder } from "@/app/api/host/reorder/route";
import { POST as pause } from "@/app/api/host/pause/route";
import { GET as session } from "@/app/api/host/session/route";

const TOKEN = "unit-test-host-token";

/** Session cookie value for the default room, minted per-test after env setup. */
let defaultSession: string;

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

/** Build a NextRequest, optionally carrying a valid default-room session cookie. */
function req(
  url: string,
  opts: { body?: unknown; authed?: boolean; ip?: string } = {},
): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.authed) headers.cookie = `${hostCookieName(DEFAULT_ROOM)}=${defaultSession}`;
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  return new NextRequest(`http://127.0.0.1:3040${url}`, {
    method: "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

beforeEach(async () => {
  process.env.HOST_TOKEN = TOKEN;
  _clearLoginThrottle();
  await store.clear(DEFAULT_ROOM);
  defaultSession = (await issueSession(DEFAULT_ROOM))!;
});
afterEach(() => {
  delete process.env.HOST_TOKEN;
});

describe("POST /api/host/login", () => {
  it("sets a session cookie for the correct token", async () => {
    const res = await login(req("/api/host/login", { body: { token: TOKEN } }));
    expect(res.status).toBe(200);
    expect(res.cookies.get(hostCookieName(DEFAULT_ROOM))?.value).toBeTruthy();
  });

  it("401s on a wrong token and sets no cookie", async () => {
    const res = await login(req("/api/host/login", { body: { token: "nope" } }));
    expect(res.status).toBe(401);
    expect(res.cookies.get(hostCookieName(DEFAULT_ROOM))?.value).toBeFalsy();
  });

  it("scopes the session cookie to /api/host, httpOnly (LOW-1)", async () => {
    const res = await login(req("/api/host/login", { body: { token: TOKEN } }));
    expect(res.status).toBe(200);
    const cookie = res.cookies.get(hostCookieName(DEFAULT_ROOM));
    expect(cookie?.path).toBe("/api/host");
    expect(cookie?.httpOnly).toBe(true);
  });
});

describe("login failure throttle (security M-1)", () => {
  const IP = "203.0.113.7";

  it("429s on the 11th attempt after 10 failures from the same IP", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await login(
        req("/api/host/login", { body: { token: "wrong" }, ip: IP }),
      );
      expect(res.status).toBe(401);
    }
    const throttled = await login(
      req("/api/host/login", { body: { token: TOKEN }, ip: IP }),
    );
    expect(throttled.status).toBe(429);
  });

  it("does not throttle a different IP", async () => {
    for (let i = 0; i < 10; i++) {
      await login(req("/api/host/login", { body: { token: "wrong" }, ip: IP }));
    }
    const other = await login(
      req("/api/host/login", { body: { token: TOKEN }, ip: "198.51.100.9" }),
    );
    expect(other.status).toBe(200);
  });

  it("resets the failure bucket on a successful login", async () => {
    for (let i = 0; i < 9; i++) {
      await login(req("/api/host/login", { body: { token: "wrong" }, ip: IP }));
    }
    const ok = await login(req("/api/host/login", { body: { token: TOKEN }, ip: IP }));
    expect(ok.status).toBe(200);
    const after = await login(
      req("/api/host/login", { body: { token: "wrong" }, ip: IP }),
    );
    expect(after.status).toBe(401);
  });

  it("uses first-hop x-forwarded-for; unknown callers share one bucket", async () => {
    for (let i = 0; i < 10; i++) {
      await login(
        req("/api/host/login", {
          body: { token: "wrong" },
          ip: `${IP}, 10.0.0.1`,
        }),
      );
    }
    const sameFirstHop = await login(
      req("/api/host/login", { body: { token: TOKEN }, ip: `${IP}, 10.9.9.9` }),
    );
    expect(sameFirstHop.status).toBe(429);
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
      headers: { cookie: `${hostCookieName(DEFAULT_ROOM)}=${defaultSession}` },
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

describe("no-show grace re-queue (TICKET-10 / TICKET-24a NIT-2)", () => {
  it("re-queues the head with graceRequeue on the grace path", async () => {
    for (const e of seed("a", "b")) await store.addEntry(DEFAULT_ROOM, e);
    const res = await skip(
      req("/api/host/skip", { authed: true, body: { grace: true } }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.requeued).toBe(true);
    // "a" was re-queued (not dropped) with the grace flag set.
    const queue = await store.getQueue(DEFAULT_ROOM);
    const a = queue.find((e) => e.id === "a");
    expect(a?.graceRequeue).toBe(true);
  });

  it("surfaces a failed grace re-queue instead of silently dropping the singer", async () => {
    for (const e of seed("a", "b")) await store.addEntry(DEFAULT_ROOM, e);
    // Force the re-add to be rejected (mirrors QUEUE_MAX) AFTER the remove.
    const addSpy = jest.spyOn(store, "addEntry").mockResolvedValueOnce(false);
    const trackSpy = jest.spyOn(telemetry, "track");

    const res = await skip(
      req("/api/host/skip", { authed: true, body: { grace: true } }),
    );

    // Response reflects the failure — not a silent ok.
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.requeued).toBe(false);
    expect(json.reason).toBe("queue-full");

    // Telemetry fired the failure signal (fire-and-forget).
    expect(trackSpy).toHaveBeenCalledWith(
      "host_action",
      expect.objectContaining({
        props: expect.objectContaining({ requeueFailed: "queue-full" }),
      }),
    );

    addSpy.mockRestore();
    trackSpy.mockRestore();
  });
});

describe("per-room scoping (TICKET-9)", () => {
  it("400s on a malformed room id", async () => {
    const res = await skip(
      new NextRequest("http://127.0.0.1:3040/api/host/skip?room=bad%20id", { method: "POST" }),
    );
    expect(res.status).toBe(400);
  });

  it("logs into a created room with its host code and acts only on that room", async () => {
    const created = await createRoom("Bar Isolado");
    if (!created) throw new Error("room ceiling hit in test");
    const { room, hostCode } = created;
    // Wrong code → 401.
    const bad = await login(
      new NextRequest(`http://127.0.0.1:3040/api/host/login?room=${room.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "wrong" }),
      }),
    );
    expect(bad.status).toBe(401);

    // Correct host code → 200 + a room-scoped cookie.
    const ok = await login(
      new NextRequest(`http://127.0.0.1:3040/api/host/login?room=${room.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: hostCode }),
      }),
    );
    expect(ok.status).toBe(200);
    const cookieVal = ok.cookies.get(hostCookieName(room.id))?.value;
    expect(cookieVal).toBeTruthy();

    // That room's cookie authorizes actions on that room…
    await store.clear(room.id);
    for (const e of seed("x", "y")) await store.addEntry(room.id, e);
    const skipRes = await skip(
      new NextRequest(`http://127.0.0.1:3040/api/host/skip?room=${room.id}`, {
        method: "POST",
        headers: { cookie: `${hostCookieName(room.id)}=${cookieVal}` },
      }),
    );
    expect(skipRes.status).toBe(200);
    expect((await store.getQueue(room.id)).map((e) => e.id)).toEqual(["y"]);

    // …but NOT the default room (different cookie name + session value).
    const crossRes = await skip(
      new NextRequest(`http://127.0.0.1:3040/api/host/skip`, {
        method: "POST",
        headers: { cookie: `${hostCookieName(room.id)}=${cookieVal}` },
      }),
    );
    expect(crossRes.status).toBe(401);
  });
});
