# TICKET-66 — Two WCAG AA contrast failures on the live `--accent` token (needs a TL brand call)

**Status:** OPEN — needs a TL decision (brand-color change)
**Filed:** 2026-08-06, interactive TM session (TL present)
**Priority:** HIGH-ish for accessibility, but blocked on a design call — not auto-actionable
**Type:** Accessibility / design token. Zero product code changes yet — this ticket is the fix for
findings TICKET-60 deliberately left unfixed.

## Why this exists

TICKET-60 (PR #44, merged) added `e2e/contrast.spec.ts`, a real WCAG AA contrast-ratio suite. Its
brief explicitly forbade loosening tokens to make tests pass — any genuine failure on current
`main` was to be recorded as `test.fixme` with inline evidence and left for a follow-up ticket.
Two genuine AA misses were found. This ticket is that follow-up.

Evidence: `work/reports/dev/TICKET-60-dev-report.md` and the two `test.fixme` blocks in
`e2e/contrast.spec.ts` (~line 298 and ~line 417).

## The two failures

1. **`.btn-primary`: white `#fff` on `--accent` `#e63946` → 4.17:1, needs 4.5:1.** This exact
   token pair is used on **every primary CTA in the app** — the landing-page create-room CTA, the
   patron join-queue button, and the submit-song button. `e2e/contrast.spec.ts` ~line 298
   (`test.fixme(... "create-room CTA button text meets AA — FAILS on current main..."`).
2. **Admin active mode-switcher label: `color: var(--accent)` (`rgb(230,57,70)`) on
   `rgba(230,57,70,0.09)` composited onto `var(--bg)` (`#0d0d0d`) → resolved `rgb(230,57,70)` on
   `rgb(33,17,18)` = 4.37:1, needs 4.5:1.** 16px, weight 800 — still short of the large-text bar
   (needs ≥18.66px bold). `e2e/contrast.spec.ts` ~line 417 (`test.fixme(... "active mode-switcher
   label meets AA..."`).

Both are genuine, reproducible AA misses on the CURRENT `--accent` token used as foreground text —
re-derived independently, not just inherited from the TICKET-60 dev report.

## Why this needs the TL, not a dev fire

Fixing either finding means changing how `--accent` (`#e63946`, boraoke's brand red) is used as a
foreground color — either darkening the accent-on-accent-tint pairing, bumping `.btn-primary`'s
foreground/weight, or picking a different token for one of the two surfaces. That is a **brand-color
decision**, not a mechanical fix. An unattended fire must not redesign a token unilaterally.

## Acceptance criteria

- Both `test.fixme` blocks in `e2e/contrast.spec.ts` (~line 298, ~line 417) are unskipped and pass
  against the real computed styles — this is the acceptance criterion; the suite already exists
  and already checks the right thing.
- No other AA contrast regression introduced elsewhere (the rest of `e2e/contrast.spec.ts`,
  12 passing assertions as of PR #44, stays green).
- Whatever the TL decides (darken the accent, change weight/size, or swap the token on one
  surface), record the decision + rationale in this file or in `docs/DECISIONS.md`.

## Not in scope

Redesigning `--accent` wholesale, or touching any other token — this ticket is narrowly the two
measured failures above.
