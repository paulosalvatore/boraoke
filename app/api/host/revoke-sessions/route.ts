import { NextRequest, NextResponse } from "next/server";
import {
  attachClaimCookie,
  claimTokenFrom,
  hostCookieName,
  hostCookieOptions,
  isCrossSiteRequest,
  chargeRevoke,
  claimStatus,
  requireHost,
  rollClaimCookie,
  roomIdFromRequest,
  sessionForRoom,
} from "@/lib/host-auth";
import { DEFAULT_ROOM, revokeRoomHostSessions } from "@/lib/rooms";

/**
 * POST /api/host/revoke-sessions?room=<id> — "sign out other devices"
 * (TICKET-118). Plain logout (`POST /api/host/session`) signs out only the
 * device it is tapped on (TICKET-112); this is the action that reaches the rest.
 * The venue's recovery lever: it ends EVERY outstanding host session for the
 * room, and every admin-claim credential except the owner's, while leaving the
 * acting (owner's) device signed in.
 *
 * WHY THIS ROUTE EXISTS. The TICKET-104 security re-gate measured, in real
 * browsers, that a host session already minted from a stolen credential survived
 * the owner's logout: it kept moderating (200) and kept rolling itself a fresh
 * 30-day cookie, indefinitely. Re-entering the host code did not help either,
 * because `sessionValue` was a deterministic HMAC over the immutable
 * `hostCodeHash`, so two separate logins returned the byte-identical session
 * value. There was no sequence of actions available to a venue owner that ended
 * an unauthorised session. This is that sequence, and it is one button.
 *
 * WHY IT IS NOT FOLDED INTO LOGOUT. Logout's ordinary meaning is "get me off
 * this shared tablet". Making it also kill the owner's own phone's live session
 * would regress the common path into the shown-once-unrecoverable-code dead end
 * TICKET-104 exists to remove. The lever a venue needs mid-service is a separate,
 * explicitly labelled, confirmed action — so it is one.
 *
 * SECURITY CONTRACT, with the mechanism named for each line rather than asserted
 * (the re-gate's standing criticism of this surface is that four confidently
 * worded comments here outran the code):
 *
 *  1. AUTHENTICATED, by the same two INDEPENDENT refusals as logout, for the
 *     same reason and with more at stake. `requireHost` means only a caller who
 *     already holds host authority for this room can use it; `isCrossSiteRequest`
 *     refuses a positively-foreign provenance so the property does not rest on
 *     `SameSite=Lax` alone. MECHANISM: both are evaluated below, before any
 *     write. An unauthenticated version of this route would be a remote,
 *     unauthenticated denial of service against a guessable public room slug —
 *     strictly worse than the B-S2 blocker, since it would end live sessions as
 *     well as claim credentials.
 *  1b. OWNER ONLY, AND THROTTLED (Cyber S3; TM house default, pending the Tech
 *     Lead's confirmation). Beyond a valid session, the request must present the
 *     room's OWNER-PINNED claim token (TICKET-120), checked inside
 *     `revokeRoomHostSessions` against the same pre-bump snapshot it acts on. A
 *     staff session, or a session copied off any device, gets a 403 and changes
 *     nothing, so a stolen session can no longer sign the owner out or loop this
 *     action to keep them out. The host code is deliberately NOT required: owners
 *     are the people who most often no longer have it (TICKET-104). Uses are
 *     capped per room (`chargeRevoke`, 3 per 10 minutes, charged atomically);
 *     refusals are never charged, so nobody else can spend the owner's budget.
 *  2. NO ROOM-EXISTENCE ORACLE. Both refusals return the byte-identical 401 body,
 *     and `requireHost` is already false for an unknown room as well as a wrong
 *     session, so the refusal branch is indistinguishable from either.
 *  3. THE ACTING DEVICE CANNOT BE LOCKED OUT BY ITS OWN SUCCESSFUL USE of this
 *     route — the property every predecessor mechanism on this surface got wrong.
 *     Two mechanisms, not one:
 *       (a) `revokeRoomHostSessions` KEEPS the owner's claim-token hash (the one
 *           this request presents), decided from the read taken BEFORE the bump
 *           and re-asserted on every rebind, so a concurrent login cannot make
 *           it "not found" (Cyber S2). The device's existing
 *           `boraoke_claim_<room>` cookie stays live and NOTHING has to reach the
 *           browser for it to retain access. If this response is lost after the
 *           write commits, the next admin mount auto-claims with that surviving
 *           token and gets a fresh session.
 *       (b) the replacement session cookie below is derived from the snapshot
 *           the revoke returned (the read that confirmed the new claim list),
 *           not from a later independent read.
 *     The owner pin is never removed by this action.
 *  4. NO WRITE WAS ADDED TO THE AUTHENTICATION PATH. The epoch is read in the
 *     same store round trip that `resolveRoomSecret` already made for
 *     `hostCodeHash` (one MGET of the record and its counter), so `requireHost` /
 *     `verifyClaim` / the rolling refresh are still pure reads. The only writes
 *     in this feature are on this route, which no returning device ever calls.
 *  5. NO FALSE SUCCESS, AND NO ROLLBACK. A 200 means the atomic epoch bump
 *     happened, and that alone is what ends the sessions. A concurrent login or
 *     settings write that read the room before it cannot lower the epoch or
 *     bring a pruned claim token back (TICKET-127 interleavings, probed in the
 *     regression suite). The earlier design reported a 200 here and could then
 *     have it silently undone by such a write.
 *
 * Responses: 200 `{ ok: true, epoch }` on success, with a refreshed session
 * cookie (and a rolled claim cookie, or a freshly minted OWNER one when every
 * rebind was clobbered); 400 on a malformed room id; 401 on either refusal,
 * undifferentiated; 403 `{ ownerOnly: true }` when the caller is signed in but
 * is not the owner's device; 429 `{ throttled: true }` once the room's budget is
 * spent; 404 when the room has no record (the legacy `default` room is governed by the
 * env `HOST_TOKEN` and has no per-room sessions to revoke).
 */
