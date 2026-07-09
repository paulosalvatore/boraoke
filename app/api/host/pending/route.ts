import { NextRequest, NextResponse } from "next/server";
import { requireHost, roomIdFromRequest } from "@/lib/host-auth";
import { pendingStore } from "@/lib/pending-store";

/**
 * GET /api/host/pending?room=<id> — the room's pending-moderation list
 * (TICKET-44). Host-authed, room-scoped: the admin polls this on the same 3s
 * cadence as the queue to render the approval section. Returns pending AND
 * recently-rejected entries, oldest-first (fairest approval order). The public
 * queue / TV never see any of this — pending lives in a parallel keyspace.
 */
export async function GET(req: NextRequest) {
  const roomId = roomIdFromRequest(req);
  if (roomId === null) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }
  if (!(await requireHost(req, roomId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const items = await pendingStore.listRoom(roomId);
  return NextResponse.json({ items });
}
