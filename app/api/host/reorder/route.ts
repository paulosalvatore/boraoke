import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { requireHost, roomIdFromRequest } from "@/lib/host-auth";

const MAX_BODY_BYTES = 1024;

/**
 * POST /api/host/reorder?room=<id> — move an entry to a new index.
 * Body: { entryId: string, newIndex: number }. Thin wrapper over the frozen
 * store `reorder` op (which clamps the index). Token-guarded, room-scoped.
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

  const obj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const entryId = obj.entryId;
  const newIndex = obj.newIndex;

  if (typeof entryId !== "string" || !entryId) {
    return NextResponse.json({ error: "entryId is required" }, { status: 400 });
  }
  if (typeof newIndex !== "number" || !Number.isInteger(newIndex)) {
    return NextResponse.json({ error: "newIndex must be an integer" }, { status: 400 });
  }

  const moved = await store.reorder(roomId, entryId, newIndex);
  return NextResponse.json({ ok: true, moved });
}
