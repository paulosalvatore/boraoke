import { NextRequest, NextResponse } from "next/server";
import { requireHost, roomIdFromRequest } from "@/lib/host-auth";
import { pendingStore } from "@/lib/pending-store";
import { track } from "@/lib/telemetry";

const MAX_BODY_BYTES = 1024;

/**
 * POST /api/host/pending/reject?room=<id> — reject a pending submission
 * (TICKET-44). Body: `{ pendingId }`. Host-authed, room-scoped. The entry is
 * flipped to `rejected` (kept briefly so the patron's own uuid-scoped poll can
 * surface a polite rejected state) rather than deleted outright. The entry never
 * entered the queue, so there is nothing to remove there.
 */
export async function POST(req: NextRequest) {
  const roomId = roomIdFromRequest(req);
  if (roomId === null) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }
  if (!(await requireHost(req, roomId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const pendingId = (body as Record<string, unknown>)?.pendingId;
  if (typeof pendingId !== "string" || !pendingId) {
    return NextResponse.json({ error: "pendingId is required" }, { status: 400 });
  }

  const item = await pendingStore.reject(roomId, pendingId);
  if (!item) {
    return NextResponse.json({ error: "Pending entry not found" }, { status: 404 });
  }

  // Telemetry: host rejected (new host_action prop VALUE) + the submission was
  // refused for moderation (new submit_rejected reason VALUE). No new event types.
  void track("host_action", { roomId, props: { action: "reject" } });
  void track("submit_rejected", {
    roomId,
    uuid: item.entry.patronUuid,
    props: { reason: "moderation" },
  });

  return NextResponse.json({ ok: true });
}
