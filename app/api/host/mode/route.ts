import { NextRequest, NextResponse } from "next/server";
import { requireHost, roomIdFromRequest } from "@/lib/host-auth";
import { getRoomMode, setRoomMode } from "@/lib/rooms";
import { relayQueue } from "@/lib/rotation";
import { MODE_META, normalizeRoomMode, type RoomMode } from "@/lib/rotation-modes";
import { track } from "@/lib/telemetry";

/**
 * POST /api/host/mode?room=<id> — switch the venue rotation mode (TICKET-10).
 * Body: `{ mode: RoomMode }`. Host-authed, room-scoped. Applies immediately with
 * no confirm (mode changes are reversible, per design §5) and re-lays the queue
 * so every polling view reflects the new fair order — no entry is ever lost
 * (the engine grandfathers over-cap entries; caps apply only to NEW submits).
 */
export async function POST(req: NextRequest) {
  const roomId = roomIdFromRequest(req);
  if (roomId === null) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }
  if (!(await requireHost(req, roomId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const raw = (body as Record<string, unknown>)?.mode;
  // Derived from MODE_META (security INFO-1, PR #14): the route's acceptance
  // set automatically tracks the canonical mode list — no inline literal to rot.
  const valid: readonly RoomMode[] = MODE_META.map((m) => m.mode);
  if (typeof raw !== "string" || !valid.includes(raw as RoomMode)) {
    return NextResponse.json(
      { error: `mode must be one of ${valid.join(" | ")}` },
      { status: 400 },
    );
  }
  const mode = normalizeRoomMode(raw);

  const before = await getRoomMode(roomId);
  const applied = await setRoomMode(roomId, mode);
  if (applied === null) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  // Re-lay under the new policy (grandfathers everyone; recomputes fair order).
  await relayQueue(roomId, mode);

  // Telemetry: a new host_action variant (single new prop — NOT a new event
  // type). `from` lets the rollup see mode-adoption transitions.
  void track("host_action", {
    roomId,
    props: { action: "mode_change", mode, from: before },
  });

  return NextResponse.json({ ok: true, mode });
}
