import { NextRequest, NextResponse } from "next/server";
import { store, DEFAULT_ROOM } from "@/lib/store";
import { isValidRoomId } from "@/lib/rooms";

/**
 * POST /api/queue/advance?room=<id> — advance the room's queue head (called by
 * /tv on video end). Absent `room` = the legacy `default` room. Validates the
 * id before it reaches a Redis key.
 */
export async function POST(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("room");
  const roomId = raw == null || raw === "" ? DEFAULT_ROOM : raw;
  if (!isValidRoomId(roomId)) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }
  const next = await store.advance(roomId);
  return NextResponse.json({
    nowPlaying: next,
    message: next ? "Advanced to next entry" : "Queue is now empty",
  });
}
