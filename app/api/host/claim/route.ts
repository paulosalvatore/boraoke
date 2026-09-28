import { NextRequest, NextResponse } from "next/server";
import {
  attachClaimCookie,
  claimTokenFrom,
  clientIpFrom,
  hostCookieName,
  hostCookieOptions,
  isClaimThrottled,
  issueSession,
  registerClaimFailure,
  resetClaimThrottle,
  roomIdFromRequest,
  verifyClaim,
} from "@/lib/host-auth";

/**
 * POST /api/host/claim?room=<id> — no-typing admin re-entry for a device that
 * holds the room's ADMIN CLAIM TOKEN (TICKET-104).
 *
 * Why this exists: the host code is shown exactly once at `/new` and is
 * deliberately unrecoverable (only its hash is stored), so once the 30-day
 * rolling host session lapses or is cleared, a creator who never wrote the code
 * down has no way back in at all. Nobody hands a creator that code, so requiring
 * them to type it is a dead end, not a safety net.
 *
 * SECURITY CONTRACT. Each line below is a property the code enforces here, with
 * the evidence or the mechanism named — written this way on purpose, because the
 * previous version of this comment asserted a property that turned out to be
 * FALSE and, being phrased as a contract, read as verified to everyone after it.
 *
 *  1. The credential is the httpOnly `boraoke_claim_<room>` cookie, whose raw
 *     value is minted server-side, is never returned in any response body, is
 *     never mirrored into localStorage, and is never read from a body or query.
 *     MECHANISM: the only read is `claimTokenFrom` (cookie), and the only writes
 *     are `attachClaimCookie` on room creation and on host-code login.
 *     NOT the identity uuid, which page JS can read via the `/api/identity` echo
 *     and the `cantai_patron_uuid` mirror — see `claimCookieName`'s note.
 *  2. Only the token's HASH is stored (`Room.claimTokenHashes`), so a store leak
 *     yields nothing replayable.
 *  3. Revocation is SERVER-SIDE: logout clears the hashes, so a token copied off
 *     the device stops working for the copier too. ASSUMPTION MADE EXPLICIT: this
 *     holds only because the room record is the single source of truth for
 *     validity — nothing here trusts a client-side opt-out marker, which is what
 *     the previous design got wrong.
 *  4. `default` is never claimable: it has no room record and is governed by the
 *     shared env `HOST_TOKEN`.
 *  5. The failure budget is keyed on the SERVER-DERIVED client IP and is
 *     consulted ONLY after verification has already failed, so a valid token can
 *     never be denied by other traffic on a shared venue IP, and a caller cannot
 *     choose its own bucket key. See the long note beside `isClaimThrottled`.
 *
 * Responses: 200 `{ authed: true }` + the room's session cookie (and a rolled
 * claim cookie) on a match; 400 on a malformed room id; 401 on any non-match
 * (no token, wrong token, revoked, unknown room) — deliberately undifferentiated;
 * 429 `{ throttled: true }` once this IP's failure budget is spent; 503 when host
 * controls are unconfigured.
 */
export async function POST(req: NextRequest) {
  const roomId = roomIdFromRequest(req);
  if (roomId === null) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  // No credential presented → nothing to verify, nothing learned, nothing
  // charged, and no store read. This is the ordinary case for every patron who
  // ever opens an admin URL, so it must stay free (contract line 5).
  if (!claimTokenFrom(req, roomId)) {
    return NextResponse.json({ authed: false }, { status: 401 });
  }

  // Verify BEFORE touching the throttle: a live credential is never subject to a
  // failure budget, which is what keeps a shared venue IP from locking out the
  // room's own owner (contract line 5).
  if (!(await verifyClaim(req, roomId))) {
    const ip = clientIpFrom(req);
    if (await isClaimThrottled(ip)) {
      return NextResponse.json({ authed: false, throttled: true }, { status: 429 });
    }
    await registerClaimFailure(ip);
    return NextResponse.json({ authed: false }, { status: 401 });
  }

  const session = await issueSession(roomId);
  if (!session) {
    // Host controls locked for this room (production with nothing configured).
    // Not a failed attempt — don't charge the budget.
    return NextResponse.json(
      { error: "Host controls are not configured for this venue." },
      { status: 503 },
    );
  }
  await resetClaimThrottle(clientIpFrom(req));

  const res = NextResponse.json({ authed: true });
  res.cookies.set(hostCookieName(roomId), session, hostCookieOptions());
  // Roll the claim credential too, so an active venue's device never ages out of
  // the bounded window (and the old token stops working once it falls off the
  // room's capped list).
  await attachClaimCookie(res, roomId);
  return res;
}
