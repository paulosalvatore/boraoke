import { NextRequest, NextResponse } from "next/server";
import {
  createRoom,
  getPublicRoom,
  isValidRoomId,
  isEphemeralRoomStore,
} from "@/lib/rooms";
import { clientIpFrom } from "@/lib/host-auth";
import {
  isRoomCreateThrottled,
  registerRoomCreation,
} from "@/lib/room-create-throttle";
import { track } from "@/lib/telemetry";
import { getTranslations } from "next-intl/server";

const MAX_BODY_BYTES = 1024;
const MAX_NAME = 60;

/**
 * Whether the per-IP creation throttle is enforced. Always in production/test;
 * skipped in `next dev` UNLESS ROOM_CREATE_LIMIT is explicitly set — local
 * dev/e2e create rooms freely (mirrors the zero-config dev posture of the
 * store and host auth), while the env var lets a dev session opt in.
 */
function throttleEnforced(): boolean {
  return (
    process.env.NODE_ENV !== "development" ||
    Boolean(process.env.ROOM_CREATE_LIMIT)
  );
}

/**
 * GET /api/rooms?id=<roomId> — fetch a client-safe room view (id, name,
 * createdAt, settings). NEVER returns the host code. 400 on a malformed id,
 * 404 when the room does not exist.
 */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!isValidRoomId(id)) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }
  const room = await getPublicRoom(id);
  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }
  return NextResponse.json({ room });
}

/**
 * POST /api/rooms — create a room from a venue name.
 * Body: { name: string }. Returns { id, name, hostCode, joinPath }. The
 * hostCode is returned EXACTLY ONCE here (the creation moment) and never again
 * by any endpoint — possession of it is venue identity until accounts (#14).
 * Only the code's hash is stored (security MEDIUM-2).
 *
 * Abuse guards (security HIGH-1) — this is an unauthenticated write:
 *   429 — per-IP creation throttle (default 3/hour, env ROOM_CREATE_LIMIT).
 *   503 — global ROOM_MAX ceiling reached ("estamos lotados").
 */
export async function POST(req: NextRequest) {
  // Per-IP creation throttle — checked before parsing so throttled callers are
  // rejected cheaply.
  const ip = clientIpFrom(req);
  if (throttleEnforced() && (await isRoomCreateThrottled(ip))) {
    // i18n (TICKET-30): user-facing copy localized to the request locale (cookie
    // / Accept-Language via i18n/request.ts). Technical 4xx guards below stay in
    // English — a normal UI never surfaces them (see string audit).
    const te = await getTranslations("Errors");
    return NextResponse.json(
      { error: te("roomsRateLimited") },
      { status: 429 },
    );
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

  const name =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).name
      : undefined;

  if (typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ error: "Venue name is required" }, { status: 400 });
  }
  if (name.trim().length > MAX_NAME) {
    return NextResponse.json(
      { error: `Venue name must be at most ${MAX_NAME} characters` },
      { status: 400 },
    );
  }

  const created = await createRoom(name);
  if (!created) {
    // Global ROOM_MAX ceiling reached (HIGH-1) — polite, non-technical copy.
    const te = await getTranslations("Errors");
    return NextResponse.json(
      { error: te("roomsFull") },
      { status: 503 },
    );
  }
  await registerRoomCreation(ip);
  void track("room_created", { roomId: created.room.id }); // TICKET-12: fire-and-forget, fail-open

  return NextResponse.json(
    {
      id: created.room.id,
      name: created.room.name,
      hostCode: created.hostCode,
      joinPath: `/${created.room.id}`,
      // TICKET-20: tell the client whether rooms are ephemeral in this
      // deployment (prod on the memory driver) so /new shows the honest
      // temporary-room notice. Never true in dev/CI.
      ephemeral: isEphemeralRoomStore(),
    },
    { status: 201 },
  );
}
