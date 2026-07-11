/**
 * Moderation submission-flow tests (TICKET-44) at the API layer. Covers the
 * `/api/queue` POST moderation branch (OFF = queued 201; ON = pending 202, NOT in
 * the public queue), the patron's uuid-scoped pending read, and the host
 * approve/reject routes including caps-AT-approval. Host routes run in the dev
 * fallback auth mode (HOST_TOKEN unset), so a logged-in cookie is derived and
 * passed exactly like the existing host-control tests.
 */
import { NextRequest } from "next/server";
import { GET as QUEUE_GET, POST as QUEUE_POST } from "@/app/api/queue/route";
import { GET as PENDING_GET } from "@/app/api/queue/pending/route";
import { POST as MODERATION_POST } from "@/app/api/host/moderation/route";
import { GET as HOST_PENDING_GET } from "@/app/api/host/pending/route";
import { POST as APPROVE_POST } from "@/app/api/host/pending/approve/route";
import { POST as REJECT_POST } from "@/app/api/host/pending/reject/route";
import { store } from "@/lib/store";
import { pendingStore } from "@/lib/pending-store";
import { telemetryStore } from "@/lib/telemetry-store";
import { createRoom } from "@/lib/rooms";
import { issueSession, hostCookieName } from "@/lib/host-auth";

const VIDEO = "dQw4w9WgXcQ";
const UUID_A = "123e4567-e89b-42d3-a456-426614174000";
const UUID_B = "223e4567-e89b-42d3-a456-426614174111";

/** Build a host-authed cookie header for a room (dev fallback token path). */
async function hostCookie(roomId: string): Promise<string> {
  const value = await issueSession(roomId);
  if (!value) throw new Error("host not configured in test env");
  return `${hostCookieName(roomId)}=${value}`;
}

function submit(room: string, uuid: string, over: Record<string, unknown> = {}) {
  return new NextRequest("http://127.0.0.1:3044/api/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room, videoId: VIDEO, nickname: "Zé", patronUuid: uuid, mode: "sing", ...over }),
  });
}

function queueGet(room: string) {
  return new NextRequest(`http://127.0.0.1:3044/api/queue?room=${encodeURIComponent(room)}`);
}

function patronPendingGet(room: string, uuid: string) {
  return new NextRequest(
    `http://127.0.0.1:3044/api/queue/pending?room=${encodeURIComponent(room)}&uuid=${encodeURIComponent(uuid)}`,
  );
}

async function setModeration(room: string, on: boolean) {
  const req = new NextRequest(`http://127.0.0.1:3044/api/host/moderation?room=${encodeURIComponent(room)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: await hostCookie(room) },
    body: JSON.stringify({ moderation: on }),
  });
  return MODERATION_POST(req);
}

async function hostPending(room: string) {
  const req = new NextRequest(`http://127.0.0.1:3044/api/host/pending?room=${encodeURIComponent(room)}`, {
    headers: { cookie: await hostCookie(room) },
  });
  return HOST_PENDING_GET(req);
}

async function approve(room: string, pendingId: string) {
  const req = new NextRequest(`http://127.0.0.1:3044/api/host/pending/approve?room=${encodeURIComponent(room)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: await hostCookie(room) },
    body: JSON.stringify({ pendingId }),
  });
  return APPROVE_POST(req);
}

async function reject(room: string, pendingId: string) {
  const req = new NextRequest(`http://127.0.0.1:3044/api/host/pending/reject?room=${encodeURIComponent(room)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: await hostCookie(room) },
    body: JSON.stringify({ pendingId }),
  });
  return REJECT_POST(req);
}

async function freshRoom(name: string): Promise<string> {
  const created = await createRoom(name);
  if (!created) throw new Error("room ceiling hit in test");
  await store.clear(created.room.id);
  await pendingStore.clear(created.room.id);
  return created.room.id;
}

