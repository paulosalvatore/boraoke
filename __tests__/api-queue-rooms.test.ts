/**
 * Queue room-isolation tests (TICKET-9). Two rooms must keep fully separate
 * queues; the API must reject malformed room ids before they reach a Redis key.
 */
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/queue/route";
import { store } from "@/lib/store";

const VALID_UUID = "123e4567-e89b-42d3-a456-426614174000";
const VALID_VIDEO_ID = "dQw4w9WgXcQ";

function post(room: string | undefined, overrides: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1:3040/api/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      room,
      videoId: VALID_VIDEO_ID,
      nickname: "Alice",
      patronUuid: VALID_UUID,
      mode: "sing",
      ...overrides,
    }),
  });
}

function get(room?: string): NextRequest {
  const q = room ? `?room=${encodeURIComponent(room)}` : "";
  return new NextRequest(`http://127.0.0.1:3040/api/queue${q}`);
}

beforeEach(async () => {
  await store.clear("room-a-1111");
  await store.clear("room-b-2222");
});

describe("queue is isolated per room", () => {
  it("a song added to room A does not appear in room B", async () => {
    const resA = await POST(post("room-a-1111", { nickname: "AliceA" }));
    expect(resA.status).toBe(201);

    const aItems = (await (await GET(get("room-a-1111"))).json()).items;
    const bItems = (await (await GET(get("room-b-2222"))).json()).items;
    expect(aItems).toHaveLength(1);
    expect(aItems[0].nickname).toBe("AliceA");
    expect(bItems).toHaveLength(0);
  });

  it("stores the table number on the entry (AC3)", async () => {
    await POST(post("room-a-1111", { table: "7" }));
    const items = (await (await GET(get("room-a-1111"))).json()).items;
    expect(items[0].table).toBe("7");
  });
});

describe("room id validation (security — key injection)", () => {
  it("GET 400s on a malformed room id", async () => {
    const res = await GET(get("room:default:queue"));
    expect(res.status).toBe(400);
  });

  it("POST 400s on a malformed room id", async () => {
    const res = await POST(post("bad room!"));
    expect(res.status).toBe(400);
  });

  it("absent room defaults to the legacy default room (back-compat)", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
  });
});
