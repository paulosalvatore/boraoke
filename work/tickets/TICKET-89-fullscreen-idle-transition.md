# TICKET-89 — Fullscreen drops out on the idle transition (TICKET-82 follow-up N4)

**Filed:** 2026-08-19, interactive TM session (TL present)
**Priority:** LOW-MED
**Size:** S
**Type:** UX follow-up

## Why this exists

TICKET-82 (PR #61, merged) fixed the TV fullscreen black-screen defect: the player host used to
live inside the `nowPlaying ? … : idle` branch, so an empty-then-refilled queue unmounted the
iframe and left a dead player behind. The fix mounts the main row for the component's whole life
and hides it with `display: none` while idle, keeping the player node alive across the gap.

**One accepted-but-not-ideal side effect of that fix, recorded as follow-up N4 in TICKET-82's own
review:** when the queue empties and the view transitions to idle, a player that was in
**fullscreen** now drops out of fullscreen, because the browser exits fullscreen automatically
when the fullscreened element (the main row) gets `display: none`.

This is **strictly better than the pre-fix behavior** — a dead black embed the venue had to
manually refresh — so it was accepted as-is rather than blocking the fix. But it is a real,
user-visible regression from what a venue might expect: a TV that's been put into fullscreen for
the night now silently drops out of fullscreen every time there's a gap between singers, and
whoever is running the venue's screen would need to notice and re-trigger fullscreen by hand.

## What's needed

A venue may want fullscreen to **survive** a gap between singers rather than exit and require a
manual reset each time. Options to weigh (not yet decided — this ticket is scoping, not
prescribing):

- Keep the main row's fullscreen container mounted and only hide/show an inner content layer
  (idle placeholder vs. now-playing content) instead of toggling `display: none` on the
  fullscreen-participating element itself.
- Detect the fullscreen-exit-on-idle case and proactively re-request fullscreen once a new video
  loads (re-entering fullscreen programmatically outside a user gesture is blocked by most
  browsers, so this may not be viable — verify before committing to this approach).
- Accept the current behavior as a known limitation and instead make the idle state visually
  louder/clearer so a host notices and re-fullscreens quickly, rather than trying to preserve
  fullscreen across the gap at all.

## Acceptance criteria

Not yet defined — needs a TL call on which of the above (or another approach) is worth the
complexity, given this is a real but bounded UX rough edge, not a correctness bug. File the actual
implementation ticket once a direction is chosen.
