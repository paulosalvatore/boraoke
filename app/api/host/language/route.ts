import { NextRequest, NextResponse } from "next/server";
import { requireHost, roomIdFromRequest } from "@/lib/host-auth";
import { getRoomLanguage, setRoomLanguage } from "@/lib/rooms";
import { isLocale, LOCALES, type Locale } from "@/i18n/locales";
import { track } from "@/lib/telemetry";

/**
 * POST /api/host/language?room=<id> — set the room's default UI language
 * (TICKET-30). Body: `{ language: Locale }`. Host-authed, room-scoped. The room
 * language drives the TV surface (which never follows a per-user cookie) and the
 * first-visit default for patrons with no explicit locale cookie. Additive: no
 * queue re-lay, no effect on rotation.
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

  const raw = (body as Record<string, unknown>)?.language;
  if (!isLocale(raw)) {
    return NextResponse.json(
      { error: `language must be one of ${LOCALES.join(" | ")}` },
      { status: 400 },
    );
  }
  const language: Locale = raw;

  const before = await getRoomLanguage(roomId);
  const applied = await setRoomLanguage(roomId, language);
  if (applied === null) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  void track("host_action", {
    roomId,
    props: { action: "language_change", language, from: before },
  });

  return NextResponse.json({ ok: true, language });
}
