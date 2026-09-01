# TICKET-101 — the CSS needs Chrome 84–88, but we declare a Chrome 68 target

**Filed:** 2026-09-01, found while checking for a second cause behind the LG TV failure (TICKET-98)
**Priority:** MEDIUM–HIGH (decides whether a fixed TV *looks* right, not whether it boots)
**Type:** Browser-compatibility / honesty of a declared target

## What was found

PR #76 fixed the **parse floor** — after it, every JS chunk parses at ES2019, so the app boots on
Chrome 68+. It also declared `browserslist: ["chrome >= 68", ...]` in `package.json`.

**The CSS does not honour that declaration.** Scanning the emitted stylesheets:

| Feature | Occurrences | Needs |
|---|---|---|
| `gap:` inside a `display:flex` rule | **39 rules** | **Chrome 84** |
| `gap:` inside a `display:grid` rule | 7 rules | Chrome 66 (fine) |
| `aspect-ratio` | 1 | **Chrome 88** |
| `clamp()` | 1 | Chrome 79 |

So the honest floor is **Chrome 84 for correct spacing** and **88 for full fidelity**, against a
declared 68. I wrote that `chrome >= 68` line in PR #76, so this is a correction to my own change,
not an inherited defect.

## Why it matters, and why it is different from TICKET-98

CSS fails **silently**. An unsupported property is dropped, not thrown — so nothing errors, nothing
logs, and the page "works" while looking wrong. On a TV that reads as a broken product rather than
a broken browser.

Concretely, mapped onto real LG firmware:

| webOS | Chromium | After PR #76 |
|---|---|---|
| 4.5 / 5.0 | 68 | Boots. **39 flex rules lose all spacing** — layout collapses together. |
| 6.0 | 79 | Boots. Same flex-gap collapse. |
| 22 | 87 | Boots, spacing correct, `aspect-ratio` ignored (1 rule). |
| 23+ | 94+ | Fully correct. |

## Relation to the Tech Lead's report

He said the site "did not load" — that is the parse failure (TICKET-98), and this ticket does not
change that diagnosis. But it means **"it boots now" is not the same as "it looks right on his
TV"**, and if his set is webOS 6.0 or older, the first thing he will see after the fix deploys is a
layout with its spacing collapsed. Worth knowing before he retests, so the result is not mistaken
for a new bug.

## Options

1. **Raise the declared floor to what we actually meet** (`chrome >= 88`) and state plainly that
   pre-2023 LG TVs are unsupported. Honest, zero work, but it writes off a large installed base for
   a product whose whole point is running on the TV already in the venue.
2. **Add margin-based fallbacks for the 39 flex-gap rules** so spacing survives on Chrome 68–83, and
   a fallback for the single `aspect-ratio` use. Real work, but it makes the declared 68 true.
3. **Split the difference:** fix the TV surface (`/[room]/tv`) properly, since that is the one
   rendered on the television, and accept the higher floor on phone/desktop surfaces where modern
   browsers are the norm. Cheapest path to "the product works in a venue".

Option 3 is the recommendation, but which TVs we support is a **product decision** and belongs to
the Tech Lead, especially once he reports his webOS version.

## Acceptance criteria

- The declared `browserslist` and the emitted CSS agree — whichever way that agreement is reached.
- A check that keeps them honest, in the spirit of `scripts/check-bundle-es-target.mjs`: scan the
  emitted CSS for features newer than the declared target and fail the build. Note the parse gate
  cannot catch this class — CSS does not throw — so this is a **separate** check, not an extension.

---

# RESOLVED for the TV surface — 2026-09-01 (option 3, as recommended)

**Approach taken:** fix the surface that actually renders on a television to the low floor, keep the
higher floor on phone/desktop where modern browsers are the norm, and make the split enforceable
rather than a matter of memory.

## `components/tv/tv.module.css` now holds at Chrome 68

- **10 flex-`gap` declarations → `> * + *` sibling margins.** Margins work in every engine.
- **2 `inset: 0` → `top/right/bottom/left`** (the shorthand needs Chrome 87).
- A file header states the constraint and, importantly, **why `@supports` is the wrong fix here**:
  `@supports (gap: 1px)` reports TRUE on old Chrome because *grid* gap shipped in 66 while *flex*
  gap only arrived in 84 — so the guard passes exactly where it is needed. That trap is the reason
  this had to be a removal rather than a progressive enhancement.

## `scripts/check-css-target.mjs` — the gate

Scans source stylesheets for features newer than the declared floor and **fails the build** for the
TV surface (`tv.module.css`, `globals.css`), while reporting everything else as **advisory** rather
than blocking. That split is what let the TV be fixed now without waiting on the product decision
about which TVs we support.

It carries a per-rule flex-gap detector (a rule that is both `display:flex` and has `gap`), because
the property name alone cannot distinguish grid gap (fine at 66) from flex gap (84). It also
refuses to pass on an empty scan — a zero result must mean zero findings, not zero files scanned.

Wired into `npm run build` alongside the ES gate, so neither an unparseable bundle nor a
silently-wrong TV layout can be deployed.

## Verified, by measurement rather than inspection

- The gate fails on the pre-fix file and passes after.
- Full Playwright suite **106/106**, including the TV layout specs at 1920x1080 and 1440x900.
- **Spacing measured live**: adjacent up-next rail cards sit **29px** apart at a 1920 viewport,
  against `gap: 1.5vw` = 28.8px. The sibling margins reproduce the original spacing exactly, so this
  is a compatibility change with no visual cost on modern browsers.

## Still open (deliberately)

The **product decision** — which TVs boraoke supports — remains the Tech Lead's, bundled for him
with his webOS version and the retest heads-up. The advisory findings on `app/page.module.css`,
`LanguageSwitcher` and `FeedbackWidget` are left as-is on purpose: those surfaces are phone/desktop,
and holding them to a 2019 TV floor would cost more than it buys. If that decision later says
"support old TVs everywhere", the gate is already there — move those files into the strict list.

**Known limitation this does NOT fix:** an old TV still boots into a page whose *other* surfaces
(the patron room on a phone is fine; the landing page on the TV browser is not) use flex gap. The
TV only ever renders `/[room]/tv`, so this is correct scoping rather than a gap — but if the TV is
ever pointed at the landing page, spacing there will still collapse below Chrome 84.
