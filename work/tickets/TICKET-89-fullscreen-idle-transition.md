# TICKET-89 — Fullscreen drops out on the idle transition (TICKET-82 follow-up N4)

**Filed:** 2026-08-19, interactive TM session (TL present)
**Priority:** LOW-MED
**Size:** S
**Type:** UX follow-up

## Why this exists

TICKET-82 (PR #61, merged) fixed the TV fullscreen black-screen defect: the player host used to
live inside the `nowPlaying ? … : idle` branch, so an empty-then-refilled queue unmounted the
iframe and left a dead player behind. The fix mounts the main row for the component's whole life
and hides it with `display: none` while idle, keeping the player node alive across the gap.

**One accepted-but-not-ideal side effect of that fix, recorded as follow-up N4 in TICKET-82's own
review:** when the queue empties and the view transitions to idle, a player that was in
**fullscreen** now drops out of fullscreen, because the browser exits fullscreen automatically
when the fullscreened element (the main row) gets `display: none`.

This is **strictly better than the pre-fix behavior** — a dead black embed the venue had to
manually refresh — so it was accepted as-is rather than blocking the fix. But it is a real,
user-visible regression from what a venue might expect: a TV that's been put into fullscreen for
the night now silently drops out of fullscreen every time there's a gap between singers, and
whoever is running the venue's screen would need to notice and re-trigger fullscreen by hand.

## What's needed

A venue may want fullscreen to **survive** a gap between singers rather than exit and require a
manual reset each time. Options to weigh (not yet decided — this ticket is scoping, not
prescribing):

- Keep the main row's fullscreen container mounted and only hide/show an inner content layer
  (idle placeholder vs. now-playing content) instead of toggling `display: none` on the
  fullscreen-participating element itself.
- Detect the fullscreen-exit-on-idle case and proactively re-request fullscreen once a new video
  loads (re-entering fullscreen programmatically outside a user gesture is blocked by most
  browsers, so this may not be viable — verify before committing to this approach).
- Accept the current behavior as a known limitation and instead make the idle state visually
  louder/clearer so a host notices and re-fullscreens quickly, rather than trying to preserve
  fullscreen across the gap at all.

## Acceptance criteria

- Fullscreen survives the queue emptying and refilling.
- No audio plays while idle — asserted, not assumed.
- The TICKET-82 regression tests still pass, including the empty-then-refill case.
- The TICKET-70 up-next rail fix is not regressed.
- A test covers the fullscreen-survives-idle behaviour, negative-controlled.

---

## RESOLVED — 2026-08-19. The premise above was wrong, and the real behaviour was worse.

**Status:** implemented. Branch `ticket/89-fullscreen-idle-transition`.
Full write-up: `work/reports/dev/TICKET-89-report.md`. Evidence: `work/evidence/TICKET-89/`.

### What the investigation found

This ticket, and TICKET-82's follow-up N4 that it was filed from, both assert that the browser
"exits fullscreen automatically when the fullscreened element gets `display: none`". Measured
against real Chromium — headless **and** headed — that is false:

> `display: none` on the fullscreen element, **or on any ancestor of it**, does **not** exit
> fullscreen. The element collapses to a **0×0 box**. The screen stays fullscreen and paints nothing.

So the venue was never getting "a TV that fell out of fullscreen and needs someone to walk over".
It was getting a **black fullscreen screen for the whole gap between singers**, with the recruitment
QR poster rendered but unreachable behind the still-fullscreen invisible player, exitable only by a
human pressing Esc. That is a kiosk defect, and it reproduces in the real app — see the negative
control in the dev report.

### The distinction that decides everything

Two different fullscreen elements behave oppositely:

| How fullscreen was entered | Fullscreen element | Survives idle? |
|---|---|---|
| The screen's own "Tela cheia" button / `F` | `document.documentElement` | **Yes, already.** Hiding a descendant cannot affect it; the idle poster shows *in* fullscreen. |
| YouTube's own fullscreen button in the embed | the `<iframe>`, inside `.main` | **No** — the black-0×0 state. |
| The browser's F11 | not the Fullscreen API | Unaffected. |

The venue scenario in this ticket **already worked** on the affordance the product ships. The broken
path is YouTube's own control, which was never meant to be the venue's fullscreen mechanism.

### The fix (`components/tv/TvScreen.tsx` only — no CSS change)

1. **`fs: 0`** in `playerVars` — the embed is built without YouTube's fullscreen control, so the
   iframe cannot become the fullscreen element through the UI.
2. **A defensive exit at the idle transition** — if `document.fullscreenElement` is inside the
   player host, leave fullscreen deliberately. `host.contains()` is true for our iframe and false
   for `documentElement`, so it never cancels the venue's own fullscreen.

Both directions are gesture-free by design. **Re-entering fullscreen needs a user gesture and could
not be validated here anyway** — the Playwright harness grants `requestFullscreen()` on a
never-clicked page (`activation-probe-headed.json`, H0), so a re-entry fix would look green in CI
and silently no-op on a real kiosk.

### Audio

Hiding an element does **not** pause media inside it (probe G: `paused: false`, `currentTime`
advancing, after both `display: none` and `visibility: hidden`). The idle screen is silent purely
because of the existing `stopVideo()` call — which is why `visibility: hidden` / `opacity: 0` were
rejected as "keep it in the fullscreen context" tricks, and why silence is now asserted by a test.

### Correction to the record

TICKET-82's review N4 is cited as a deliberately accepted tradeoff and is factually wrong about what
browsers do. TICKET-82's fix itself remains correct and is not weakened by this — it is left as the
historical document it is, with the correction recorded here.