describe("moderation OFF (default)", () => {
  it("submission goes straight to the queue (201), no pending", async () => {
    const room = await freshRoom("Mod Off Bar");
    const res = await QUEUE_POST(submit(room, UUID_A));
    expect(res.status).toBe(201);
    const q = await (await QUEUE_GET(queueGet(room))).json();
    expect(q.items).toHaveLength(1);
    expect(q.moderation).toBe(false);
    const pend = await (await PENDING_GET(patronPendingGet(room, UUID_A))).json();
    expect(pend.items).toHaveLength(0);
  });
});

describe("moderation ON", () => {
  it("submission is diverted to pending (202) and NOT in the public queue", async () => {
    const room = await freshRoom("Mod On Bar");
    expect((await setModeration(room, true)).status).toBe(200);

    const res = await QUEUE_POST(submit(room, UUID_A, { title: "Pending Song" }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.pending).toBe(true);
    expect(typeof body.pendingId).toBe("string");

    // Not in the public queue / not on TV.
    const q = await (await QUEUE_GET(queueGet(room))).json();
    expect(q.items).toHaveLength(0);
    expect(q.moderation).toBe(true);

    // Visible to THIS patron's uuid-scoped pending read…
    const mine = await (await PENDING_GET(patronPendingGet(room, UUID_A))).json();
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0].status).toBe("pending");
    // …but never to another patron's.
    const others = await (await PENDING_GET(patronPendingGet(room, UUID_B))).json();
    expect(others.items).toHaveLength(0);
  });

  it("host approve promotes the pending entry into the real queue", async () => {
    const room = await freshRoom("Approve Bar");
    await setModeration(room, true);
    const submitBody = await (await QUEUE_POST(submit(room, UUID_A, { title: "Approve Me" }))).json();

    const list = await (await hostPending(room)).json();
    expect(list.items).toHaveLength(1);

    const ok = await approve(room, submitBody.pendingId);
    expect(ok.status).toBe(200);

    // Now in the queue…
    const q = await (await QUEUE_GET(queueGet(room))).json();
    expect(q.items).toHaveLength(1);
    expect(q.items[0].title).toBe("Approve Me");
    // …and gone from pending.
    const after = await (await hostPending(room)).json();
    expect(after.items.filter((p: { status: string }) => p.status === "pending")).toHaveLength(0);
  });

  it("host reject flips the entry to rejected (patron sees it), never queued", async () => {
    const room = await freshRoom("Reject Bar");
    await setModeration(room, true);
    const submitBody = await (await QUEUE_POST(submit(room, UUID_A, { title: "Reject Me" }))).json();

    expect((await reject(room, submitBody.pendingId)).status).toBe(200);

    const q = await (await QUEUE_GET(queueGet(room))).json();
    expect(q.items).toHaveLength(0);

    const mine = await (await PENDING_GET(patronPendingGet(room, UUID_A))).json();
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0].status).toBe("rejected");
  });

  it("approve applies caps AT approval time — duplicate trips on the 2nd approve", async () => {
    // With moderation ON, BOTH identical submissions pass the submit-time
    // checkSubmit (the queue is empty while they sit pending), so the duplicate
    // rule can only be enforced AT APPROVAL. Approve #1 → queued; approve #2 → the
    // duplicate is now IN the queue → checkSubmit refuses → 409, entry stays
    // pending. This is the whole point of "caps apply at approval, not submit".
    const room = await freshRoom("Caps Bar");
    await setModeration(room, true);

    const p1 = await (await QUEUE_POST(submit(room, UUID_A, { title: "Dup" }))).json();
    const p2 = await (await QUEUE_POST(submit(room, UUID_A, { title: "Dup" }))).json();
    // Both were accepted into pending (submit-time filter saw an empty queue).
    expect(p1.pending).toBe(true);
    expect(p2.pending).toBe(true);

    expect((await approve(room, p1.pendingId)).status).toBe(200);
    // Second approval is refused by the duplicate rule AT approval time.
    const res = await approve(room, p2.pendingId);
    expect(res.status).toBe(409);
    // The refused entry is NOT lost — it stays pending for a retry after the drain.
    const still = await (await hostPending(room)).json();
    expect(
      still.items.some(
        (p: { pendingId: string; status: string }) =>
          p.pendingId === p2.pendingId && p.status === "pending",
      ),
    ).toBe(true);
    // And only ONE song made it into the real queue.
    const q = await (await QUEUE_GET(queueGet(room))).json();
    expect(q.items).toHaveLength(1);
  });
});

