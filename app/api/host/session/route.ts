import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_ROOM } from "@/lib/store";
import { requireHost, isHostConfigured } from "@/lib/host-auth";

/**
 * GET /api/host/session — cheap auth probe the admin page calls on load to
 * decide between the login gate and the dashboard. 200 when the session cookie
 * is valid, 401 otherwise. `configured` tells the client whether a token is set
 * at all (so production-without-token can show a helpful message).
 */
export async function GET(req: NextRequest) {
  const configured = isHostConfigured(DEFAULT_ROOM);
  if (!requireHost(req, DEFAULT_ROOM)) {
    return NextResponse.json({ authed: false, configured }, { status: 401 });
  }
  return NextResponse.json({ authed: true, configured });
}

/**
 * POST /api/host/session — log out by clearing the session cookie.
 */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("cantai_host", "", { path: "/", maxAge: 0 });
  return res;
}
