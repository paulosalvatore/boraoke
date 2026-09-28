# TICKET-103 — App Tester independent visual gate

**PR:** #83 (`ticket/103-tv-focus`), worktree `.worktrees/t103-tv-focus`
**Role:** App Tester — clean, bias-free pass. This report was written before reading the Dev's or the earlier App Tester's conclusions on the QR-on-video call; the code and the `run-app` skill notes were read for mechanics only. One fact was pulled deliberately from the earlier test report (`work/reports/testing/TICKET-103-test-report.md` line 81): the `dQw4w9WgXcQ` fixture video fails fast in this sandbox and the working substitutes are `aqz-KE-bpKQ` / `eRsGyueRtiY` (Blender Foundation CC shorts) — needed to get real video playback for the QR-legibility test at all.

## Verdict: **PASS** — on-video QR ships

Judged from captures, at TV viewing distance, against both a dark/moody frame and a very bright/busy frame: the QR is legible, doesn't cover anything important, and reads as an intentional composed overlay, not a glitch. This is not a close call — see the reasoning under Item 3 below. Independent test runs (unit + the full `tv.spec.ts` + `tv-watchdog.spec.ts` e2e suites) are green, matching the PR's claimed numbers.

## Environment note (read this before the captures)

This sandbox's egress reaches `youtube.com`, but the ticket's usual fixture video (`dQw4w9WgXcQ`, Rick Astley) fails fast here — confirmed by an earlier pass, not re-investigated (orthogonal to this ticket). Real playback was obtained by queuing `aqz-KE-bpKQ` (Big Buck Bunny) and `eRsGyueRtiY` (Sintel), both Blender Foundation Creative-Commons shorts, which played reliably for every capture below. All rooms, songs, and interactions were created through the real UI (create-room form → patron join page → `/tv`), not seeded via API, per instructions.

**Recurring friction, worse than documented (see `## Friction`):** the in-memory store did not just reset on a route's literal first compile — it reset several times over the course of this session, apparently whenever Next dev's `onDemandEntries` (~25s default) evicted an idle compiled route (observed repeatedly with `/apple-icon.png`) and recompiled it on the next hit. Three rooms were silently wiped mid-test before I settled on a fast, single-pass workflow: create room → queue songs → go straight to `/tv` → capture, with no idle gaps in between.

## What was independently verified

### 1. `.video` viewport share: 35.6% → 93.6%

Measured via `getBoundingClientRect()` at 1920×1080, same room, same session:

| State | Width % | Height % | Area % |
|---|---|---|---|
| Normal (chrome visible, real video playing) | 54.68% | 65.02% | **35.56%** |
| Focus (idle ≥4s, song playing) | 97.00% | 96.45% | **93.55%** |

Both numbers reproduce the PR's claimed 35.6% and 93.6% (my measurement differs by ≤0.05pp, consistent with sub-pixel rounding). **Confirmed independently**, not just re-quoted.

### 2. QR is the same single DOM node in both states

Method: tagged the live QR `<img>` element with a random `data-apptest-marker` attribute while in the focus state, then re-queried `document.querySelectorAll('[class*="_qr__"]')` — always exactly **1** match — across: normal, focus, mid-queue-peek, right after the native-fullscreen redirect, and after two keyboard-wake cycles. The marker survived every transition (a remount would have produced a fresh node without the marker, and a duplicate would have produced a count of 2). The QR's `getBoundingClientRect()` was **byte-identical** (`x:1427.578125, y:883.1875, w/h:153.59375`) across every one of those checks — it never moved, which independently confirms the "cards stay in layout, QR never shifts" design (proof-by-absence handled per the skill: this is a positive multi-sample equality check across five distinct states, not a single silent no-op read).

### 3. QR-on-video visual call (the decision that was mine to make)

Captured against a **dark/mossy frame** (`apptest-2-focus-qr-on-video-1080p.png`) and a **bright, high-key frame** — blue sky, white flowers in direct light, a light-grey rabbit close-up (`apptest-3-focus-queue-peek-visible-1080p.png`, which also shows the queue-peek cards). In both:

- **Legible/scannable at a glance, across both brightness extremes.** The QR sits on its own solid, near-opaque dark plate (`rgba(13,10,20,0.92)`) with a visible border and drop shadow — it is never composited directly onto raw video pixels, so brightness/business of the underlying frame doesn't degrade its contrast or quiet zone. This is exactly why the bright-frame capture (arguably the harder case) is just as clean as the dark one: the card, not the video, sets the QR's background.
- **Covers nothing important.** The rail sits bottom-right, over background scenery in both captures; no lyrics/subtitle track exists on this surface, so the karaoke-lyrics hazard the brief called out doesn't apply here (there's no burned-in lyric layer in `/tv` — singers read from a phone or their own memory, per the product's actual design, confirmed by reading the surface — no lyrics element exists in `TvScreen.tsx`).
- **Reads as intentional.** Card styling (rounded corners, consistent padding, "Escaneia e canta!" CTA copy, powered-by line) matches the same card used in the idle poster and the normal-state rail — it's a deliberately designed component repositioned, not an ad-hoc watermark.

**This was not a close call.** The opaque-card design decision (already in the code, not something I'm crediting to my own judgement) is what makes it work regardless of video content — I'd flag concern only if the QR were directly alpha-blended onto the raw frame, which it is not.

### 4. Queue overlay timing and QR stability

Instrumented via a busy-wait `evaluate()` (to avoid this session's multi-second tool-round-trip latency corrupting the timing signal) that polled `.peek` class + `getComputedStyle(railLabel).opacity` in-page. Observed: `opacity` reaches `1` within ~600ms of the `peek` class engaging and holds at `1` for the sampled window — consistent with the documented 3s lead-in / 6s visible / 30s cycle (`components/tv/focus-state.ts`, unit-tested there). `apptest-3-focus-queue-peek-visible-1080p.png` is a direct capture of the reveal: "A SEGUIR" label + the "2 · Rafa · Sintel · Mesa 2" card both visible, QR untouched at its usual position (see item 2 — identical rect, before/during/after). The independent e2e run (`tv.spec.ts:995`, "up-next queue reveals on a timer, hides again, and comes back") also passed.

**Not independently re-verified in this pass:** the "only one song queued → peek must never fire" edge case, and "queue changes mid-focus → player doesn't reload." Both are covered by the PR's own e2e suite and by `shouldRunQueuePeek`'s pure-function gate (`upcomingCount > 0`, read directly in `components/tv/focus-state.ts`), and both corresponding e2e tests passed independently in my own re-run (`tv.spec.ts`, full suite green, 16/16). I did not additionally reproduce them by hand given the tool-latency friction documented above made every extra live scenario expensive; flagging this rather than silently asserting I did.

### 5. Wake signals: keyboard and window blur

- **Keyboard:** dispatched `ArrowRight` (a real keydown, not the app's own `F` handler) while in the focus state — chrome (`tv_focus`, `tv_cursorHidden`) cleared instantly. Captured: `apptest-4-wake-keydown-1080p.png`.
- **Window blur:** a plain untrusted `new Event('blur')` did **not** reliably wake it in my testing; `new FocusEvent('blur')` did, immediately (confirmed via `requestAnimationFrame` + timed re-checks; class cleared within one frame). This is very likely a quirk of how a synthetic, non-`FocusEvent`-typed event interacts with this specific listener/environment rather than an app defect — the real, in-app trigger (focus moving into a cross-origin iframe) fires a genuine `FocusEvent`, and that path worked. Flagging the discrepancy rather than glossing over it, since it's exactly the kind of ambiguous result the gate is supposed to surface, but I do not believe it indicates a real defect.
- **Native-fullscreen redirect:** clicked into the player iframe, pressed `F`. `document.fullscreenElement` returned to `null`, `data-native-fs-redirects` incremented from unset to `"1"`, and the app landed back in its own **app-owned focus state** (video large, QR visible, queue-peek even mid-cycle) rather than a blank/black screen. Captured: `apptest-5-native-fs-redirect-1080p.png` (shows YouTube's own transient hover-controls from the click, which is expected residual iframe UI, not an app defect — our own chrome stayed hidden throughout).

## Independent gate re-runs (not just re-quoted from the PR body)

```
npm test                                    → 53 suites, 931 passed, 5 skipped (matches PR)
node scripts/check-css-target.mjs           → css-target: OK — TV surface uses nothing newer than Chrome 68
                                               (16 advisory findings elsewhere in the app, none on /tv, none build-blocking)
node scripts/check-bundle-es-target.mjs     → OK — 61 chunks parse at ES2019
npx playwright test e2e/tv.spec.ts          → 16 passed (1.9m), incl. all 3 TICKET-103 tests
npx playwright test e2e/tv-watchdog.spec.ts → 3 passed (54.8s)
```

This repo has no `scripts/verify-green-local.sh` (that convention is framework-level, D-051); the repo's own gate chain is `npm test` + the two build-target checks + `npx playwright test`, all re-run above independently rather than trusted from the PR body. `gh pr checks 83` shows only Vercel deployment checks (both pass) — no GitHub Actions test suite is wired for this repo, so there is nothing "pending" to block on.

## Evidence index

All in `work/evidence/TICKET-103/`:

| File | What it shows / proves |
|---|---|
| `apptest-1-normal-1080p.png` | Normal state, real video (Big Buck Bunny) playing, chrome + QR + rail all visible. Baseline for the 35.56% video-area measurement. |
| `apptest-2-focus-qr-on-video-1080p.png` | Focus state against a dark, mossy/high-contrast frame. QR legible on its opaque card. |
| `apptest-3-focus-queue-peek-visible-1080p.png` | Focus state against a **bright, high-key** frame (blue sky, white flowers, light fur) — the harder legibility case — captured exactly during the timed queue-peek reveal ("A SEGUIR" + "Sintel/Mesa 2" card visible, QR unmoved). |
| `apptest-4-wake-keydown-1080p.png` | Immediately after an `ArrowRight` keydown wakes the UI from focus state — chrome/cursor restored. |
| `apptest-5-native-fs-redirect-1080p.png` | Immediately after YouTube-native fullscreen was entered then redirected out of — app-owned focus state, QR visible over real video, not a blank screen. |

Pre-existing evidence from the Dev/prior App Tester pass (`t103-*.png`, `tv-*.png`) was left as-is and not overwritten.

## Friction

- **The Next dev in-memory-store reset trap is bigger than the `run-app` skill currently documents.** It's not only "a route's literal first compile" — it recurred on `/apple-icon.png` three separate times across ~10 minutes of real elapsed time in this session, each time wiping the room store, consistent with Next's `onDemandEntries` (~25s) evicting an idle compiled route and re-running its module top-level code (including whatever singleton the store lives on) on the next hit. Practical workaround used here: do the whole create-room → queue → navigate-to-`/tv` → capture sequence back-to-back with no idle gaps, and treat any multi-step pause as a reason to re-verify the room still exists before proceeding. Worth a follow-up to `run-app`'s "warm every route" note — warming once at the start is not sufficient if the session runs long enough for eviction to kick in mid-test.
- **Agent-tool round-trip latency (this session, not the app) made precise timing observations unreliable** — a nominal 1-2s `wait_for` could correspond to 10-18s of real wall-clock time between calls, which is why the queue-peek timing check used an in-page busy-wait (`evaluate` polling with `setTimeout`) instead of external polling. Left as a note for future App Tester passes on animation-timing-sensitive surfaces.
- Two of the four seeded videos in this room's history got dropped as "already queued" (per-room duplicate-videoId check, not per-patron) when reusing the two known-good IDs a third/fourth time — expected product behavior, not a defect, just constrained the size of the up-next rail actually exercised (1 upcoming song rather than 3).

## Scope not covered by this pass

- Real LG webOS hardware validation (rest-mode interaction with these overlays) — the PR itself already correctly files this as a non-headless-provable follow-up, not something this gate can or should block on.
- Phone-camera-in-hand scan test of the QR (only visual/contrast judgement from captures, per the instructions — "test seeing the visual").