describe("moderation ON → OFF auto-rejects stranded pending (TICKET-49)", () => {
  const TODAY = new Date().toISOString().slice(0, 10);
  /** Wait for the fire-and-forget track() promise to settle. */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  /** The moderation_change telemetry prop bag for the latest toggle in a room. */
  async function lastModerationChange(room: string) {
    const events = await telemetryStore.listRange(TODAY, TODAY);
    const mine = events.filter(
      (e) => e.roomId === room && e.props?.action === "moderation_change",
    );
    return mine[mine.length - 1]?.props;
  }

  it("rejects ALL pending on ON → OFF and reports the count in telemetry", async () => {
    const room = await freshRoom("Strand Bar");
    await telemetryStore.clear();
    await setModeration(room, true);
    await QUEUE_POST(submit(room, UUID_A, { title: "One" }));
    await QUEUE_POST(submit(room, UUID_B, { title: "Two" }));
    expect(await pendingStore.countRoom(room)).toBe(2);

    // Flip OFF — the two stranded entries must be auto-rejected.
    expect((await setModeration(room, false)).status).toBe(200);
    expect(await pendingStore.countRoom(room)).toBe(0);

    // Each patron's next poll surfaces the rejected state (not left hanging).
    const a = await (await PENDING_GET(patronPendingGet(room, UUID_A))).json();
    expect(a.items[0].status).toBe("rejected");
    const b = await (await PENDING_GET(patronPendingGet(room, UUID_B))).json();
    expect(b.items[0].status).toBe("rejected");

    // Nothing was auto-approved into the live queue.
    const q = await (await QUEUE_GET(queueGet(room))).json();
    expect(q.items).toHaveLength(0);

    // Telemetry carries the rejected count on the ON → OFF change.
    await flush();
    expect(await lastModerationChange(room)).toMatchObject({
      action: "moderation_change",
      moderation: false,
      from: true,
      rejectedPending: 2,
    });
  });

  it("ON → OFF with zero pending is a clean no-op (count 0)", async () => {
    const room = await freshRoom("Empty Strand Bar");
    await telemetryStore.clear();
    await setModeration(room, true);
    expect((await setModeration(room, false)).status).toBe(200);
    await flush();
    expect((await lastModerationChange(room))?.rejectedPending).toBe(0);
  });

  it("OFF → ON rejects nothing (the enabling edge never auto-rejects)", async () => {
    // A fresh room defaults to moderation OFF, so the first toggle ON is the
    // OFF → ON edge — it must reject nothing (there is nothing to strand yet).
    const room = await freshRoom("Turn On Bar");
    await telemetryStore.clear();
    expect((await setModeration(room, true)).status).toBe(200); // OFF → ON
    await flush();
    expect((await lastModerationChange(room))?.rejectedPending).toBe(0);
  });

  it("a no-op ON → ON toggle rejects nothing", async () => {
    const room = await freshRoom("Noop Bar");
    await setModeration(room, true);
    await QUEUE_POST(submit(room, UUID_A, { title: "Stay Pending" }));
    await telemetryStore.clear();
    // Re-applying ON while already ON must not touch the pending entry.
    expect((await setModeration(room, true)).status).toBe(200);
    expect(await pendingStore.countRoom(room)).toBe(1);
    await flush();
    expect((await lastModerationChange(room))?.rejectedPending).toBe(0);
  });
});

describe("host moderation route auth", () => {
  it("rejects an unauthenticated toggle with 401", async () => {
    const room = await freshRoom("Auth Bar");
    const req = new NextRequest(`http://127.0.0.1:3044/api/host/moderation?room=${encodeURIComponent(room)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moderation: true }),
    });
    expect((await MODERATION_POST(req)).status).toBe(401);
  });
});
