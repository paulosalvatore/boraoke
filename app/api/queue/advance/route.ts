import { NextRequest, NextResponse } from "next/server";
import { store, DEFAULT_ROOM } from "@/lib/store";
import { isValidRoomId } from "@/lib/rooms";
import { track } from "@/lib/telemetry";
import { isAdvanceAuthorized, advanceAuthMode } from "@/lib/screen-token";
import { advanceRateLimitOk } from "@/lib/advance-rate-limit";

/**
 * Allowlisted skip reasons the TV client may attach to an advance (TICKET-41).
 * Anything else is ignored — never let a caller inject junk telemetry props.
 */
const ADVANCE_SKIP_REASONS = new Set(["unplayable"]);

/**
 * POST /api/queue/advance?room=<id>[&reason=unplayable] — advance the room's
 * queue head (called by /tv on video end, or by the TICKET-41 watchdog when a
 * video can't play: onError 2/5/100/101/150 or a stalled-out player). Absent
 * `room` = the legacy `default` room. Validates the id before it reaches a
 * Redis key. A valid `reason` additionally emits the existing `song_skipped`
 * event with that reason prop (props variant only — no new event types).
 *
 * AUTHORIZATION (TICKET-45): advance was unauthenticated — any patron who reads
 * the room QR could curl-skip the current singer. It now requires the room's
 * screen token (`X-Boraoke-Screen`, minted by the /[room]/tv server page) OR a
 * valid host session. Rollout is flag-gated: `ADVANCE_AUTH=log` (default) only
 * records a would-block observation; `ADVANCE_AUTH=enforce` returns 401. Rooms
 * with no configured secret are not enforced (no-key → fail-open). A per-room
 * advance rate limit is the defense-in-depth backstop against a scraped token.
 * See lib/screen-token.ts for the full model + honest threat note.
 */
export async function POST(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("room");
  const roomId = raw == null || raw === "" ? DEFAULT_ROOM : raw;
  if (!isValidRoomId(roomId)) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  // ── Advance-auth gate (TICKET-45) ──────────────────────────────────────────
  const auth = await isAdvanceAuthorized(req, roomId);
  const mode = advanceAuthMode();
  if (!auth.ok) {
    if (mode === "enforce") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // log-only: observe the would-block, then let the call proceed. This is the
    // quiet observation window before the TM flips ADVANCE_AUTH=enforce.
    console.warn(
      `[advance-auth] would-block advance room=${roomId} reason=${auth.reason} mode=log`,
    );
  }

  // Resolve the allowlisted skip reason BEFORE the rate-limit charge so the
  // limiter can pick the correct bucket (TICKET-47): a `reason=unplayable`
  // watchdog drain is charged to the separate, more generous unplayable bucket,
  // never the anti-grief singer-skip bucket.
  const rawReason = req.nextUrl.searchParams.get("reason");
  const skipReason =
    rawReason && ADVANCE_SKIP_REASONS.has(rawReason) ? rawReason : null;

  // ── Per-room advance rate limit (defense-in-depth backstop) ────────────────
  if (!advanceRateLimitOk(roomId, { unplayable: skipReason === "unplayable" })) {
    return NextResponse.json(
      { error: "Too many advances", reason: "rate" },
      { status: 429 },
    );
  }
  // Head being skipped — read BEFORE advance, telemetry-only (fail-open).
  const skipped = skipReason ? await store.nowPlaying(roomId) : null;
  const next = await store.advance(roomId);
  if (skipReason && skipped) {
    // TICKET-41: watchdog skip observability — existing event, new reason value.
    void track("song_skipped", {
      roomId,
      uuid: skipped.patronUuid,
      props: { reason: skipReason },
    });
  }
  if (next) void track("song_played", { roomId, uuid: next.patronUuid, props: { mode: next.mode } }); // TICKET-12 (C1): the ONE song_played source; fire-and-forget, fail-open
  return NextResponse.json({
    nowPlaying: next,
    message: next ? "Advanced to next entry" : "Queue is now empty",
  });
}
