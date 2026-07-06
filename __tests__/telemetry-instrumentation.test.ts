/**
 * Instrumentation tests (TICKET-12, final rebase step): the one-line
 * `void track(...)` calls wired into routes owned by #6/#9 actually emit the
 * right events with the REAL roomId — and stay fail-open (a dead telemetry
 * store never changes a route's response).
 *
 * C1 (review, binding): `song_played` has exactly ONE source — the
 * server-side /api/queue/advance instrumentation.
 */
import { POST as queuePost } from "@/app/api/queue/route";
import { POST as advancePost } from "@/app/api/queue/advance/route";
import { POST as roomsPost } from "@/app/api/rooms/route";
import { telemetryStore } from "@/lib/telemetry-store";
import { store } from "@/lib/store";
import { NextRequest } from "next/server";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const TODAY = new Date().toISOString().slice(0, 10);

function req(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function queueReq(over: Record<string, unknown> = {}) {
  return req("http://127.0.0.1:3012/api/queue", {
    videoId: "dQw4w9WgXcQ",
    nickname: "Ana",
    patronUuid: UUID,
    mode: "sing",
    room: "default",
    ...over,
  });
}

/** Wait for fire-and-forget track() promises to settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  await telemetryStore.clear();
  await store.clear("default");
});

describe("queue POST instrumentation", () => {
  it("emits song_queued with real roomId, uuid, kind=search and mode", async () => {
    const res = await queuePost(queueReq());
    expect(res.status).toBe(201);
    await flush();
    const events = await telemetryStore.listRange(TODAY, TODAY);
    const e = events.find((x) => x.event === "song_queued");
    expect(e).toMatchObject({
      event: "song_queued",
      roomId: "default",
      uuid: UUID,
      props: { kind: "search", mode: "sing" },
    });
  });

  it("emits kind=paste for a URL submission", async () => {
    const res = await queuePost(
      queueReq({ videoId: undefined, youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" }),
    );
    expect(res.status).toBe(201);
    await flush();
    const [e] = (await telemetryStore.listRange(TODAY, TODAY)).filter(
      (x) => x.event === "song_queued",
    );
    expect(e.props?.kind).toBe("paste");
  });

  it("a dead telemetry store never changes the route's response (fail-open)", async () => {
    const spy = jest
      .spyOn(telemetryStore, "append")
      .mockRejectedValue(new Error("outage"));
    const res = await queuePost(queueReq());
    expect(res.status).toBe(201);
    spy.mockRestore();
  });
});

describe("queue advance instrumentation (C1: the ONE song_played source)", () => {
  it("emits song_played with the promoted entry's room/uuid/mode", async () => {
    // Two entries: advancing past the first promotes the second.
    await queuePost(queueReq());
    await queuePost(queueReq({ patronUuid: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", mode: "listen-dance" }));
    await telemetryStore.clear(); // isolate the advance emission
    const res = await advancePost(
      new NextRequest("http://127.0.0.1:3012/api/queue/advance?room=default", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    await flush();
    const events = await telemetryStore.listRange(TODAY, TODAY);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "song_played",
      roomId: "default",
      props: { mode: "listen-dance" },
    });
  });

  it("emits nothing when the queue empties", async () => {
    const res = await advancePost(
      new NextRequest("http://127.0.0.1:3012/api/queue/advance?room=default", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    await flush();
    expect(await telemetryStore.listRange(TODAY, TODAY)).toHaveLength(0);
  });
});

describe("rooms POST instrumentation", () => {
  it("emits room_created with the new room's id", async () => {
    const res = await roomsPost(
      req("http://127.0.0.1:3012/api/rooms", { name: "Bar do Zé" }),
    );
    expect(res.status).toBe(201);
    const { id } = await res.json();
    await flush();
    const events = await telemetryStore.listRange(TODAY, TODAY);
    const e = events.find((x) => x.event === "room_created");
    expect(e?.roomId).toBe(id);
  });
});
