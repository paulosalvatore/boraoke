import { NextRequest, NextResponse } from "next/server";
import {
  requireHost,
  isHostConfigured,
  hostCookieName,
  roomIdFromRequest,
  HOST_COOKIE_PATH,
} from "@/lib/host-auth";

/**
 * GET /api/host/session?room=<id> — cheap auth probe the admin page calls on
 * load to decide between the login gate and the dashboard. 200 when the room's
 * session cookie is valid, 401 otherwise, 400 on a malformed room id.
 * `configured` tells the client whether host controls exist for the room (so an
 * unconfigured / unknown room can show a helpful message).
 */
export async function GET(req: NextRequest) {
  const roomId = roomIdFromRequest(req);
  if (roomId === null) {
    return NextResponse.json({ authed: false, configured: false }, { status: 400 });
  }
  const configured = await isHostConfigured(roomId);
  if (!(await requireHost(req, roomId))) {
    return NextResponse.json({ authed: false, configured }, { status: 401 });
  }
  return NextResponse.json({ authed: true, configured });
}

/**
 * POST /api/host/session?room=<id> — log out by clearing the room's session
 * cookie.
 */
export async function POST(req: NextRequest) {
  const roomId = roomIdFromRequest(req);
  const res = NextResponse.json({ ok: true });
  if (roomId !== null) {
    // Path must match the set-path (HOST_COOKIE_PATH) or the browser won't clear it.
    res.cookies.set(hostCookieName(roomId), "", { path: HOST_COOKIE_PATH, maxAge: 0 });
  }
  return res;
}
