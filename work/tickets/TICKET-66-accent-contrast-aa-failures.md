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

---

## Decision (2026-08-07) — Option B, role-split accent tokens

**Status:** IMPLEMENTED on `ticket/66-accent-token-split`.

The TL approved landing-rethink **Direction 2**, whose mockups are built on the **Option B palette**. Option B is implemented here.

`--accent` (`#e63946`) is retained unchanged as the brand hue for borders, focus rings, badges and large/decorative text. Two derived tokens do the AA-critical work: `--accent-strong` (`#d92330`) fills CTAs under white text (4.96:1), and `--accent-text` (`#ee5a64`) is the accent used AS text on dark surfaces (5.21:1 on `--surface`, 5.81:1 on `--bg`, 5.45:1 on the mode-switcher tint).

**Rationale — why not a single darker hex.** White-on-accent ≥4.5:1 requires luminance ≤0.183; accent-as-text-on-dark ≥4.5:1 requires the opposite. Every single-hex candidate fixes `.btn-primary` and breaks accent-as-text everywhere else (`#e42735` → 4.53 on the button but 3.85 on `--surface`). The constraints are mathematically incompatible for one colour, so the token is split by role. Full measured proof: `work/design/landing-rethink/CONTRAST.md`.

**Scope note — a third failure was fixed, not two.** Beyond the two recorded `test.fixme` findings, `#e63946` as normal-size text on `--surface` (4.18:1) was latent and untested — it hit admin `.error`, `.removeBtn`, `.rejectBtn`, the mode-switcher "ATIVO" chip, patron rejected-pending text, `SavedRooms` links and `SongSearch` status. Two new e2e tests now cover that class so it cannot hide again. Two further genuine misses surfaced during the call-site sweep (accent-as-text on the `.12`-over-`--bg` tint = 4.26, and on the `.10`-over-`--surface` tint = 3.84); both are fixed by the same swap.

**One call site is deliberately NOT fixed here:** `app/page.tsx:93` (`last-room-link`) is owned by the concurrent landing rebuild. It needs `--accent` → `--accent-text` and must be routed after that branch merges.

**One call site must NOT be changed:** `app/admin/analytics/analytics.module.css:49` `.button` pairs `--accent` with **dark** `#0a0a0a` text (4.75:1 PASS). Moving it to `--accent-strong` would drop it to 3.99:1 and introduce a regression.

Delivery: `work/reports/dev/TICKET-66-dev-report.md`, review at `work/reports/review/TICKET-66-review.md`, evidence in `work/evidence/TICKET-66/`.
