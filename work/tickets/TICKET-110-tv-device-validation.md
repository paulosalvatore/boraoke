# TICKET-110 — Validate the TV focus state on real LG webOS hardware

**Filed:** 2026-09-27, as the explicit device-validation follow-up to TICKET-103 (filed rather than left implied).
**Priority:** MED — nothing is known to be broken; this closes the gap between "proven in a browser" and "proven on the device the product is for".
**Type:** Device validation
**Size:** S (one session with the TV)
**Blocked on:** Tech-Lead access to the television. Not startable without it.

## Why this exists separately

TICKET-103's focus state is proven in a desktop browser at TV geometry, which is where the Tech Lead is testing and where he says it looks good. **It is not proven on a television**, and two specific things cannot be proven headless:

1. **Whether a webOS remote can wake the focus state.** At high video bleed, pointer events land inside the cross-origin YouTube iframe and never reach our handlers. TICKET-103 added `keydown` and window `blur` as additional wake signals for exactly this reason, but a **pointer moving only inside the focused iframe still wakes nothing** — and a magic remote is a pointer device. If that is the venue's real interaction, the chrome could be unreachable on the actual hardware while working perfectly in every browser test.
2. **Whether the QR and queue overlays survive whatever the TV itself does** — screensaver/rest mode, power-saving dimming, or any webOS-level compositing. The Tech Lead originally attributed his black screen to TV rest mode; that turned out to be YouTube-native fullscreen instead, so rest mode remains **untested rather than ruled out**.

## Still unknown and still load-bearing

**The TL's LG model and webOS version.** Rest-mode behaviour is model-specific, and the same fact also decides the open question on PR #80 (whether the `globalThis` shim is worth shipping to every user to support webOS 4.5/5.0). One answer serves both.

## What to check, on the device

- Can the chrome be brought back using only the remote, from the focus state, with a song playing?
- Is the QR legible and **scannable with a real phone** from typical venue distance — the end-to-end thing no screenshot can confirm?
- Does the queue overlay appear, look intentional, and disappear, without the QR shifting?
- What happens across the TV's own rest/screensaver transition, and on return from it?
- Record the model and webOS version while there.

## Acceptance

A short report stating what was observed on the real hardware, with any defect filed as its own ticket. A finding here is a normal outcome, not a failure of TICKET-103 — the point is that this class of behaviour is only knowable on the device.
