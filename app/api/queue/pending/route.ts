import { NextRequest, NextResponse } from "next/server";
import { pendingStore } from "@/lib/pending-store";
import { isValidRoomId, DEFAULT_ROOM } from "@/lib/rooms";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/queue/pending?room=<id>&uuid=<patronUuid> — a patron's OWN pending +
 * recently-rejected submissions (TICKET-44). Public but strictly uuid-scoped:
 * it only ever returns entries whose `patronUuid` matches the query `uuid`, so
 * one patron can never read another's pending list, and it never exposes the
 * whole room list (that is the host-authed `/api/host/pending`). The patron view
 * polls this on the same 3s cadence to show "aguardando aprovação" and, on
 * reject, the polite rejected state.
 */
export async function GET(req: NextRequest) {
  const rawRoom = req.nextUrl.searchParams.get("room");
  const roomId =
    rawRoom == null || rawRoom === ""
      ? DEFAULT_ROOM
      : isValidRoomId(rawRoom)
        ? rawRoom
        : null;
  if (roomId === null) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  const uuid = req.nextUrl.searchParams.get("uuid");
  if (!uuid || !UUID_RE.test(uuid)) {
    // No/invalid uuid → empty (never a 4xx that would spam the patron's poll log).
    return NextResponse.json({ items: [] });
  }

  const items = await pendingStore.listForUuid(roomId, uuid);
  return NextResponse.json({ items });
}
