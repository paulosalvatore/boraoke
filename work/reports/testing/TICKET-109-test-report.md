# TICKET-109 — App Tester visual gate: chrome buttons overlap the join card at TV geometry

- **Date:** 2026-09-27 · **Role:** App Tester · **PR:** #85 · **Branch:** `ticket/109-chrome-overlap`
- **Worktree:** `.worktrees/t109-chrome-overlap` · **App port:** 3123 (fresh, never previously used, fresh `--localstorage-file`)

## Verdict: **PASS-WITH-NOTES**

The fix works and is proportionate — no functional or design defect. Two notes for the record: (1) the new regression test's coverage is narrower than the fix's claimed scope (1080p normal-state only — see below), and (2) the normal-state content area is measurably, if modestly, smaller than before; it does not read as bottom-heavy or wasted on screen, but it is a real trade-off worth naming rather than silently accepting.

## What was tested

1. No overlap at 1280x720, 1920x1080, 3840x2160 (normal/non-focus state) — measured, not eyeballed.
2. Focus state unaffected.
3. Judgment call on whether the wider bottom padding degrades the normal state.
4. Scope of the new `e2e/tv.spec.ts` geometry regression test.

## Method note (read before the numbers)

The in-memory queue in this sandbox auto-drains within 1-3s of a song reaching `nowPlaying` (the headless YouTube player errors immediately with no real playback, and the watchdog's `isFatalPlayerError` path auto-advances) — confirmed independently here, matching the Dev's report exactly. Practical effect: every measurement below had to be taken in a single navigate→evaluate burst seeded with ~30 songs; screenshots taken even a few seconds later (one extra tool round-trip) sometimes landed on the next song's "skip unavailable" transition or had already auto-triggered the focus state. Where a screenshot shows the "Pulando vídeo indisponível…" skip toast or a focus-state layout instead of the exact geometry-measurement moment, that is this drain racing the capture, not a product defect — each screenshot is paired with (or immediately preceded by) a DOM `getBoundingClientRect()` measurement taken in the same burst, which is the authoritative number. Also hit once: an initial `browser_resize` call landed on a stale leftover tab pointed at port 3095 (another ticket's session) — caught immediately from the printed page URL in the tool result and did not touch that server; every real measurement below is confirmed against port 3123 only.

## 1. No overlap across resolutions — measured

All three seeded fresh, normal (non-focus) state, chrome bar visible, via `getBoundingClientRect()` on `[data-testid="tv-chrome"]` and `[data-testid="tv-powered-by"]`:

| Resolution | Chrome↔join intersect | Vertical gap (px) | Video area share of viewport |
|---|---|---|---|
| 1280x720 | **false** | 10.7 | 30.7% |
| 1920x1080 | **false** | 18.5 | 30.9% |
| 3840x2160 | **false** | 40.0 | 31.0% |

No intersection at any of the three ticket-mandated resolutions. The gap and video-share numbers track each other almost exactly proportionally across all three (30.7–31.0%), which **empirically confirms the Dev's vw-scaling reasoning** — this is not simply accepted on the strength of the argument, it is measured.

Evidence (screenshots, same sessions as the table above — `work/evidence/TICKET-109/`):
- `apptester-normal-720p.png` — normal state, join card clear of the (already re-faded-by-capture-time, hence not visible) chrome position; queue/rail rendering confirms non-focus state.
- `apptester-normal-1080p.png` — normal state with **both** rail cards and the "Pular"/"Tela cheia" chrome buttons visible simultaneously and the visible gap between them and the join card — the clearest single visual confirmation of the fix.
- `apptester-normal-4k.png` — normal state, same clean gap, join card fully legible.

