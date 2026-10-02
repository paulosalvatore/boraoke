import { NextRequest, NextResponse } from "next/server";
import {
  attachClaimCookie,
  claimTokenFrom,
  hostCookieName,
  hostCookieOptions,
  isCrossSiteRequest,
  issueSession,
  requireHost,
  rollClaimCookie,
  roomIdFromRequest,
  verifyClaim,
} from "@/lib/host-auth";
import { revokeRoomHostSessions } from "@/lib/rooms";

/**
 * POST /api/host/revoke-sessions?room=<id> — "sign out all other devices"
 * (TICKET-118). The venue's recovery lever: it ends EVERY outstanding host
 * session for the room, and every admin-claim credential except the acting
 * device's, while leaving the acting device signed in.
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
 *  2. NO ROOM-EXISTENCE ORACLE. Both refusals return the byte-identical 401 body,
 *     and `requireHost` is already false for an unknown room as well as a wrong
 *     session, so the refusal branch is indistinguishable from either.
 *  3. THE ACTING DEVICE CANNOT BE LOCKED OUT BY ITS OWN SUCCESSFUL USE of this
 *     route — the property every predecessor mechanism on this surface got wrong.
 *     Two mechanisms, not one:
 *       (a) `revokeRoomHostSessions` KEEPS the claim-token hash this request
 *           presents (pruning only the others), so the device's existing
 *           `boraoke_claim_<room>` cookie stays live and NOTHING has to reach the
 *           browser for it to retain access. If this response is lost to a
 *           network drop after the write commits, the next admin mount
 *           auto-claims with that surviving token and gets a fresh session.
 *       (b) the replacement session cookie below is derived by `issueSession`
 *           AFTER the write returns, so it is computed from the epoch that is
 *           ACTUALLY STORED. There is no path on which this route hands the
 *           caller a cookie that will not verify — including when a concurrent
 *           whole-record write clobbered the bump.
 *  4. NO WRITE WAS ADDED TO THE AUTHENTICATION PATH. The epoch is read out of the
 *     same `getRoom` that `resolveRoomSecret` already performed for
 *     `hostCodeHash`, so `requireHost` / `verifyClaim` / the rolling refresh are
 *     still pure reads. The only write in this feature is the one below, on a
 *     route no returning device ever calls.
 *  5. A CONTENDED WRITE IS REPORTED AS A FAILURE, not swallowed. If every attempt
 *     to advance the epoch was clobbered by a concurrent record write, the room's
 *     sessions are still live and the caller is told so (503, retryable) — a
 *     venue owner must never be told an unauthorised session was ended when it
 *     was not.
 *
 * Responses: 200 `{ ok: true, epoch }` on success, with a refreshed session
 * cookie (and a rolled claim cookie, or a freshly minted one when the caller held
 * none); 400 on a malformed room id; 401 on either refusal, undifferentiated;
 * 404 when the room has no record (the legacy `default` room is governed by the
 * env `HOST_TOKEN` and has no per-room sessions to revoke); 503 on contention.
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

  // Passed to the revoke so the acting device's OWN credential survives
  // (contract line 3a). It is only ever kept if it is genuinely live in the
  // record — the presented value is not trusted into the record on its own say-so.
  const presentedClaimToken = claimTokenFrom(req, roomId);

  const result = await revokeRoomHostSessions(roomId, { presentedClaimToken });
  if (!result.ok) {
    if (result.reason === "no-room") {
      return NextResponse.json({ error: "No revocable sessions for this room" }, { status: 404 });
    }
    // Contract line 5 — still live, so say so rather than reporting success.
    return NextResponse.json(
      { error: "Could not sign out the other devices — please try again." },
      { status: 503 },
    );
  }

  // Contract line 3b: derived AFTER the write, from the stored epoch, so the
  // caller can never be handed a cookie that does not verify.
  const session = await issueSession(roomId);
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
    // The device's existing claim credential survived the prune, so extend its
    // window the same way every other success path does — re-sending the value
    // it already holds, never minting (see `rollClaimCookie` for why minting
    // here was wrong twice over).
    rollClaimCookie(res, req, roomId);
  } else if (!(await verifyClaim(req, roomId))) {
    // The caller held no live claim token (a device that logged in with the code
    // while its mint failed, or a room predating TICKET-104). Mint one so it gains
    // the no-typing path. Best-effort by design: an un-issued claim token costs
    // the no-typing path, never the room — the session cookie above is what keeps
    // this device in, and it is already set.
    await attachClaimCookie(res, roomId);
  }

  return res;
}
