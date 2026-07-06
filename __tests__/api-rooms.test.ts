/**
 * API tests for /api/rooms (TICKET-9) — create + fetch, the guarantee that the
 * host code is returned ONLY at creation (never by GET), and the HIGH-1 abuse
 * guards (per-IP creation throttle + global ROOM_MAX ceiling).
 */
import { NextRequest } from "next/server";
import { POST, GET } from "@/app/api/rooms/route";
import { isValidRoomId } from "@/lib/rooms";
import { _clearRoomCreateThrottle } from "@/lib/room-create-throttle";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => _clearRoomCreateThrottle());
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function postReq(body: unknown, ip?: string): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ip) headers["x-forwarded-for"] = ip;
  return new NextRequest("http://127.0.0.1:3040/api/rooms", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function getReq(id: string): NextRequest {
  return new NextRequest(
    `http://127.0.0.1:3040/api/rooms?id=${encodeURIComponent(id)}`,
  );
}

describe("POST /api/rooms", () => {
  it("creates a room and returns id, name, hostCode, joinPath", async () => {
    const res = await POST(postReq({ name: "Bar do Zé" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(isValidRoomId(data.id)).toBe(true);
    expect(data.name).toBe("Bar do Zé");
    expect(typeof data.hostCode).toBe("string");
    expect(data.hostCode.length).toBe(8);
    expect(data.joinPath).toBe(`/${data.id}`);
  });

  it("400s on a missing / empty name", async () => {
    expect((await POST(postReq({}))).status).toBe(400);
    expect((await POST(postReq({ name: "   " }))).status).toBe(400);
  });

  it("400s on an oversized name", async () => {
    const res = await POST(postReq({ name: "x".repeat(61) }));
    expect(res.status).toBe(400);
  });

  it("400s on invalid JSON", async () => {
    const res = await POST(postReq("{not json"));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/rooms abuse guards (security HIGH-1)", () => {
  const IP = "203.0.113.77";

  it("429s after the per-IP creation limit (default 3/hour)", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await POST(postReq({ name: `Bar Limite ${i}` }, IP));
      expect(res.status).toBe(201);
    }
    const throttled = await POST(postReq({ name: "Bar Limite 4" }, IP));
    expect(throttled.status).toBe(429);
    const body = await throttled.json();
    expect(body.error).toMatch(/muitas salas/i);
  });

  it("does not throttle a different IP", async () => {
    for (let i = 0; i < 3; i++) {
      await POST(postReq({ name: `Bar Cheio ${i}` }, IP));
    }
    const other = await POST(postReq({ name: "Bar Vizinho" }, "198.51.100.42"));
    expect(other.status).toBe(201);
  });

  it("honors an explicit ROOM_CREATE_LIMIT", async () => {
    process.env.ROOM_CREATE_LIMIT = "1";
    const first = await POST(postReq({ name: "Bar Um" }, "203.0.113.88"));
    expect(first.status).toBe(201);
    const second = await POST(postReq({ name: "Bar Dois" }, "203.0.113.88"));
    expect(second.status).toBe(429);
  });

  it("failed creations (validation 400s) do not consume the budget", async () => {
    for (let i = 0; i < 10; i++) {
      await POST(postReq({ name: "" }, IP)); // 400 — not counted
    }
    const ok = await POST(postReq({ name: "Bar Válido" }, IP));
    expect(ok.status).toBe(201);
  });

  it("503s with a polite pt-BR message at the global ROOM_MAX ceiling", async () => {
    process.env.ROOM_MAX = "0"; // ceiling already reached
    const res = await POST(postReq({ name: "Bar Lotado" }, "203.0.113.99"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/lotados/i);
  });
});

describe("GET /api/rooms", () => {
  it("returns the public room WITHOUT the host code", async () => {
    const created = await (await POST(postReq({ name: "Bar Público" }))).json();
    const res = await GET(getReq(created.id));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.room.id).toBe(created.id);
    expect(data.room.name).toBe("Bar Público");
    expect(data.room).not.toHaveProperty("hostCode");
    expect(JSON.stringify(data)).not.toContain(created.hostCode);
  });

  it("400s on a malformed id", async () => {
    const res = await GET(getReq("bad id!"));
    expect(res.status).toBe(400);
  });

  it("404s on an unknown room", async () => {
    const res = await GET(getReq("no-such-room-xyz"));
    expect(res.status).toBe(404);
  });
});
