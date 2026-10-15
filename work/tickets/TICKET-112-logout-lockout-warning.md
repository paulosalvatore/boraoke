# TICKET-112 — Host logout is now a permanent self-inflicted lockout, and nothing warns the creator

**Filed:** 2026-09-27, from the opus review of PR #81 (TICKET-104), finding NB-5.
**Priority:** MEDIUM — no data loss, but it is the most likely way a real user reaches the dead end TICKET-104 was filed to remove.
**Type:** UX / copy (product decision required)
**Size:** S

## What is now true

TICKET-104 made host logout genuinely end a session — it had to, because auto-claim would otherwise have silently re-authenticated the creator on the next page load and defeated the shared-venue-tablet control entirely. Logout therefore sets a no-claim marker that suppresses auto-claim **for three years**, cleared only by entering the host code.

The host code is shown exactly once at `/new` and is unrecoverable (only its hash is stored). So for a creator who did not write it down, logout is now a **permanent lockout from their own room** — and the confirm step that does it (`app/(patron)/[room]/admin/AdminRoom.tsx`, the `admin-logout-confirm` group) is a bare **`Confirmar` / `Cancelar`** with no copy saying what is about to happen.

The security control is correct and must stay. What is missing is that the user is told.

## Why this is a Tech-Lead call, not a dev decision

The fix is product copy, and the right wording depends on how the TL wants to frame the trade-off to a venue owner — a warning that is too scary discourages a control people should use on a shared tablet, and one that is too soft does not prevent the lockout. Candidate directions, none chosen:

1. **Warn in the confirm step** — e.g. "you'll need the host code to get back in". Smallest change; keeps one flow.
2. **Ask for the code to log out**, turning the lockout into an informed act. Safest, most friction, and arguably wrong for the tablet case (the person handing the tablet back may not have the code).
3. **Surface the state afterwards** in `SavedRooms` via the existing unused-for-this `claimable` flag, so a logged-out room is visibly "needs the code" rather than silently so.
4. Some combination — (1) now, (3) later.

## Acceptance (once a direction is chosen)

- A creator cannot reach the permanent-lockout state without having been told, in their own language, that the host code is the only way back.
- Whatever copy lands exists in all three catalogs (`messages/{pt-BR,en,es}.json`) — the i18n completeness gate enforces this.
- The security property is unchanged: logout still suppresses auto-claim until the code is entered. No weakening of the marker.

## References

- Review: `work/reports/reviewer/TICKET-104-review.md`, NB-5.
- Mechanism: `lib/host-auth.ts` (`hostNoClaimCookieName`, `NO_CLAIM_MAX_AGE_SECONDS`), `app/api/host/session/route.ts` (sets it), `app/api/host/login/route.ts` (clears it).

## Addendum 2026-10-14 — a STAFF logout locks the OWNER out too (PR #91 opus review)

Found by the Reviewer on PR #91 (TICKET-120). It is pre-existing and not caused by #91, but it widens this ticket's scope.

- `revokeRoomClaimTokens` (logout) clears **every** device's claim token, plus, since #91, the owner pin (`ownerClaimTokenHash`). So when **any** staff member taps logout at the end of a shift, the creator's phone also loses its no-typing re-entry. The owner is back on the shown-once host code they may not have: the dead end TICKET-104 removed, reached by an ordinary venue act and not by the owner's own choice. It is arguably the fourth instance of the auth-path-lockout class in MANAGER-LOG.
- It is invisible to the owner, who finds out only the next time they need admin. Any copy fix here would warn the person tapping logout, who is not the person who loses access.
- After #91 there is a second consequence: once any logout has run, the room's owner pin is gone for good. #91 deliberately never re-pins on a later login, because that would need the client-readable `creatorUuid`. So the owner becomes an ordinary, evictable slot for the rest of the room's life.

**Recommendation.** Handle it in TICKET-118 rather than with copy alone. 118's revoke already prunes everything except the **acting** device's token, and when the owner is the one acting, 118's spread of `...room` keeps the pin valid. Applying the same "keep, don't clear" idea to ordinary logout fixes most of this: a logout ends the acting device's own credential (and session), and wiping every device becomes an explicit "sign out all devices" (118's lever), not the default. If logout must keep revoking everything, this ticket's copy has to warn that it also signs the owner out. Either way the decision belongs to the TL, together with this ticket's existing copy question. Sequence it with TICKET-127: the whole-record write race can resurrect or lose these hashes.
