import { NextRequest, NextResponse } from "next/server";
import { store, DEFAULT_ROOM } from "@/lib/store";
import { requireHost } from "@/lib/host-auth";

const MAX_BODY_BYTES = 1024;

/**
 * POST /api/host/pause — set the room's paused flag.
 * Body: { paused: boolean }. Thin wrapper over the frozen store `setPaused` op.
 * /tv reads the flag via the public queue poll and freezes playback; patron
 * submits keep working while paused (paused only gates playback, not intake).
 * Token-guarded.
 */
export async function POST(req: NextRequest) {
  if (!requireHost(req, DEFAULT_ROOM)) {
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

  await store.setPaused(DEFAULT_ROOM, paused);
  return NextResponse.json({ ok: true, paused });
}
