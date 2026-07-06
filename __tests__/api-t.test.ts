/**
 * /api/t beacon tests (TICKET-12): strict validation (client-allowed event
 * subset only), server-filled ts/appVersion, and the route-level fail-open —
 * a storage outage still returns 202. Runs against the memory-driver
 * singleton (CI default), cleared between tests.
 */
import { POST } from "@/app/api/t/route";
import { telemetryStore } from "@/lib/telemetry-store";
import { NextRequest } from "next/server";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const TODAY = new Date().toISOString().slice(0, 10);

function beacon(body: unknown) {
  return new NextRequest("http://127.0.0.1:3012/api/t", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(async () => {
  await telemetryStore.clear();
});

describe("POST /api/t — happy path", () => {
  it("accepts a client-allowed event (202) and stores it with server fields", async () => {
    process.env.GIT_SHA = "beacon-sha";
    const res = await POST(
      beacon({
        event: "patron_joined",
        roomId: "room-a",
        uuid: UUID,
        ts: "1999-01-01T00:00:00.000Z", // client clock — must be ignored
        appVersion: "HACKED", // must be ignored
      }),
    );
    expect(res.status).toBe(202);
    const [e] = await telemetryStore.listRange(TODAY, TODAY);
    expect(e.event).toBe("patron_joined");
    expect(e.roomId).toBe("room-a");
    expect(e.uuid).toBe(UUID);
    expect(e.appVersion).toBe("beacon-sha");
    expect(e.ts.slice(0, 10)).toBe(TODAY); // server clock, not 1999
    delete process.env.GIT_SHA;
  });

  it("sanitizes props to a small scalar bag", async () => {
    const res = await POST(
      beacon({
        event: "song_played",
        roomId: "room-a",
        props: { position: 3, freeText: "x".repeat(400), nested: { a: 1 } },
      }),
    );
    expect(res.status).toBe(202);
    const [e] = await telemetryStore.listRange(TODAY, TODAY);
    expect(e.props?.position).toBe(3);
    expect((e.props?.freeText as string).length).toBeLessThanOrEqual(64);
    expect(e.props).not.toHaveProperty("nested");
  });
});

describe("POST /api/t — validation", () => {
  it("rejects server-observable event names (data-poisoning guard)", async () => {
    for (const event of ["song_queued", "host_action", "search_performed", "submit_rejected"]) {
      expect((await POST(beacon({ event, roomId: "r" }))).status).toBe(400);
    }
    expect(await telemetryStore.listDays()).toEqual([]);
  });

  it("rejects unknown events, missing roomId, and bad uuid (400)", async () => {
    expect((await POST(beacon({ event: "made_up", roomId: "r" }))).status).toBe(400);
    expect((await POST(beacon({ event: "patron_joined" }))).status).toBe(400);
    expect((await POST(beacon({ event: "patron_joined", roomId: "  " }))).status).toBe(400);
    expect(
      (await POST(beacon({ event: "patron_joined", roomId: "r", uuid: "not-a-uuid" }))).status,
    ).toBe(400);
  });

  it("rejects invalid JSON and oversized bodies (400)", async () => {
    expect((await POST(beacon("{nope"))).status).toBe(400);
    expect(
      (await POST(beacon({ event: "patron_joined", roomId: "r", junk: "x".repeat(4000) })))
        .status,
    ).toBe(400);
  });
});

describe("POST /api/t — fail-open (spec AC2)", () => {
  it("still returns 202 when the store append blows up", async () => {
    const spy = jest
      .spyOn(telemetryStore, "append")
      .mockRejectedValue(new Error("upstash outage"));
    const res = await POST(beacon({ event: "patron_joined", roomId: "room-a" }));
    expect(res.status).toBe(202);
    spy.mockRestore();
  });
});
