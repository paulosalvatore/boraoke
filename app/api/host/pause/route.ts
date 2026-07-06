import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { requireHost, roomIdFromRequest } from "@/lib/host-auth";
import { track } from "@/lib/telemetry";

const MAX_BODY_BYTES = 1024;

/**
 * POST /api/host/pause?room=<id> — set the room's paused flag.
 * Body: { paused: boolean }. Thin wrapper over the frozen store `setPaused` op.
 * /tv reads the flag via the public queue poll and freezes playback; patron
 * submits keep working while paused (paused only gates playback, not intake).
 * Token-guarded, room-scoped.
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

  const paused =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).paused
      : undefined;

  if (typeof paused !== "boolean") {
    return NextResponse.json({ error: "paused must be a boolean" }, { status: 400 });
  }

  await store.setPaused(roomId, paused);
  void track("host_action", { roomId, props: { action: paused ? "pause" : "resume" } }); // TICKET-12: fire-and-forget, fail-open
  return NextResponse.json({ ok: true, paused });
}
