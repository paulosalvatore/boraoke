# TICKET-73 — `viewportFit: "cover"` missing from `app/metadata.ts` (from TICKET-71 F2)

**Status:** OPEN — filed, not yet scheduled
**Filed:** 2026-08-08, interactive TM session (TL present)
**Priority:** LOW-MED
**Size:** S
**Type:** Metadata/CSS-environment config gap. Source: TICKET-71's second Reviewer pass, finding
F2, deferred there as outside that ticket's file boundary.

## Why this exists

TICKET-71 (PR #51, merged as `de9e98c`) added a safe-area-only spacer to the mobile feedback pill
(`env(safe-area-inset-bottom, 0px)`), to keep the now-in-flow pill clear of an iPhone's
home-indicator. The regression test proves the CSS is wired correctly by simulating the inset via
a CDP override (`Emulation.setSafeAreaInsetsOverride`) — it does **not** prove the inset is active
in production today.

`app/metadata.ts` does not currently set `viewportFit: "cover"` in its viewport config. Without
that, `env(safe-area-inset-*)` resolves to `0` in the browser regardless of device notch/home
indicator — so on a real notched or home-indicator iPhone in production, the safe-area handling
TICKET-71 built is present in the CSS but inert at runtime.

This was flagged and deliberately not fixed inside TICKET-71 because `app/metadata.ts` is mounted
globally and shared by every page — outside that ticket's file boundary (`components/FeedbackWidget.tsx`,
`components/feedback/FeedbackWidget.module.css`, two testids on `PatronRoom.tsx`).

## The fix

Add `viewportFit: "cover"` to the viewport export in `app/metadata.ts`. This is the standard
Next.js way to opt into `env(safe-area-inset-*)` resolving to real device values instead of `0`.

## Acceptance criteria

- `app/metadata.ts`'s viewport config includes `viewportFit: "cover"`.
- The existing TICKET-71 safe-area regression test (`e2e/feedback-widget-safe-area.spec.ts`) still
  passes.
- Manually or via a real-device/CDP check, confirm `env(safe-area-inset-bottom)` resolves to a
  non-zero value on a notched/home-indicator viewport once this ships (the CDP-override test alone
  cannot distinguish "wired but inert" from "wired and active" — that gap is exactly why this
  ticket exists).

## Not in scope

Any other viewport/metadata change. This is narrowly the one missing property.