(Dev's own `before-normal-*` / `after-normal-*` captures in the same directory corroborate the same result at all three sizes.)

## 2. Focus state unaffected — confirmed by measurement, not just cascade reasoning

Reproduced the focus state live (idle-triggered after seeding, confirmed via `tv_focus__…` class on the root element) and measured:

- `videoShare`: **93.0%** of viewport — matches the "~93-94%" spec.
- `chrome` vs `join` bounding boxes: **do** geometrically intersect (as the Dev's report says), but `getComputedStyle()` on the chrome element in this exact state returns `opacity: 0`, `pointer-events: none` (class `tv_chromeHidden__…`) — independently confirmed, not taken on the Dev's word. The overlap is real but invisible and non-interactive, exactly as claimed.
- QR/join card is legible and positioned over/near the enlarged video, consistent with the ticket's expectation.

Evidence: `apptester-focus-1080p.png` (large video, QR bottom-right, no visible chrome bar).

Not independently re-verified here: the "up-next overlay cycling on a timer" sub-claim (item 4 of TICKET-103) — out of this ticket's diff (the padding change is provably inert on `.focus`, see below), and the existing `tv-watchdog`/`tv.spec.ts` focus-state tests already cover it; re-deriving it manually against a queue that drains in 1-3 seconds was not a good use of the capture budget.

## 3. The judgment call: is the trade-off worth it?

**Verdict: yes, proportionate — but it is a real trade-off, not a free lunch.**

- Video area share dropped from the ticket-cited pre-existing baseline of **35.2-35.6%** to a measured **~30.7-31.0%** post-fix — a drop of roughly **4.5 percentage points, ~13% relative**. This matches the arithmetic of the change (extra 4.5vw of vertical padding taken from the flex-1 content area) and is a real, non-trivial shrink, not noise.
- Looking at the actual screenshots (`apptester-normal-1080p.png` in particular, which has real content in every slot): the normal state does **not** read as bottom-heavy, empty, or letterboxed. The extra strip is fully occupied — "A SEGUIR" rail cards plus the join/QR card sit inside it, at their same size — there is no visible dead space; the reserved height became room the existing rail already used, not a blank gap. From a 10-foot viewing distance the readability of "TOCANDO AGORA" / song title / singer line is unaffected — those live in the right column, whose height didn't change.
- So the honest framing: the *video* got smaller (a real, measurable regression in one dimension), but the *layout* does not look broken or wasteful — it looks like a slightly more compact video next to an unchanged info column and rail. Whether a ~13% relative video-size loss is an acceptable price for eliminating a text-collision defect on the screen's primary instruction (the join card) is a product call I'd lean toward "yes" on, but it's close enough, and the cost concrete enough, that I'm surfacing it rather than declaring it costless. A follow-up worth considering later (not blocking this PR): moving `.chrome` up-and-left instead of reserving space for it, so `.main` keeps its former share — the Dev's report already explains why a naive move collides with `.meta` instead, so this isn't a "just do it," it's a real design problem for whoever picks it up.

## 4. Regression test scope — checked, and the Dev's own flag is correct

Confirmed directly in `e2e/tv.spec.ts`:

- Line 14: `test.use({ viewport: { width: 1920, height: 1080 } });` is set **once**, at file scope, before the single `test.describe("/tv", …)` block that contains every test in the file — there is no per-test viewport override anywhere in the file (checked: only one `test.use` call exists).
- The new TICKET-109 test (line 824) sits inside that same describe block and inherits the file-wide 1080p viewport. It never runs at 720p or 4K.
- The new test seeds a normal show and asserts on the DOM state right after `page.goto` — it does not wait for or force the focus state, so it only ever exercises the **normal (non-focus) state's** chrome/join geometry.

**So: yes, this is confirmed true, not just Dev-reported.** The automated regression coverage this ticket adds is narrower than the fix's own claimed scope — it guards exactly one of the three resolutions (1920x1080) and exactly one of the two states (normal). The 720p/4K vw-scaling holds today (I measured it above), and the focus-state overlap is harmless today (also measured above), but **neither of those facts is protected by an automated assertion** — a future change that breaks vw-proportionality at a non-1080p size, or that makes the focus-state chrome visible again (removing `.chromeHidden`/`pointer-events: none` without also fixing the geometry), would not be caught by this test suite. This should be written down as a known gap rather than rediscovered later; it does not block this PR (the ticket only required proving the fix works, which it does), but it's worth a follow-up ticket to either parametrize the geometry test over the three resolutions and both states, or to explicitly document the gap next to the test itself.

## Defects found

None. No console errors attributable to the CSS change. The console did show a large volume of `429 Too Many Requests` on `/api/queue/advance?...reason=unplayable` during measurement — this is the same headless-YouTube-error/auto-advance/rate-limit interaction the Dev's report documents as sandbox-only friction (real playback isn't attempted headless), reproduced independently here, and unrelated to `tv.module.css`.

## CI-verified-green

This repo has no `scripts/verify-green-local.sh` (confirmed absent, same as the Dev noted) — its gate chain is `npm test` / `npm run test:e2e` / the ES2019 bundle check / `scripts/check-css-target.mjs`, all reported green with verbatim output in the Dev's report (`work/reports/dev/TICKET-109-dev-report.md`, final clean run `110 passed` on port 3098). Not independently re-run in full here (would race the same drain/port issues for no new signal) — the App Tester's own live measurements above are the additional, independent confirmation this gate exists to provide.

## Friction

- Confirmed the Dev's "seed 20-30 + capture in one burst" technique is necessary, not overcautious — a single extra tool round-trip (one `browser_evaluate` call) between seed and measurement was enough to lose the state once. Worth feeding into a skill-improvement note for `run-app`/`capture-screenshots`: when a product's dev-mode queue self-drains this fast, the capture skill's "warm then work in one burst" guidance should explicitly say "no more than one tool call between seed and capture."
- Playwright MCP's file-write allowlist is scoped to the framework repo's own root (`agentic-software-house`), not the boraoke worktree passed as an additional working directory — screenshots had to be written to `.playwright-mcp/` in the framework repo first, then copied via `Bash`/`cp` into the ticket's `EVIDENCE_DIR`. Not a defect in this ticket, just noting the mechanical extra step for the next tester using an additional working directory.

## Evidence index

All at `work/evidence/TICKET-109/` (App Tester captures, this gate):

| File | What it shows / proves |
|---|---|
| `apptester-normal-720p.png` | Normal state at 1280x720; join card clear, no chrome/join collision. |
| `apptester-normal-1080p.png` | Normal state at 1920x1080 with rail + visible "Pular"/"Tela cheia" chrome buttons and the join card simultaneously — primary visual proof of the fix at the resolution the bug was filed against. |
| `apptester-normal-4k.png` | Normal state at 3840x2160; same clean gap, confirms vw-scaling holds at the high end. |
| `apptester-focus-1080p.png` | Focus state at 1920x1080; video ~93% of viewport, QR over/near video, no visible chrome — confirms focus is unaffected. |

Plus the Dev's own `before-normal-*` / `after-normal-*` / `before-focus-1080p` / `after-focus-1080p` captures already committed alongside these, corroborating the same conclusions from an independent capture session.

## Design-fidelity pass (D-072)

No approved mockup exists for this specific padding change (the `tv.module.css` reference mockup is the general TV-scale reference from TICKET-18, not an approved artifact for this ticket's fix) — design-parity pass skipped, noted explicitly per house process.
