/**
 * /api/t (TICKET-12) — the single tiny telemetry beacon.
 *
 * POST only, public, anonymous. Exists for CLIENT-ONLY moments the server
 * can't observe (patron join without a server call, TV playback start) —
 * everything server-observable is emitted directly from API routes instead.
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
import {
  CLIENT_ALLOWED_EVENTS,
  MAX_ROOM_ID,
  UUID_RE,
  type TelemetryEventName,
} from "@/lib/telemetry-types";

const MAX_BODY_BYTES = 2048;

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
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

  if (typeof roomId !== "string" || !roomId.trim()) {
    return badRequest("roomId is required");
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

  const cleanSessionKey =
    typeof sessionKey === "string" && sessionKey.trim()
      ? sessionKey.trim()
      : undefined;

  // Fire-and-forget: track() never rejects (fail-open by contract), and
  // sanitizeProps inside it reduces `props` to a small scalar bag.
  await track(event as TelemetryEventName, {
    roomId: roomId.trim().slice(0, MAX_ROOM_ID),
    ...(cleanSessionKey ? { sessionKey: cleanSessionKey } : {}),
    ...(cleanUuid ? { uuid: cleanUuid } : {}),
    ...(props != null && typeof props === "object"
      ? { props: props as Record<string, unknown> }
      : {}),
  });

  return NextResponse.json({ ok: true }, { status: 202 });
}
