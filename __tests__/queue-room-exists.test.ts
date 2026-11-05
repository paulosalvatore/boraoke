/**
 * Room writers must not create a room's keys once its record is gone (a room
 * deleted with scripts/delete-room.ts while a patron tab is still open).
 *
 * The record is hidden at `roomBackend.get`, the single read every writer path
 * goes through, which is exactly what the store shows after a delete. The control
 * cases (record present) keep the assertions honest: the same request lands when
 * the room exists, so a 404 here is caused by the missing record and nothing else.
 */
import { NextRequest } from "next/server";
import { POST as QUEUE_POST } from "@/app/api/queue/route";
import { POST as PAUSE_POST } from "@/app/api/host/pause/route";
import { POST as ADVANCE_POST } from "@/app/api/queue/advance/route";
import { store } from "@/lib/store";
import { pendingStore } from "@/lib/pending-store";
import { createRoom, roomBackend, setRoomModeration } from "@/lib/rooms";
import { issueSession, hostCookieName } from "@/lib/host-auth";
import { _resetSubmitRateLimit } from "@/lib/queue-rate-limit";
import ptBR from "@/messages/pt-BR.json";
import en from "@/messages/en.json";
import es from "@/messages/es.json";

const UUID = "123e4567-e89b-42d3-a456-426614174000";

function submit(room: string) {
  return new NextRequest("http://127.0.0.1:3040/api/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room, videoId: "dQw4w9WgXcQ", nickname: "Ze", patronUuid: UUID, mode: "sing" }),
  });
}

async function pause(room: string, cookie: string) {
  return PAUSE_POST(
    new NextRequest(`http://127.0.0.1:3040/api/host/pause?room=${room}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ paused: true }),
    }),
  );
}

async function freshRoom(moderation = false) {
  const created = await createRoom("Room Exists Bar");
  if (!created) throw new Error("room ceiling hit in test");
  const id = created.room.id;
  if (moderation) await setRoomModeration(id, true);
  await store.clear(id);
  await pendingStore.clear(id);
  return id;
}

/** Make `roomId` read as deleted, whatever else is stored. */
function hideRecord(roomId: string) {
  const real = roomBackend.get.bind(roomBackend);
  jest.spyOn(roomBackend, "get").mockImplementation(async (id: string) => (id === roomId ? null : real(id)));
}

beforeEach(() => _resetSubmitRateLimit());

describe("POST /api/queue on a room whose record is gone", () => {
  it("control: the same submit lands while the record exists", async () => {
    const room = await freshRoom();
    expect((await QUEUE_POST(submit(room))).status).toBe(201);
    expect(await store.getQueue(room)).toHaveLength(1);
  });

  it("404s with the existing patron not-found string and creates no queue key", async () => {
    const room = await freshRoom();
    hideRecord(room);
    const addEntry = jest.spyOn(store, "addEntry");
    const res = await QUEUE_POST(submit(room));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe(ptBR.Patron.notFoundLead);
    expect(addEntry).not.toHaveBeenCalled();
    expect(await store.getQueue(room)).toEqual([]);
    expect(await store.isPaused(room)).toBe(false);
    expect(await pendingStore.countRoom(room)).toBe(0);
  });

  it("a never-created slug gets the same 404 and no key", async () => {
    const res = await QUEUE_POST(submit("never-created-9z9z"));
    expect(res.status).toBe(404);
    expect(await store.getQueue("never-created-9z9z")).toEqual([]);
  });

  it("a moderated room whose record is gone creates no pending key either", async () => {
    const room = await freshRoom(true);
    hideRecord(room);
    const add = jest.spyOn(pendingStore, "add");
    expect((await QUEUE_POST(submit(room))).status).toBe(404);
    expect(add).not.toHaveBeenCalled();
    expect(await pendingStore.countRoom(room)).toBe(0);
  });

  it("the legacy default room has no record by design and still accepts submits", async () => {
    await store.clear("default");
    expect((await QUEUE_POST(submit("default"))).status).toBe(201);
    await store.clear("default");
  });

  it("the string it returns exists in every locale (no new patron copy)", () => {
    for (const m of [ptBR, en, es]) expect(typeof m.Patron.notFoundLead).toBe("string");
  });
});

describe("other room writers", () => {
  it("host pause: a session minted before the delete cannot write the paused key", async () => {
    const room = await freshRoom();
    const cookie = `${hostCookieName(room)}=${await issueSession(room)}`;
    hideRecord(room);
    const setPaused = jest.spyOn(store, "setPaused");
    expect((await pause(room, cookie)).status).toBe(401);
    expect(setPaused).not.toHaveBeenCalled();
    expect(await store.isPaused(room)).toBe(false);
  });

  it("advance on a missing room only pops, so it cannot create a queue key", async () => {
    const room = "advance-gone-7k7k";
    const res = await ADVANCE_POST(new NextRequest(`http://127.0.0.1:3040/api/queue/advance?room=${room}`, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await store.getQueue(room)).toEqual([]);
  });
});
