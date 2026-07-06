/**
 * /api/t (TICKET-12) — the single tiny telemetry beacon.
 *
 * POST only, public, anonymous. Exists for CLIENT-ONLY moments the server
 * can't observe (patron join without a server call) — everything
 * server-observable (incl. song_played, review C1) is emitted directly from
 * API routes instead.
 *
 *   - Accepts ONLY the CLIENT_ALLOWED_EVENTS subset — a client claiming
 *     server-observable events (song_queued, host_action, …) would poison the
 *     data, so those names are rejected.
 *   - `ts` and `appVersion` are server-filled; client values are ignored.
 *   - FAIL-OPEN: a storage outage still returns 202 — telemetry must never
 *     surface an error into the patron flow. Validation failures return 4xx
 *     (that's a caller bug, not a telemetry outage).
 *   - No cookies, no client SDK, nothing a consent banner would need to gate.
 */

import { NextRequest, NextResponse } from "next/server";
import { track } from "@/lib/telemetry";
import { beaconRateLimitOk } from "@/lib/telemetry-rate-limit";
import {
  CLIENT_ALLOWED_EVENTS,
  ROOM_ID_RE,
  SESSION_KEY_RE,
  UUID_RE,
  type TelemetryEventName,
} from "@/lib/telemetry-types";

const MAX_BODY_BYTES = 2048;

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

/**
 * Caller IP for the rate-limit bucket (security M1). On Vercel the first hop
 * of x-forwarded-for is the client IP (the platform sets/normalizes the
 * header); x-real-ip is the fallback. "" when neither is present (unit tests).
 */
function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() ?? "";
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return badRequest("Request body too large");
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return badRequest("Invalid JSON");
  }
  if (typeof body !== "object" || body === null) {
    return badRequest("Body must be an object");
  }

  const { event, roomId, sessionKey, uuid, props } = body as Record<
    string,
    unknown
  >;

  if (
    typeof event !== "string" ||
    !CLIENT_ALLOWED_EVENTS.includes(event as TelemetryEventName)
  ) {
    return badRequest("Unknown or non-beaconable event");
  }

  // roomId charset allowlist (security M2, ingest side): keeps markdown/
  // control characters out of the store entirely.
  if (typeof roomId !== "string" || !ROOM_ID_RE.test(roomId.trim())) {
    return badRequest("roomId is required (letters, digits, . _ -; max 64)");
  }

  // uuid is optional, but when present it must look like an anonymous uuid —
  // rejecting anything else keeps arbitrary identifiers out of the store.
  let cleanUuid: string | undefined;
  if (uuid != null) {
    if (typeof uuid !== "string" || !UUID_RE.test(uuid.trim())) {
      return badRequest("uuid must be a valid UUID when provided");
    }
    cleanUuid = uuid.trim();
  }

  // sessionKey shape validation (security L2): opaque short token or absent.
  let cleanSessionKey: string | undefined;
  if (sessionKey != null && sessionKey !== "") {
    if (typeof sessionKey !== "string" || !SESSION_KEY_RE.test(sessionKey.trim())) {
      return badRequest("sessionKey must match [A-Za-z0-9._-]{1,64} when provided");
    }
    cleanSessionKey = sessionKey.trim();
  }

  // Rate limit (security M1): dual-bucket (session key + IP). Over-limit
  // events are SILENTLY DROPPED (204, nothing stored) — never an error, the
  // beacon stays fail-open for the app.
  const rateKey = cleanUuid ?? cleanSessionKey ?? "";
  if (!beaconRateLimitOk(rateKey, clientIp(req))) {
    return new NextResponse(null, { status: 204 });
  }

  // Fire-and-forget: track() never rejects (fail-open by contract), and
  // sanitizeProps inside it reduces `props` to a small scalar bag.
  await track(event as TelemetryEventName, {
    roomId: roomId.trim(),
    ...(cleanSessionKey ? { sessionKey: cleanSessionKey } : {}),
    ...(cleanUuid ? { uuid: cleanUuid } : {}),
    ...(props != null && typeof props === "object"
      ? { props: props as Record<string, unknown> }
      : {}),
  });

  return NextResponse.json({ ok: true }, { status: 202 });
}
