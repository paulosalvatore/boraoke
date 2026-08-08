# TICKET-73 — `viewportFit: "cover"` missing from `app/metadata.ts` (from TICKET-71 F2)

**Status:** IN REVIEW — shipped inside TICKET-74's PR (same one-property change to the same `app/metadata.ts` viewport export). See `work/reports/dev/TICKET-74-dev-report.md`.

> **Acceptance caveat — the third criterion below is NOT met by that PR, deliberately.** `viewportFit: "cover"` is added and verified present in the rendered `<meta name="viewport">` in all three locales, and the TICKET-71 safe-area regression test still passes. But the real-device confirmation could not be obtained, and the method this ticket suggests does not work: Chromium's `Emulation.setSafeAreaInsetsOverride` forces `env(safe-area-inset-*)` to resolve to non-zero **with or without** `viewport-fit=cover` (measured on live production, which lacks the property, and on the branch — both 47px/34px). CDP cannot discriminate "wired but inert" from "wired and active", which is precisely the gap this ticket named. A real notched iPhone is required.
>
> **Also found:** under `cover`, the language-switcher pill on patron room pages (`/[room]`) sits at y 32→67, so ~15px of its top edge falls inside a 47px notch band. Fixing it needs `padding-top: env(safe-area-inset-top)` in `app/(patron)/[room]/**` or `app/globals.css` — outside TICKET-74's file boundary, filed as a follow-up.
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
