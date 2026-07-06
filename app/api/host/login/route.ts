import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_ROOM } from "@/lib/store";
import {
  HOST_COOKIE,
  hostCookieOptions,
  issueSession,
  verifyHostToken,
  isHostConfigured,
} from "@/lib/host-auth";

const MAX_BODY_BYTES = 1024;

/**
 * POST /api/host/login — exchange the host token for an httpOnly session cookie.
 * Body: { token: string }. Returns 200 on success, 401 on a bad/absent token,
 * 503 when host controls are not configured (production without HOST_TOKEN).
 * The token is never logged and never returned to the client.
 */
export async function POST(req: NextRequest) {
  if (!isHostConfigured(DEFAULT_ROOM)) {
    return NextResponse.json(
      { error: "Host controls are not configured for this venue." },
      { status: 503 },
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

  if (!verifyHostToken(DEFAULT_ROOM, token)) {
    return NextResponse.json({ error: "Invalid host token" }, { status: 401 });
  }

  const session = issueSession(DEFAULT_ROOM);
  if (!session) {
    return NextResponse.json(
      { error: "Host controls are not configured for this venue." },
      { status: 503 },
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(HOST_COOKIE, session, hostCookieOptions());
  return res;
}
