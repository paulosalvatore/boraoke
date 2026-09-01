# TICKET-97 — a rate-limited advance is swallowed, turning the TV into a retry loop

**Filed:** 2026-09-01, from the TICKET-96 opus reviewer (FU-1). Pre-existing — NOT introduced by TICKET-96.
**Priority:** MEDIUM
**Size:** S-M
**Type:** Client correctness / failure-path handling

## Why this exists

`components/tv/TvScreen.tsx:387-405` inspects exactly one advance-response status: `401`, which
triggers the TICKET-46 self-heal reload. Every other non-OK status falls straight through to the
queue re-fetch, and the function returns the **unchanged** queue head as if the advance had
succeeded.

A `429` from the per-room advance rate limiter is therefore invisible to the client, with three
distinct consequences depending on which caller hit it:

1. **The Skip button becomes a silent no-op.** The host presses skip, nothing happens, and there is
   no feedback of any kind — not an error, not a disabled state. They press it again.
2. **The ENDED auto-advance replays the song that just finished.** The head never moved, so the
   player is handed the same videoId back.
3. **The unplayable path becomes a tight retry loop.** `skipUnplayable` reloads the same broken
   video, which fires `onError` again, which advances again, which 429s again — hammering
   `/api/queue/advance` until the 60s window clears.

(3) is the one that matters: the client generates load against precisely the endpoint that is
already telling it to slow down.

## This is reachable today, on the ordinary path

This is not an exotic state. The Skip button (`components/tv/TvScreen.tsx:1017`) and the ENDED
auto-advance (`:566-568`) both charge the **12/60s** singer-skip bucket, so a host clearing a run of
no-shows can reach it during a normal night. TICKET-96 (the 40/60s total bucket) neither introduced
nor materially widened this — it was found while reviewing that change.

## Acceptance criteria

- A `429` on advance is handled distinctly from both success and `401`. At minimum it must NOT
  return the unchanged head as though the advance succeeded.
- The unplayable path must not retry immediately into the same rate-limited endpoint. Back off
  until the window plausibly clears (the limiter's window is 60s; the response should carry or imply
  the wait rather than the client guessing).
- The host gets **some** honest feedback on a rate-limited skip instead of a dead button — the
  TICKET-72/UX baseline expectation that an action either works or says why it did not.
- Tests: a route-level or component test asserting that a 429 does not advance the head, does not
  replay the finished song, and does not immediately re-issue the advance.

## Worth deciding while here

Whether the advance route should return `Retry-After` so the client can back off on a real number
instead of a hardcoded guess. Cheap to add and it makes the client's behaviour derivable from the
server's actual window rather than a duplicated constant.
