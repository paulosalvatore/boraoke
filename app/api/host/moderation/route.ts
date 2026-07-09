import { NextRequest, NextResponse } from "next/server";
import { requireHost, roomIdFromRequest } from "@/lib/host-auth";
import { getRoomModeration, setRoomModeration } from "@/lib/rooms";
import { track } from "@/lib/telemetry";

/**
 * POST /api/host/moderation?room=<id> — toggle venue-optional song moderation
 * (TICKET-44). Body: `{ moderation: boolean }`. Host-authed, room-scoped. When
 * ON, patron submissions divert to the pending keyspace and only enter the queue
 * on host approval; when OFF (default), submissions flow straight to the queue.
 * Additive: no queue re-lay, no effect on the current queue or rotation. Mirrors
 * `/api/host/language` exactly.
 */
export async function POST(req: NextRequest) {
  const roomId = roomIdFromRequest(req);
  if (roomId === null) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }
  if (!(await requireHost(req, roomId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const raw = (body as Record<string, unknown>)?.moderation;
  if (typeof raw !== "boolean") {
    return NextResponse.json(
      { error: "moderation must be a boolean" },
      { status: 400 },
    );
  }

  const before = await getRoomModeration(roomId);
  const applied = await setRoomModeration(roomId, raw);
  if (applied === null) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  // Telemetry: a new host_action variant (new prop VALUE, NOT a new event type).
  void track("host_action", {
    roomId,
    props: { action: "moderation_change", moderation: raw, from: before },
  });

  return NextResponse.json({ ok: true, moderation: raw });
}
