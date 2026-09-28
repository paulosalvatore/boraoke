import { NextRequest, NextResponse } from "next/server";
import {
  requireHost,
  isHostConfigured,
  hostCookieName,
  hostCookieOptions,
  roomIdFromRequest,
  HOST_COOKIE_PATH,
  claimCookieName,
  attachClaimCookie,
  verifyClaim,
  isCrossSiteRequest,
} from "@/lib/host-auth";
import { revokeRoomClaimTokens } from "@/lib/rooms";

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
  // TICKET-104: roll the ADMIN CLAIM credential on the same success, for the same
  // reason. Its window is bounded (180 days) rather than effectively permanent,
  // and a host who keeps using their room may never hit the claim route at all —
  // so without this, an actively-used venue's device could age out of the
  // no-typing path and land on a code it does not have. Only on a verified
  // session, and only when the device already presents a live claim token: this
  // path must never MINT authority for a caller, merely extend what it proved.
  if (await verifyClaim(req, roomId)) {
    await attachClaimCookie(res, roomId);
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
 * POST /api/host/session?room=<id> — log out: end this room's host session and
 * REVOKE its admin-claim credential.
 *
 * AUTHENTICATED, and that is a security requirement rather than tidiness
 * (TICKET-104 security gate, B-S2). Before TICKET-104 an unauthenticated logout
 * merely cleared the caller's own cookie, which was harmless. Once logout also
 * turns off the no-typing re-entry path, an unauthenticated one becomes a remote
 * denial of service: the gate proved, in a real browser, that any third-party
 * page could auto-submit a cross-site form POST to this route for a guessable
 * room slug and drop the venue's owner into the shown-once-unrecoverable-code
 * dead end this very ticket exists to remove. `SameSite=lax` is no defence,
 * because the attack needs no cookie SENT — the response of a top-level
 * cross-site POST is first-party for us, so our `Set-Cookie` sticks.
 *
 * `requireHost` closes it: a cross-site POST carries no Lax session cookie, so it
 * is a 401 that changes nothing. Only someone who already holds host authority
 * for this room can give it up.
 *
 * `isCrossSiteRequest` is a SECOND, independent refusal on the request's stated
 * provenance, and it is here deliberately rather than as belt-and-braces garnish:
 * the reason this blocker reached a gate at all is that the design leaned on one
 * unexamined mechanism. Authority-by-cookie and provenance are different
 * mechanisms with different failure modes, and the cross-site logout must fail on
 * both. It refuses nothing legitimate — the only caller is a same-origin `fetch`
 * from the admin page (`AdminRoom.handleLogout`), so the shared-venue-tablet
 * logout this feature depends on is untouched.
 *
 * NO ROOM-EXISTENCE ORACLE. Both refusals return the identical 401 body, and
 * `requireHost` is already false for an unknown room as well as a wrong session,
 * so a caller learns nothing about which venue slugs are real. Room ids are
 * public QR slugs anyway — the point is that this route adds no signal.
 *
 * REVOCATION IS SERVER-SIDE. Clearing `Room.claimTokenHashes` is what makes
 * logout mean something for a credential that may already have been copied off
 * the device — the previous design's opt-out lived in the victim's own cookie
 * jar, which locked the owner out while leaving a copied token working. Entering
 * the host code mints a fresh token (`POST /api/host/login`).
 */
export async function POST(req: NextRequest) {
  const roomId = roomIdFromRequest(req);
  if (roomId === null) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }
  // Two independent reasons to refuse, answered with the SAME response so the
  // route tells a caller nothing it did not already know — in particular nothing
  // about whether the room exists (`requireHost` is false both for a wrong
  // session and for a room with no record, and this branch is indistinguishable
  // from either). This is the B-S2 guard; do not weaken it to "best effort" and
  // do not differentiate these replies for friendlier errors.
  if (isCrossSiteRequest(req) || !(await requireHost(req, roomId))) {
    // Nothing to log out of, and nothing is changed — no cookie cleared, no
    // token revoked.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Server-side revocation first: if this fails we have not told the client it
  // is logged out, so a retry is safe.
  await revokeRoomClaimTokens(roomId);

  const res = NextResponse.json({ ok: true });
  // Path must match the set-path (HOST_COOKIE_PATH) or the browser won't clear it.
  res.cookies.set(hostCookieName(roomId), "", { path: HOST_COOKIE_PATH, maxAge: 0 });
  res.cookies.set(claimCookieName(roomId), "", { path: HOST_COOKIE_PATH, maxAge: 0 });
  return res;
}
