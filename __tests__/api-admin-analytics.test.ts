/**
 * TICKET-31 — GET /api/host/analytics route tests: the auth gate (reuses the
 * `default`-room host session, same mechanism as every other host route),
 * request-shape validation, and the COOKIE-PATH-SCOPE regression guard (App
 * Tester real-browser fix). The aggregation math itself is covered by
 * __tests__/analytics.test.ts (this file only proves the route wires auth +
 * params correctly and stays read-only).
 *
 * NOTE on the moved route: the endpoint deliberately lives at
 * `/api/host/analytics`, NOT `/api/admin/analytics`. The host session cookie is
 * scoped to `HOST_COOKIE_PATH = "/api/host"`, so a real browser only sends it
 * to paths under that prefix. An earlier draft at `/api/admin/analytics` was
 * outside the scope → a logged-in host's browser never attached the cookie →
 * every request 401'd, even though these unit tests passed (they set the cookie
 * directly on mock requests, bypassing browser path-scoping). The path-scope
 * test below prevents that class of regression.
 */
import { NextRequest } from "next/server";
import { store, DEFAULT_ROOM } from "@/lib/store";
import { hostCookieName, issueSession, HOST_COOKIE_PATH } from "@/lib/host-auth";
import { telemetryStore } from "@/lib/telemetry-store";
import { GET } from "@/app/api/host/analytics/route";

/** The URL path this route is mounted at (kept in sync with its app-dir location). */
const ANALYTICS_PATH = "/api/host/analytics";

function req(opts: { authed?: boolean; qs?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.authed) headers.cookie = `${hostCookieName(DEFAULT_ROOM)}=${sessionValue}`;
  return new NextRequest(
    `http://127.0.0.1:3040${ANALYTICS_PATH}${opts.qs ? `?${opts.qs}` : ""}`,
    { headers },
  );
}

let sessionValue: string;

beforeEach(async () => {
  delete process.env.HOST_TOKEN;
  process.env.NODE_ENV = "test"; // non-production → dev fallback token path
  sessionValue = (await issueSession(DEFAULT_ROOM))!;
  await store.clear(DEFAULT_ROOM);
  await telemetryStore.clear();
});

describe("GET /api/host/analytics — cookie-path-scope regression (App Tester real-browser fix)", () => {
  it("is mounted UNDER the host cookie's path scope, so a real browser actually sends the cookie", () => {
    // The host session cookie is set with path=HOST_COOKIE_PATH; browsers only
    // attach it to request paths that start with that prefix. If this endpoint
    // ever moves out from under it (e.g. back to /api/admin/analytics), a
    // logged-in host's browser silently stops sending the cookie → 401s with no
    // server-side clue. This assertion fails loudly if the route drifts.
    expect(ANALYTICS_PATH.startsWith(HOST_COOKIE_PATH)).toBe(true);
    expect(HOST_COOKIE_PATH).toBe("/api/host");
  });
});

describe("GET /api/host/analytics — auth gate", () => {
  it("401s without a host session (same default-room gate as /[room]/admin)", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("401s with a garbage cookie value", async () => {
    const res = await GET(
      new NextRequest(`http://127.0.0.1:3040${ANALYTICS_PATH}`, {
        headers: { cookie: `${hostCookieName(DEFAULT_ROOM)}=not-a-real-session` },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("200s with a valid default-room host session (reuses DEV_FALLBACK_TOKEN-derived session)", async () => {
    expect(sessionValue).toBeTruthy();
    const res = await GET(req({ authed: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("days");
    expect(body).toHaveProperty("topSongs");
    expect(body).toHaveProperty("rooms");
  });

  it("locks out entirely when host controls are unconfigured (HOST_TOKEN unset + production)", async () => {
    process.env.NODE_ENV = "production";
    // A session minted under the dev-fallback token no longer verifies once
    // production locks the room (resolveRoomToken returns null).
    const res = await GET(req({ authed: true }));
    expect(res.status).toBe(401);
    process.env.NODE_ENV = "test";
  });
});

describe("GET /api/host/analytics — request validation (read-only, no mutation)", () => {
  it("rejects from > to", async () => {
    const res = await GET(req({ authed: true, qs: "from=2026-07-10&to=2026-07-01" }));
    expect(res.status).toBe(400);
  });

  it("rejects a range wider than the 90-day cap", async () => {
    const res = await GET(req({ authed: true, qs: "from=2026-01-01&to=2026-12-31" }));
    expect(res.status).toBe(400);
  });

  it("rejects a calendar-invalid `to` date (regex-valid but impossible)", async () => {
    const res = await GET(req({ authed: true, qs: "to=2026-13-45" }));
    expect(res.status).toBe(400);
  });

  it("rejects a calendar-invalid `from` date", async () => {
    const res = await GET(req({ authed: true, qs: "from=2026-02-30&to=2026-03-01" }));
    expect(res.status).toBe(400);
  });

  it("defaults to a trailing-30-day range when from/to are omitted", async () => {
    const res = await GET(req({ authed: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.days.length).toBe(30);
  });

  it("never calls a store mutation method — GET only reads", async () => {
    const appendSpy = jest.spyOn(telemetryStore, "append");
    await GET(req({ authed: true }));
    expect(appendSpy).not.toHaveBeenCalled();
    appendSpy.mockRestore();
  });
});
