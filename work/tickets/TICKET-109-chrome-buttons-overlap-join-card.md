# TICKET-109 — TV chrome buttons overlap the join card's text at 1080p (pre-existing)

**Filed:** 2026-09-27, spotted by the TICKET-103 Dev while capturing evidence; deliberately NOT fixed there (out of that ticket's scope).
**Priority:** MED — it sits on the venue-facing screen, in the default state, at the resolution every television uses.
**Type:** UX defect
**Size:** S

## What

In the **normal** (non-focus) TV state at 1920x1080, the "Pular" / "Tela cheia" chrome buttons **overlap the join card's text**. Visible in the committed evidence `work/evidence/TICKET-103/t103-1-normal-1080p.png`.

**Pre-existing** — not introduced by TICKET-103. It was invisible until someone captured the TV surface at real TV geometry rather than a desktop viewport, which is itself the lesson: this class of defect cannot be found at 1280x720.

## Why it matters more than it looks

This is a **10-foot UI** on a screen a room full of people are looking at, and the overlapped element is the **join card** — the thing that tells a patron how to get into the queue. Text collision there is not cosmetic; it degrades the one instruction the screen exists to give, in the state the TV spends most of its time in.

## What's needed

Lay the chrome controls out so they cannot collide with the join card at TV geometry. Check 1920x1080 specifically, and confirm whatever fix is chosen also holds at 1280x720 and at 3840x2160 — the CSS is `vw`-relative, so a fix that works at one resolution may not at another.

## Constraints

- `components/tv/tv.module.css` is pinned to the **Chrome 68** floor (**no flex `gap`, no `inset` shorthand**), enforced by `scripts/check-css-target.mjs`.
- The chrome bar fades on the `CHROME_HIDE_MS = 4000` timer and is repositioned by TICKET-103's focus state — coordinate with whatever lands there rather than assuming today's layout.
- Prove it with captures at each resolution; this is a visual defect, so screenshots are the evidence, not assertions.
