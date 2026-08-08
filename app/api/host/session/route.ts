import { NextRequest, NextResponse } from "next/server";
import {
  requireHost,
  isHostConfigured,
  hostCookieName,
  hostCookieOptions,
  roomIdFromRequest,
  HOST_COOKIE_PATH,
} from "@/lib/host-auth";

/**
 * GET /api/host/session?room=<id> — cheap auth probe the admin page calls on
 * load to decide between the login gate and the dashboard. 200 when the room's
 * session cookie is valid, 401 otherwise, 400 on a malformed room id.
 * `configured` tells the client whether host controls exist for the room (so an
 * unconfigured / unknown room can show a helpful message).
 *
 * ROLLING REFRESH (TICKET-76): on a SUCCESSFUL probe we re-set the very cookie
 * we just verified, with a fresh `SESSION_MAX_AGE_SECONDS` and byte-identical
 * options (httpOnly / path=/api/host / sameSite=lax / prod-secure). Because the
 * admin dashboard and the landing page's "Suas salas" both hit this endpoint,
 * a host who keeps using their room never falls out of the window.
 *
 * The refresh is deliberately INSIDE the success branch and re-sends the value
 * taken from the request (never a freshly minted one), so no code path here can
 * create a session for a caller that did not already present a valid one: the
 * 400 and 401 branches return before this and set no cookie at all.
 */
export async function GET(req: NextRequest) {
  const roomId = roomIdFromRequest(req);
  if (roomId === null) {
    return noStore(NextResponse.json({ authed: false, configured: false }, { status: 400 }));
  }
  const configured = await isHostConfigured(roomId);
  if (!(await requireHost(req, roomId))) {
    // 401 — no cookie is set, minted or extended on this path.
    return noStore(NextResponse.json({ authed: false, configured }, { status: 401 }));
  }
  const res = noStore(NextResponse.json({ authed: true, configured }));
  // Verified above by requireHost(), so this value is the room's valid session.
  const verified = req.cookies.get(hostCookieName(roomId))?.value;
  if (verified) {
    res.cookies.set(hostCookieName(roomId), verified, hostCookieOptions());
  }
  return res;
}

/**
 * This is the app's only cookie-bearing GET, and since TICKET-76 it also
 * carries the rolling `Set-Cookie`. Mark it uncacheable so no shared proxy can
 * serve one host's `authed` answer to another caller, and so a client-side
 * cache hit cannot silently skip the session roll.
 */
function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "private, no-store");
  return res;
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
