import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { requireHost, roomIdFromRequest } from "@/lib/host-auth";

/**
 * POST /api/host/skip?room=<id> — advance past the current head immediately,
 * regardless of playback position. Thin wrapper over the frozen store `advance`
 * op (the same one /tv uses on video end). Token-guarded, room-scoped.
 */
export async function POST(req: NextRequest) {
  const roomId = roomIdFromRequest(req);
  if (roomId === null) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }
  if (!(await requireHost(req, roomId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const nowPlaying = await store.advance(roomId);
  return NextResponse.json({ ok: true, nowPlaying });
}
