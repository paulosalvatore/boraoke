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
