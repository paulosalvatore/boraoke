# Tech Lead's real test — Thursday night, 2026-08-27, on an LG TV

**Captured:** 2026-09-01, relayed via the Global TM. **This is the only record that exists.**

## Why this file exists at all

The Tech Lead tested boraoke for real on a Thursday night on his own LG TV, and gave the feedback
verbally. For five days it lived **only in his head** — no ticket, no note, no board entry, nothing
on disk. It was flagged as the single highest-decay item in this product on 2026-09-01 precisely
because a cold TM could not reconstruct it from any durable source, and it would have been lost
outright.

It is written down here first, before any diagnosis or fix, so that it can never be lost again.
The tickets below derive from this file; this file is the source.

## What happened, in his words as relayed

He tried to run a live demo on his LG TV. It failed **entirely**, and he had to fall back to
screen-sharing his phone.

Three distinct failures, on the actual target device:

1. **The site did not load in the TV browser.**
2. **The QR code did not show.** QR is the intended way a patron joins a room — so even had the
   page loaded, the entry path was gone.
3. **It errored every time it tried to load a song.**

## Why this outranks everything else in this product

boraoke's whole premise is a screen in a venue that patrons queue songs onto from their phones.
**The TV is the product.** A karaoke app that does not run on a television is not a partially-working
app; it is not the app.

## The part that should have caught it and did not

The e2e suite is 106/106 green and was green through all five merges of 2026-09-01. It runs
**desktop Chromium under Playwright**. The target device is an **LG webOS TV browser** — an older,
more limited engine with constrained JS. Every test we have proves the product works on a browser
nobody watches karaoke on.

This is not a gap in test *coverage* (which routes are exercised); it is a gap in test
*environment* (which engine executes them). No amount of additional Playwright specs on Chromium
would have found this, which is why the fix is machinery, not more tests.

## Directions the TL gave alongside the failure

**The control model should change, and the remote is the reason.** Typing a full URL on a TV remote
is painful, so the TV must not require it. The intended shape:

- **The phone creates the room.** The phone is the controlling device.
- **The TV is a basic display** — a songs-only view. It shows what is playing and what is next; it
  is not where you operate the product.
- **QR is the entry path** for patrons joining — which makes the broken QR code (failure 2 above)
  load-bearing, not cosmetic.
- **A skip pressed ON the TV should notify the controlling device** (the phone that created the
  room) rather than requiring TV-side authentication. Bad remote UX is the reason: authenticating
  on a TV is worse than delegating the decision to the phone already in someone's hand.

## Consequence for work already in flight

**`ADVANCE_AUTH=enforce` is DEFERRED — do not flip it.** It was queued as a TL decision on
2026-09-01 with strong supporting evidence, but it is entangled with this control model: if a
TV-side skip is meant to notify the phone rather than authenticate on the TV, then what "an
authorized advance" means is about to change. Flipping enforce now would harden a model that is
being redesigned. This deferral is deliberate and is not a reversal of the evidence — the evidence
stands; the sequencing changed.

## Derived work

- **TICKET-98** — the product does not work in a real TV browser (CRITICAL; reproduce → root-cause → fix).
- **TICKET-99** — TV-browser test machinery, so desktop-Chromium green stops being mistaken for working.
- **TICKET-100** — the phone-creates-room / TV-as-display control model, including TV-skip-notifies-phone.
