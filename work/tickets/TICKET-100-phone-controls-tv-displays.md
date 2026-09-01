# TICKET-100 — control model: the phone creates and controls the room, the TV is a display

**Filed:** 2026-09-01, TL direction from the real test of 2026-08-27 (`work/status/TL-REAL-TEST-2026-08-27.md`)
**Priority:** HIGH (design; sequenced behind TICKET-98's reproduction)
**Type:** Product direction / architecture

## The direction

Set by the Tech Lead after his LG TV test. The reason is the remote control: **typing a full URL on
a TV remote is painful**, so the TV must never be where you operate the product.

- **The phone creates the room.** The phone is the controlling device.
- **The TV is a basic display** — a songs-only view: what is playing, what is next. Nothing that
  requires text entry or precise pointing.
- **QR is the patron entry path.** This makes the broken QR code (TICKET-98, symptom 2) load-bearing
  rather than cosmetic: it is the *only* comfortable way into a room.
- **A skip pressed ON the TV notifies the controlling phone** instead of requiring TV-side
  authentication. Authenticating on a television is worse UX than delegating the decision to the
  phone already in someone's hand.

## What this changes about work already done

**`ADVANCE_AUTH=enforce` is deferred because of this ticket, not because the case for it weakened.**
The evidence gathered on 2026-09-01 stands: the advance endpoint is effectively anonymous in
production, and the full e2e suite already runs under `enforce` and is green. But if a TV-side skip
is meant to *notify the phone* rather than *authenticate on the TV*, then the definition of "an
authorized advance" is about to change. Flipping enforce now would harden a model that is being
redesigned. Revisit once this control model is settled.

TICKET-96's rate limiting is unaffected — it is per-room and reason-based, orthogonal to who is
authorized.

## Open design questions (for the TL, once TICKET-98 is reproduced)

1. **What is the TV's identity** if it no longer authenticates? Today the TV holds a screen token
   minted by the room's server-only secret. If the TV becomes a dumb display, does it still need
   one — is the pairing still a credential, or just a room association?
2. **How does the phone learn about a TV-side skip** — a poll on the existing host surface, or a
   push? What does the phone show: an approval prompt, or a notification of something already done?
3. **Is a TV-side skip a request or an action?** "Notify" is ambiguous, and the answer changes the
   security model. If the phone must approve, the TV needs no authority at all; if it is an action
   that merely informs, the TV still needs to be trusted.
4. **How does the TV get to its room without URL entry** — is pairing itself a QR scan, a short
   code typed with the remote's number keys, or something else?

These are genuine product forks, not implementation details. They should reach the TL as concrete
options once we know what actually broke on the TV, since the reproduction may constrain the answers.

## Acceptance criteria

- A written design covering the four questions above, with the TL's decisions recorded.
- The TV view is reachable and usable without text entry on a remote.
- No path in the product requires typing a URL on a television.