export async function POST(req: NextRequest) {
  const roomId = roomIdFromRequest(req);
  if (roomId === null) {
    return NextResponse.json({ error: "Invalid room id" }, { status: 400 });
  }

  // Contract lines 1 and 2: two independent reasons to refuse, answered with the
  // SAME response so the route tells a caller nothing it did not already know.
  // Do not weaken either, and do not differentiate these replies for friendlier
  // errors — that is what turned the pre-TICKET-104 logout into a blocker.
  if (isCrossSiteRequest(req) || !(await requireHost(req, roomId))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // The legacy `default` room has no record, so no per-room sessions to revoke.
  if (roomId === DEFAULT_ROOM) {
    return NextResponse.json({ error: "No revocable sessions for this room" }, { status: 404 });
  }

  // Contract line 1b, the clear refusal for a staff (or copied) session. Not an
  // oracle: the caller already proved host authority for this room above. Checked
  // here so a refused caller is never charged to the throttle below; the revoke
  // re-checks it against the snapshot it acts on, which is the authoritative check.
  const presentedClaimToken = claimTokenFrom(req, roomId);
  if (!(await claimStatus(req, roomId)).owner) return ownerOnly();

  // Per-room budget, charged atomically before acting (see `chargeRevoke`).
  if (!(await chargeRevoke(roomId))) {
    return NextResponse.json({ error: "Too many sign-outs, try again later", throttled: true }, { status: 429 });
  }

  // Contract line 3a: the owner's claim token is the one hash the revoke keeps.
  const result = await revokeRoomHostSessions(roomId, { presentedClaimToken });
  if (!result.ok) {
    if (result.reason === "not-owner") return ownerOnly();
    return NextResponse.json({ error: "No revocable sessions for this room" }, { status: 404 });
  }

  // Contract line 3b: derived from the snapshot the revoke returned.
  const session = sessionForRoom(result.room);
  if (!session) {
    // Host controls locked for this room. The revocation DID land, so this is not
    // a failure of the operation the owner asked for — but we cannot keep them
    // signed in, and saying otherwise would be the false-success this route's
    // contract forbids.
    return NextResponse.json({ ok: true, epoch: result.epoch, signedOut: true });
  }

  const res = NextResponse.json({ ok: true, epoch: result.epoch });
  res.cookies.set(hostCookieName(roomId), session, hostCookieOptions());

  if (result.keptClaimToken) {
    // The owner's existing claim credential survived, so extend its window the
    // same way every other success path does — re-sending the value it already
    // holds, never minting (see `rollClaimCookie`).
    rollClaimCookie(res, req, roomId);
  } else {
    // Every rebind was clobbered by concurrent stale writes, so no claim token is
    // live. Mint the owner a fresh one, pinned as the owner's, so this action
    // never costs the room its owner pin. Best-effort by design: the session
    // cookie above is what keeps this device in, and it is already set.
    await attachClaimCookie(res, roomId, { owner: true });
  }

  return res;
}

/** 403 for a signed-in device that is not the room owner's (contract line 1b). */
function ownerOnly(): NextResponse {
  return NextResponse.json(
    { error: "Only the room owner's device can sign out other devices", ownerOnly: true },
    { status: 403 },
  );
}
