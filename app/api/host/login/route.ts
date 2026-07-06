import { NextRequest, NextResponse } from "next/server";
import {
  hostCookieName,
  hostCookieOptions,
  issueSession,
  verifyHostToken,
  isHostConfigured,
  roomIdFromRequest,
  clientIpFrom,
  isLoginThrottled,
  registerLoginFailure,
  resetLoginThrottle,
} from "@/lib/host-auth";

const MAX_BODY_BYTES = 1024;

/**
 * POST /api/host/login?room=<id> — exchange the host code for an httpOnly
 * session cookie scoped to that room (per-room cookie name, TICKET-9).
 * Body: { token: string }. 200 on success, 400 on a malformed room id, 401 on a
 * bad/absent token, 429 when the caller's IP exhausted its failure budget,
 * 503 when host controls are not configured for the room. The token is never
 * logged and never returned to the client.
 */
export async function POST(req: NextRequest) {
  const roomId = roomIdFromRequest(req);
  if (roomId === null) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  if (!(await isHostConfigured(roomId))) {
    return NextResponse.json(
      { error: "Host controls are not configured for this venue." },
      { status: 503 },
    );
  }

  // Per-IP failure throttle (security M-1) — blocks unlimited online token
  // guessing. Checked before parsing so throttled callers are rejected cheaply.
  const ip = clientIpFrom(req);
  if (isLoginThrottled(ip)) {
    return NextResponse.json(
      { error: "Too many failed attempts — try again in a minute." },
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

  const token =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).token
      : undefined;

  if (!(await verifyHostToken(roomId, token))) {
    registerLoginFailure(ip);
    return NextResponse.json({ error: "Invalid host token" }, { status: 401 });
  }
  resetLoginThrottle(ip);

  const session = await issueSession(roomId);
  if (!session) {
    return NextResponse.json(
      { error: "Host controls are not configured for this venue." },
      { status: 503 },
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(hostCookieName(roomId), session, hostCookieOptions());
  return res;
}
