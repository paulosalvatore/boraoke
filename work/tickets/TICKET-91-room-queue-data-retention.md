# TICKET-91 — Room/queue data has no retention bound

**Filed:** 2026-08-19, interactive TM session (TL present, session paused for usage limits)
**Priority:** MED
**Size:** S–M (depends on the retention window chosen)
**Type:** Data-retention / compliance — needs a Tech-Lead decision

## Why this exists

Room and queue keys — including patron-supplied nicknames and stored YouTube video titles —
are written with **no TTL at all**. Verified directly in `lib/rooms.ts`: every write path
(`this.redis.set(roomKey(room.id), room)`, `this.rooms.set(room.id, room)`) sets the value with
no expiry option, and nothing else in the module ever deletes a room or queue entry. Rooms and
their queues persist forever unless a host manually clears them.

This is not a new introduction — it is a pre-existing gap, surfaced this session while
correcting `work/youtube-quota-form.md` (TICKET-90) for filing, because the form has to state
this honestly to a Google compliance reviewer. It was previously mis-described in that form as
"ephemeral, 90-day max retention" — that 90-day figure actually belongs to a different system
entirely (`TELEMETRY_RETENTION_DAYS = 90` in `lib/telemetry-types.ts`, anonymous product
analytics), not to room/queue data. TICKET-90 corrected the form to disclose the true state
plainly rather than repeat the false claim; this ticket is the follow-up to actually decide
and, if wanted, ship the bound.

## Two distinct concerns

1. **YouTube Developer Policies §III.E.4.** The policy caps storage of API-derived metadata
   (search results, titles, etc.) at 30 calendar days. The queue's stored song `title` is
   API-derived display metadata (`videos.list`/`search.list` responses), so an unbounded-retention
   room is, in principle, out of policy for that field specifically — independent of whether the
   room itself is ever revisited.
2. **LGPD.** Boraoke is a Brazilian product that stores patron-supplied nicknames (and optionally
   a table number) tied to a room. Under LGPD, retaining personal data indefinitely with no
   articulated purpose or bound is a decision that needs to be made deliberately, not left as an
   accident of "nothing ever calls delete."

## What's already true, so this isn't starting from zero

- Patron identity is already minimal: a random UUID plus a self-chosen nickname, no account, no
  OAuth, no Google/YouTube account data touched (`work/youtube-quota-form.md` §3).
- Telemetry already has a working, precedented pattern to copy: `TELEMETRY_RETENTION_DAYS = 90`
  in `lib/telemetry-types.ts` is an existing, shipped hard-expiry bound on a sibling data store.
  Room/queue data has never had the equivalent.
- `work/youtube-quota-form.md` §3 and §6 already carry an honest disclosure of the gap and a
  parked pre-filing checklist item ("Decide whether to add a retention bound to room/queue data
  **before** filing") — this ticket is that decision, not a new discovery layered on top of it.

## The reviewer's framing on TICKET-90, worth carrying over verbatim

From the TICKET-90 gate report (`work/reports/review/TICKET-90-review.md`): if the Tech Lead
would rather give a clean answer on the quota form, "the sequencing is 'ship the bound, then
file', not 'soften the sentence'. Nothing in this document should be weakened to make that
answer read better." The document's accuracy is not at stake either way — it already discloses
the gap plainly — but a shipped bound is the only way to change the *substance* of the answer,
not just its wording.

## What needs a Tech-Lead decision

- What the retention window should be for room/queue data (30 days to track the YouTube policy
  ceiling on stored titles is one natural default; a room-idle-based expiry is another; they are
  not mutually exclusive).
- Whether expiry is TTL-based (Redis `EX`/`PEXPIRE` on the room key, mirroring the telemetry
  pattern) or an explicit sweep/cron, and whether an active room's TTL should refresh on
  activity or be fixed from creation.
- Whether this blocks filing `work/youtube-quota-form.md` (TICKET-90's corrected form already
  discloses the gap honestly, so filing is not blocked on this technically — but the TL may
  prefer to close this first so the filed answer is a clean "yes, bounded" rather than an
  honest "no, and here's why that's still fine").

## Not yet scoped

No implementation plan has been written — this ticket exists to get the retention-window
decision from the Tech Lead first. Once decided, the fix itself is a small, well-precedented
change (Redis TTL on the room key, following the `TELEMETRY_RETENTION_DAYS` pattern already
shipped elsewhere in this codebase).

## Pre-condition note

This is a pre-condition the Tech Lead may want resolved before `work/youtube-quota-form.md`
(TICKET-90) is actually filed with Google — see that form's §6 pre-filing checklist, which
parks exactly this question.
