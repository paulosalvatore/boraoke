import { NextRequest, NextResponse } from "next/server";
import {
  clientIpFrom,
  hasNoClaimMarker,
  hostCookieName,
  hostCookieOptions,
  isClaimThrottled,
  issueSession,
  registerClaimFailure,
  resetClaimThrottle,
  roomIdFromRequest,
  verifyCreatorClaim,
} from "@/lib/host-auth";
import { IDENTITY_COOKIE } from "@/lib/identity";

/**
 * POST /api/host/claim?room=<id> — no-typing admin re-entry for the room's
 * CREATOR (TICKET-104).
 *
 * Why this exists: the host code is shown exactly once at `/new` and is
 * deliberately unrecoverable (only its hash is stored), so once the 30-day
 * rolling host session lapses or is cleared, a creator who never wrote the code
 * down has no way back in at all. Nobody hands a creator that code, so requiring
 * them to type it is a dead end, not a safety net.
 *
 * The proof is the `boraoke_identity` cookie: httpOnly, root-path, 2-year
 * (`lib/identity.ts`), matched against the room's `creatorUuid`, which is
 * server-side only and never returned by any endpoint. See
 * `verifyCreatorClaim` in `lib/host-auth.ts` for the full reasoning.
 *
 * SECURITY CONTRACT (all four lines are load-bearing):
 *   1. The identity uuid is read ONLY from the cookie. This route reads no body
 *      and no query parameter other than `room`, so the localStorage mirror
 *      `cantai_patron_uuid` is not a credential for anything here.
 *   2. Minting an identity cookie for a uuid you merely assert is blocked
 *      upstream by the ADOPTION GUARD in `lib/identity.ts` — without that guard
 *      this route would be trivially bypassable.
 *   3. A room with no `creatorUuid` is not claimable (legacy rooms, and rooms
 *      created while the identity store was down).
 *   4. A device that deliberately LOGGED OUT of this room is refused until the
 *      host code is entered again (`hasNoClaimMarker`). Otherwise logout would
 *      be meaningless for a creator: their identity cookie outlives it by years.
 *   5. Failures burn a per-IP budget so a caller cannot sweep room ids looking
 *      for a claimable one. It is claim's OWN bucket, never login's: every
 *      session-less visit to an admin URL costs one claim attempt, so sharing
 *      the login budget would let ordinary traffic 429 the creator's own code
 *      gate (see the note beside `isClaimThrottled` in `lib/host-auth.ts`).
 *
 * Responses: 200 `{ authed: true }` + the room's session cookie on a match; 400 on a
 * malformed room id; 401 on any non-match (no cookie, wrong uuid, no creator on
 * record) with no cookie set and no detail about which of those it was; 429 when
 * the IP's failure budget is spent; 503 when host controls are unconfigured.
 */
export async function POST(req: NextRequest) {
  const roomId = roomIdFromRequest(req);
  if (roomId === null) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  const ip = clientIpFrom(req);
  if (await isClaimThrottled(ip)) {
    return NextResponse.json(
      { error: "Too many failed attempts — try again in a minute." },
      { status: 429 },
    );
  }

  // Deliberate logout wins over auto-claim (contract line 4 above). Not a
  // failed attempt — an opt-out, so it does not charge the throttle.
  if (hasNoClaimMarker(req, roomId)) {
    return NextResponse.json({ authed: false }, { status: 401 });
  }

  // Cookie ONLY — never a body/query uuid (contract line 1 above).
  const identityUuid = req.cookies.get(IDENTITY_COOKIE)?.value;

  if (!(await verifyCreatorClaim(roomId, identityUuid))) {
    await registerClaimFailure(ip);
    return NextResponse.json({ authed: false }, { status: 401 });
  }

  const session = await issueSession(roomId);
  if (!session) {
    // Host controls locked for this room (production with nothing configured).
    // Not a failed attempt — don't charge the throttle.
    return NextResponse.json(
      { error: "Host controls are not configured for this venue." },
      { status: 503 },
    );
  }
  await resetClaimThrottle(ip);

  const res = NextResponse.json({ authed: true });
  res.cookies.set(hostCookieName(roomId), session, hostCookieOptions());
  return res;
}
