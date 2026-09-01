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
