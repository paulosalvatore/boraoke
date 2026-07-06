import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { requireHost, roomIdFromRequest } from "@/lib/host-auth";
import { track } from "@/lib/telemetry";

const MAX_BODY_BYTES = 1024;

/**
 * POST /api/host/remove?room=<id> — remove an entry by id from anywhere in the
 * queue. Body: { entryId: string }. Thin wrapper over the frozen store
 * `removeEntry` op. Token-guarded, room-scoped. Returns { ok, removed } —
 * removed=false when the id was not found (already gone), still 200 (idempotent).
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

  const entryId =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).entryId
      : undefined;

  if (typeof entryId !== "string" || !entryId) {
    return NextResponse.json({ error: "entryId is required" }, { status: 400 });
  }

  const removed = await store.removeEntry(roomId, entryId);
  if (removed) void track("host_action", { roomId, props: { action: "remove" } }); // TICKET-12: fire-and-forget, fail-open
  return NextResponse.json({ ok: true, removed });
}
