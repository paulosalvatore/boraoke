# TICKET-98 — boraoke does not work in a real TV browser (LG webOS)

**Filed:** 2026-09-01, from the Tech Lead's real test of 2026-08-27 (`work/status/TL-REAL-TEST-2026-08-27.md`)
**Priority:** 🔴 CRITICAL — this is the product's top item, above all other boraoke work
**Type:** Core defect, target-device

## The failure

On the Tech Lead's own LG TV, a live demo failed completely. He fell back to screen-sharing his
phone. Three distinct symptoms:

1. The site **did not load** in the TV browser.
2. The **QR code did not show** — and QR is the intended patron-join path, so the entry to the whole
   product was gone.
3. It **errored every time it tried to load a song**.

## Why this is priority 1

The TV *is* the product. boraoke's premise is a venue screen that phones queue songs onto. An app
that does not run on a television is not a partially-working karaoke app.

Note also that all three symptoms may or may not share a root cause. **Do not assume one bug.** A
page that fails to load and a song-load error are plausibly independent (an engine/parse failure
versus a YouTube IFrame API problem on an old WebKit), and "the QR did not show" could be either a
consequence of (1) or its own defect.

## Approach — reproduce BEFORE theorising

The instruction from the TL is explicit: **reproduce first**, then diagnose from logs, then fix.
The temptation here is to reason from the symptom list to a plausible cause and start patching.
Resist it: we have three second-hand symptoms from five days ago and zero direct observation.

1. **Get the failure in front of us.** Either a real webOS browser or a faithful emulation — see
   TICKET-99, which is the machinery half of this and can proceed in parallel.
2. **Pull the production logs from Thursday night 2026-08-27** and look for the song-load errors and
   the load failure. Caveat, to be checked early rather than assumed: Vercel runtime log retention
   is short (about 1 hour on Hobby, ~3 days on Pro), so 5-day-old logs are **likely already gone**.
   If they are, say so plainly and rely on reproduction instead — do not present an absence of logs
   as an absence of errors.
3. Only then root-cause and fix, symptom by symptom.

## Likely areas to examine (hypotheses, NOT conclusions)

- **JS engine level.** webOS TV browsers run older WebKit builds. Modern syntax or APIs in the
  shipped bundle (optional chaining in an un-transpiled dependency, newer `Intl` usage, `structuredClone`,
  modern CSS features) can hard-fail the page. Check the Next.js browserslist/transpile target.
- **The QR code path** — how it is generated and whether that path depends on anything the TV engine
  lacks (`qrcode` renders to canvas; canvas support and sizing on TV browsers are worth verifying).
- **The YouTube IFrame API on webOS** — the song-load errors point here first. Embedded playback on
  TV browsers has its own constraints, and the TV path is exactly where our watchdog/self-heal logic
  lives.
- **Anything gated on viewport, pointer, or fullscreen APIs** that behaves differently on a TV.

## Acceptance criteria

- The failure is reproduced and documented on a real or faithfully-emulated TV browser, with
  evidence, BEFORE any fix is written.
- Each of the three symptoms is separately root-caused, or explicitly shown to share a cause.
- The page loads, the QR renders, and a song plays on the target device.
- Verified on the actual target environment — not on desktop Chromium. A desktop-green result is
  precisely what failed to catch this.

## Explicitly NOT the fix

Adding more Playwright specs on Chromium. The gap is the test *environment*, not test coverage.

---

# ROOT CAUSE FOUND — 2026-09-01, same day as filing

**Status: mechanism PROVEN by static analysis. Attribution to the TL's specific TV is strong but
needs one fact from him (his webOS version). Not yet reproduced on a physical TV.**

## The finding

`https://boraoke.com` ships a JavaScript chunk that **cannot be parsed by any browser engine older
than Chrome 94**. A parse failure is not a degraded feature — the chunk never executes, so the app
never boots. That is symptom 1 ("the site did not load"), and symptoms 2 and 3 follow from it: with
no JS running there is no QR render and no player.

## The evidence

Production chunk `955-fa0cb7013a87d4cd.js`, parsed with acorn at successive ECMAScript levels:

```
ES2019: FAIL — Unexpected token (1:15788)
ES2020: FAIL — Unexpected token (3:1715)
ES2021: FAIL — Unexpected token (3:1715)
ES2022: OK
```

The construct at the ES2020 failure point is a **class static initialization block**:

```js
static{this.memoizedDefaultLocale=null}
```

`static {}` is **ES2022**, supported from **Chrome 94**. There are 4 occurrences. The same chunk
also carries 25 optional-chaining (`?.`) and 5 nullish-coalescing (`??`) operators — both ES2020,
Chrome 80+ — so older engines fail even earlier in the file.

**Blast radius: every route.** The chunk is referenced by `/`, `/default`, `/default/tv` and `/new`.
There is no route that boots without it.

**What the chunk is:** `next-intl` / `Intl` message-formatting code (`formats.date`,
`resolvedOptions`, `pluralRules` are all visible in it). It is a **dependency**, and Next.js does not
downlevel `node_modules` by default — it transpiles first-party code only. So our own source being
conservative does not help; the dependency's own published syntax is what ships.

`next.config.ts` sets no `transpilePackages`, and the repo has no `.browserslistrc` and no
`browserslist` key in `package.json`. Nothing in the build targets an older engine.

## Why this maps to an LG TV

LG webOS TV browsers are **Chromium**-based, at a version fixed by the TV's firmware generation:

| webOS | approx. year | Chromium | Can parse this chunk? |
|---|---|---|---|
| 6.0 | 2021 | 79 | **No** — fails on `?.` too |
| 22 | 2022 | 87 | **No** — fails on `static {}` |
| 23 | 2023 | 94 | Yes (right at the boundary) |
| 24 | 2024 | 108 | Yes |

So **any LG TV older than roughly 2023 cannot run boraoke at all**, and fails in exactly the way the
TL described: nothing loads.

**Correction to this ticket's original hypothesis.** It guessed "old/limited WebKit". That was
wrong — webOS is Chromium-based. A probe against Playwright's WebKit (26.5) loaded the site cleanly
with zero page or console errors, on both the landing and `/tv`, including with a webOS user-agent
string. Modern WebKit is not the problem, and testing against it would have produced a false green.

## The one fact still needed from the Tech Lead

**Which LG TV / webOS version?** If it is webOS 22 or older, this is a complete explanation of all
three symptoms. If it is webOS 23+, the parse floor is still a real defect that locks out most of
the installed base, but something else also broke his night and we keep digging.

## Fix direction

1. **`transpilePackages`** for `next-intl` (and any other dependency shipping modern syntax) in
   `next.config.ts`, so the dependency is downleveled with our own code.
2. **Declare the target explicitly** — a `browserslist` naming the oldest webOS Chromium we intend
   to support, so the build target is a stated product decision rather than an accident of defaults.
3. **Verify by parsing the emitted bundle**, not by inspection — the check below.

## This is TICKET-99's cheapest and highest-value machinery

A build-time gate that parses **every emitted chunk** at the target ECMAScript level and fails the
build on a regression. It needs no TV, no emulator and no device farm; it is a few lines of acorn;
and it would have caught this exact defect the day the dependency was added. Note that it catches
*parse-level* breakage only — runtime API gaps (a missing `Intl` feature, an unsupported CSS
property) still need a real or emulated device, so this complements TICKET-99 rather than replacing
it.
