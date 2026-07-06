import { NextRequest, NextResponse } from "next/server";
import { store, DEFAULT_ROOM } from "@/lib/store";
import { requireHost } from "@/lib/host-auth";

const MAX_BODY_BYTES = 1024;

/**
 * POST /api/host/remove — remove an entry by id from anywhere in the queue.
 * Body: { entryId: string }. Thin wrapper over the frozen store `removeEntry`
 * op. Token-guarded. Returns { ok, removed } — removed=false when the id was
 * not found (already gone), still a 200 (idempotent for the host UI).
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

  const entryId =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).entryId
      : undefined;

  if (typeof entryId !== "string" || !entryId) {
    return NextResponse.json({ error: "entryId is required" }, { status: 400 });
  }

  const removed = await store.removeEntry(DEFAULT_ROOM, entryId);
  return NextResponse.json({ ok: true, removed });
}
