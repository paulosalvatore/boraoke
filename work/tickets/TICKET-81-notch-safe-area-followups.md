# TICKET-81 — Notch/safe-area layout follow-ups under `viewportFit: cover` (TICKET-73/74 follow-up)

**Filed:** 2026-08-08, interactive TM session (TL present)
**Priority:** LOW-MED
**Size:** S per finding

## Why this exists

TICKET-74 (PR #55, merged) added `viewportFit: "cover"` to `app/metadata.ts`, which is a
prerequisite for `env(safe-area-inset-*)` to resolve to real device values instead of `0` — but
turning it on also **exposes** existing layout that was never designed against a nonzero inset.
Two concrete regressions were found this session:

1. **`/[room]` language pill sits inside the notch band.** The language-switcher pill on patron
   room pages sits at roughly y 32→67; on a 47px notch inset, ~15px of its top edge falls inside
   the notch itself. Needs `padding-top: env(safe-area-inset-top)` (or equivalent) on
   `app/(patron)/[room]/**` or `app/globals.css`.
2. **Landing `<header>` overflows at narrow widths.** The landing page header overflows by roughly
   13–16px at a 320px viewport width — independent of the notch issue but found in the same pass,
   worth fixing alongside it since both are "notch/narrow-viewport layout debt."

## Record plainly: TICKET-73's real-device acceptance criterion was never met

TICKET-73 (folded into TICKET-74's PR) required confirming `env(safe-area-inset-*)` resolves to a
non-zero value on an actual notched device once `viewportFit: cover` shipped — specifically because
a CDP-based check cannot prove the difference between "wired but inert" and "wired and active."
That prediction held: **Chromium's `Emulation.setSafeAreaInsetsOverride` forces the same inset
values whether or not `viewport-fit=cover` is present** (measured both on pre-TICKET-74 production,
which lacked the property, and on the TICKET-74 branch — both returned 47px/34px). CDP simply
cannot discriminate the two states. **A real notched iPhone is required** to actually close
TICKET-73's acceptance criterion; it has not yet been done.

## Acceptance criteria

- Language pill on `/[room]` no longer sits inside the safe-area-inset-top band on a notched
  viewport (verified via CDP override *and*, per the note above, flagged as still needing a real
  device to fully confirm).
- Landing `<header>` no longer overflows at 320px width.
- Explicitly record whether a real notched device was used to verify — do not let a CDP-only pass
  silently stand in for the real-device confirmation TICKET-73 already flagged as unmet.

## Not in scope

Any other viewport/safe-area surface not named above; a broader safe-area audit is a separate,
larger piece of work if the TL wants one.
