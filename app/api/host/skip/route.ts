import { NextRequest, NextResponse } from "next/server";
import { store, DEFAULT_ROOM } from "@/lib/store";
import { requireHost } from "@/lib/host-auth";

/**
 * POST /api/host/skip — advance past the current head immediately, regardless
 * of playback position. Thin wrapper over the frozen store `advance` op (the
 * same one /tv uses on video end). Token-guarded.
 */
export async function POST(req: NextRequest) {
  if (!requireHost(req, DEFAULT_ROOM)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const nowPlaying = await store.advance(DEFAULT_ROOM);
  return NextResponse.json({ ok: true, nowPlaying });
}
