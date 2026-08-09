# TICKET-72 — Reviewer gate (independent, clean context)

- **Verdict: REQUEST-CHANGES**
- **Branch:** `ticket/72-feedback-discoverability` · base `a2c47bc` (= origin/main) · worktree `.worktrees/ticket-72` · port 3184
- **Date:** 2026-08-08
- **Reviewer stance:** I inherited no prior verdict. I read TICKET-71's ticket and its review (including the refutation of the first `position: fixed` + per-frame-JS attempt), read this ticket's own first-pass clipping defect, then re-verified every load-bearing claim with my own probes. I did not trust the ticket doc, the code comments, or the App Tester report. Where the App Tester's methodology and mine diverge, I say so.

**Headline:** the *design* is correct and holds up under adversarial probing — 8,820 geometric checks, zero overlaps, structurally confirmed at the CSS level, no per-frame measurement anywhere. But the branch **fails the e2e gate deterministically** where base passes, for a reason nobody caught because both the Dev and the App Tester only ever ran the spec file in isolation. That is a blocker, and it is a small fix.

---

## Gates run (all by me, in this worktree, foreground)

| Gate | Result |
| --- | --- |
| `npm test` (jest) | **PASS** — 43 suites, **683/683**, 1.6s |
| `npx tsc --noEmit` | 2230 lines of output, **all pre-existing baseline noise** (undeclared jest/playwright globals; repo has no `typecheck` script, so tsc-clean is not a project gate). **0** lines mention `FeedbackWidget.tsx`, `FeedbackWidget.module.css`, `PatronRoom.tsx` or `feedback-widget-safe-area.spec.ts`. Matches the TICKET-71 baseline exactly. Not a regression. |
| `npm run build` | **PASS** — clean Next production build, exit 0 (run with port 3184 dead and `.next` wiped, per the operational warning) |
| `PORT=3184 npx playwright test` (FULL suite, foreground) | **FAIL — 78 passed / 2 failed.** Reproduced twice, byte-identical failures. See F1. |
| Same full suite on **base `a2c47bc`** | **PASS — 77/77.** The regression is introduced by this branch. |
| `PORT=3184 npx playwright test feedback-widget-safe-area` (spec file **alone**) | PASS — 8/8. This is the run the Dev and App Tester did, and it is why the failure was missed. |

---

## F1 (BLOCKER) — the branch turns the full e2e suite red; base is green

Deterministic, reproduced on two consecutive clean runs (`rm -rf .next test-results` before each):

```
✘ 27 e2e/feedback-widget-safe-area.spec.ts:293 › TICKET-72 — header trigger is visible without scrolling AND never overlaps a 25-row queue
    expect(getByTestId('queue-row')).toHaveCount(25) → Received: 19
✘ 30 e2e/feedback-widget-safe-area.spec.ts:448 › desktop: no dead space is introduced at the bottom of the page, pill stays fixed
    expect(getByTestId('queue-row')).toHaveCount(3)  → Received: 0
  2 failed, 78 passed (3.7m)
```

Note the second failure is a **pre-existing TICKET-71 test**, not a new one — this branch breaks previously-green coverage.

**Root cause, proven not guessed.** `lib/queue-rate-limit.ts` enforces `RATE_IP_MAX = 60` submits per IP per 60 s window. The whole e2e suite POSTs `/api/queue` from one IP (127.0.0.1). Before this branch, `feedback-widget-safe-area.spec.ts` seeded 25 + 5 + 5 + 3 = **38** rows. The new TICKET-72 patron-room test seeds **25 more** into its own never-drained room, taking the file to **63** — and in the full suite, earlier spec files have already spent part of the same shared 60 s IP bucket. The seeds then get 429'd mid-flight: the new test starves its *own* seed (19 of 25 land) and exhausts what is left for the later desktop test (0 of 3).

**Proof of the mechanism:** I temporarily raised `RATE_IP_MAX` from 60 to 600 (nothing else changed) and re-ran the full suite:

```
80 passed (3.4m)     ← same branch, only the IP cap raised
```

Restored immediately; `git status` clean. So the product code is fine and the *test seeding budget* is the defect. 78+2 = 80 = the 77 base tests + this branch's 3 new ones, all of which pass once the budget allows.

**Why this slipped:** the App Tester's report states "Full regression suite (`e2e/feedback-widget-safe-area.spec.ts`, all 8 tests): 8 passed … No regressions." That is a single-file run. It cannot observe a cross-file shared-rate-limit budget. The house gate is the full suite; the file-scoped run is not a substitute for it. This is the same shape of error as the ticket's own history — a check scoped narrowly enough to avoid its own failure mode.

**Suggested fixes (Dev's call):**
1. Have the new test reuse the room the existing 25-row test already seeded, instead of seeding a second 25-row room (net +0 submits); or
2. Seed the long queue through a non-rate-limited path (a test-only seeding helper / direct store write), which is the durable fix for the whole file; or
3. Drop the new test's seed count to what it actually needs to push the pill off-screen (the assertion is only `pillY > 844`), and re-run the FULL suite to confirm the budget holds.

Whichever is chosen, **the acceptance evidence must be a full-suite run**, not a `-g`/single-file run.

---

## 1. My own sweep — harder than the committed spec (mandate item 1)

Throwaway probe `e2e/zz-reviewer-probe.spec.ts` — written, run, then deleted (tree verified clean, `test-results/` removed).

- **35 queue rows** (spec: 25) in a dedicated room.
- **21 scroll positions**, every 5% from 0.00 to 1.00 (spec: 5 fractions).
- **Realistic long nickname** `MariaFernandaSilva` (18 chars) — the header's content is what broke the first pass, and a short nickname hides the defect.
- **Both widths**: 390x844 and 320x844.
- **Both affordances** (`feedback-header-trigger` AND the "Enviar feedback" pill) intersected against **three** boxes per row: `queue-row-title`, `queue-row-badge`, **and the whole `queue-row` `<li>`** (the committed spec only checks title+badge; an affordance covering row chrome but missing both would slip past it).

35 rows x 21 positions x 3 boxes x 2 affordances x 2 widths:

| Run | Checks | Overlaps |
| --- | --- | --- |
| **Branch (HEAD)** | **8,820** | **0** |
| **Base `a2c47bc`** (impl files reverted) | 4,410 | 0 — and `feedback-header-trigger` **count = 0**, i.e. the affordance does not exist |
| **Branch, trigger forced to `position: fixed`** (negative control) | 8,820 | **89** |

Page geometry was real, not a synthetic short page: `scrollHeight` 3320 / `maxScroll` 2476 at 390px; 3351 / 2507 at 320px.

The base run is the honest delta: base has **half** the checks because there is only one affordance to check — the discoverability delta is "the entry point does not exist at all" rather than "it overlaps". The **non-vacuity proof** is therefore the forced-fixed control: identical 8,820 checks, **89 overlaps**, first hit at `w=390 frac=0.00 trigger x row1.li`. My sweep is not vacuous — it fails loudly when the geometry is wrong.

## 2. Structural claim confirmed at the CSS level (mandate item 2)

`getComputedStyle(el).position` read directly, not inferred from absence of overlap.

| Width | `feedback-header-trigger` | pill | trigger `display` |
| --- | --- | --- | --- |
| 320 | `static` | `static` | `flex` |
| 390 | `static` | `static` | `flex` |
| 640 | `static` | `static` | `flex` |
| **699** | `static` | `static` | `flex` |
| **700** | `static` | `static` | `flex` |
| **701** | `static` | **`fixed`** | **`none`** |
| 760 | `static` | `fixed` | `none` |
| 1280 | `static` | `fixed` | `none` |

Clean switchover at exactly 700/701. **No gap** (no width where the trigger is neither shown nor hidden) and **no double-application** (no width where the mobile pill and the fixed pill both float). The element is always present in the DOM on desktop and hidden by CSS — the committed desktop test asserts this correctly rather than relying on the element being absent.

## 3. No per-frame runtime measurement (mandate item 3)

I grepped every added line in `components/**` and `PatronRoom.tsx` for `scrollY`, `scrollTop`, `getBoundingClientRect`, `requestAnimationFrame`, `addEventListener`, `IntersectionObserver`, `ResizeObserver`, `offsetTop`, `clientHeight`. **Every hit is inside a prose comment.** The only runtime APIs the diff adds are `MutationObserver`, `document.querySelector` and `document.contains`. The one `addEventListener` in the file is the pre-existing Escape handler. There is no scroll listener, no resize listener, no rAF loop, no geometry read anywhere in the feedback path. The v1 failure mode is structurally absent, not merely absent by luck.

**On the `MutationObserver` — I judge it (a) benign, and I measured it.** I instrumented `window.MutationObserver` with a counting subclass via `addInitScript` and loaded a 35-row patron room:

```
after page load:  { instances: 3, callbacks: 5, records: 17 }
after +30s live:  { instances: 3, callbacks: 5, records: 17 }
```

Zero additional invocations over 30 s on a live, polling queue page — React does not touch the DOM when the polled queue payload is unchanged, so the observer simply never fires at rest. Even when it does fire, the callback is `document.contains(current)` + early return: no layout read, no forced synchronous reflow. This is categorically different from v1's `getBoundingClientRect`-per-scroll loop, which thrashed layout by construction. Not a hazard. (One nitpick recorded as F4 below.)

## 4. The new tests have teeth (mandate item 4)

**(a) Revert the implementation → tests go red.** Reverted `FeedbackWidget.tsx`, `FeedbackWidget.module.css` and `PatronRoom.tsx` to `a2c47bc`, kept the new spec, re-ran the file:

- Test 5 (`TICKET-72 — header trigger visible without scrolling…`): **RED** — `expect(trigger).toBeVisible()` / element not found (spec:334)
- Test 6 (`TICKET-72 — landing page…`): **RED** — element not found (spec:420)
- Test 7 (`TICKET-72 — desktop keeps only the fixed pill…`): **RED** — `toHaveCount(1)` failed (spec:440)

All three new tests fail without the implementation. (Two TICKET-71 tests also went red in that run, but with `toHaveCount` seeding errors — the same F1 rate-limit budget effect, not a signal about the revert.)

**(b) Does the geometric sweep catch a `position: fixed` re-implementation *with the CSS-level assertion disabled*?** I patched `.headerTrigger` to `position: fixed; right: 16px; bottom: 16px; z-index: 60` **and** commented out both `expect(...position).toBe("static")` assertions, leaving only the bounding-box sweep. Result:

```
✘ TICKET-72 — header trigger … never overlaps a 25-row queue
    Error: row 1 badge overlaps the header trigger   (spec:396)
✓ TICKET-72 — landing page: header trigger is on screen …
✓ TICKET-72 — desktop keeps only the fixed pill …
```

**The patron-room geometric sweep has genuine teeth** — it catches a fixed re-implementation on pure geometry, with no help from the CSS assertion. That is the assertion the v1 refutation would have needed, and it is present and working. See F3 for the landing-page test, which does not.

All patches reverted with `git checkout HEAD -- …`; tree verified clean.

## 5. The TICKET-71 tests were not weakened (mandate item 5)

`git diff a2c47bc..HEAD --numstat -- e2e/feedback-widget-safe-area.spec.ts` → **`169  0`**. One hundred sixty-nine lines added, **zero deleted**. The change is purely additive: the five pre-existing tests are byte-identical, nothing skipped, nothing loosened, nothing rewritten to accommodate the new code. Confirmed by reading the diff hunk — the entire insertion sits between the existing pending-approval test and the existing desktop test.

## 6. Discoverability actually delivered (mandate item 6)

Feedback is reachable with **zero scrolling** on both pages at both widths. Measured at scroll 0 on a 35-row room:

| Page | Width | Trigger box | Fully in viewport (both axes) | `<header>` h-overflow |
| --- | --- | --- | --- | --- |
| Patron room | 390 | x 334→374, y 69→109 | **yes** | 0 |
| Patron room | 320 | x 264→304, y 69→109 | **yes** | 0 |
| Landing | 390 | x 330→370, y 58→98 | **yes** | 0 |
| Landing | 320 | x 260→300, y 105→145 | **yes** | 13–16 (see F5) |

Tap target is a real 40x40 in every case, not a 0px "technically present" element.

**I hunted for another viewport/content combination that breaks it, as instructed — and did not find one.** Swept the patron room across **3 locales x 3 nickname lengths x 2 widths = 18 combinations**:

- Locales `en` / `es` / `pt-BR` (via the `NEXT_LOCALE` cookie, which is exactly how `i18n/request.ts` resolves locale — a longer translated greeting was a plausible re-break vector).
- Nicknames: 18 chars (`MariaFernandaSilva`), 25 chars unbroken (`Wolfeschlegelsteinhausenb`), and **30 chars unbroken** (`ABCDEFGHIJKLMNOPQRSTUVWXYZ0123`) — the DB field maximum, and a single unbroken token, which is the worst case for the ellipsis path the App Tester noted was never actually exercised.

**All 18: trigger fully inside the viewport, `<header>` horizontal overflow 0, and `documentElement` horizontal overflow 0.** The header degrades by wrapping (trigger drops to `y 112→152` in the tight cases) rather than by clipping. The App Tester's stress case stopped at 24 chars; I pushed to the 30-char field limit and the fix still holds. This is genuinely robust, not tuned to the one string the spec uses.

Notably, the base patron header **already overflowed 50px at 320px** before this ticket (my base probe: `headerOverflow: 50` at w=320, with no trigger present at all). This branch's header loosening takes that to **0** — it fixes a latent pre-existing overflow rather than merely accommodating its own new child. Credit where due.

**Sheet opens:** the committed test clicks the trigger and asserts `getByRole("dialog")` visible; it passes in the isolated 8/8 run. Verified, not assumed.

## 7. Desktop regression (mandate item 7)

Genuinely untouched. At 701 / 760 / 1280 the trigger is `display: none` (present in DOM, hidden by CSS) and the pill is `position: fixed`. The pre-existing desktop dead-space test is unmodified and passes in isolation. The desktop code path has no new JS behaviour — the portal renders a button the desktop CSS never displays.

## 8. Scope discipline (mandate item 8)

`git diff a2c47bc..HEAD --name-only` — **clean, nothing outside the allowed set**:

- `components/FeedbackWidget.tsx`, `components/feedback/FeedbackWidget.module.css`, `app/(patron)/[room]/PatronRoom.tsx`, `e2e/feedback-widget-safe-area.spec.ts`
- `work/**` only: `work/events/by-branch/…jsonl`, `work/evidence/TICKET-72/**` (37 files), `work/reports/testing/TICKET-72-apptest.md`, `work/tickets/TICKET-72-…md`

Sibling-owned files explicitly checked and **untouched**: `app/page.tsx`, `app/metadata.ts`, `app/globals.css`, `components/tv/**`, `messages/*.json`. Zero files outside the boundary.

---

## Findings

### F1 (BLOCKER) — full e2e suite goes red; base is green

See the dedicated section above. `78 passed / 2 failed` on the branch vs `77/77` on base, reproduced twice, root-caused to the `RATE_IP_MAX = 60` submits-per-IP-per-60s budget and **proven** by a controlled re-run at 600 (`80 passed`). One of the two failures is a pre-existing TICKET-71 test. Must be fixed and re-verified **with a full-suite run** before merge.

### F2 (MEDIUM, process) — the acceptance evidence on this branch was gathered file-scoped

Both the Dev and the App Tester validated with `playwright test feedback-widget-safe-area` (or `-g`). That run is 8/8 green and structurally incapable of observing F1. The App Tester's report states "No regressions found anywhere else in the suite" on the strength of a single-file run — that claim is not supported by what was executed. Worth a house-level guardrail: **an App Tester PASS on a spec that seeds data must include a full-suite run**, because this repo has cross-file shared rate-limit budgets and a shared in-memory store singleton (both documented in the code) that make single-file green a weak signal. Related class-level fix: give the e2e suite a seeding helper that bypasses the submit rate limiter, so adding queue-heavy coverage stops silently spending a global budget.

### F3 (LOW) — the landing-page test's teeth depend entirely on its CSS assertion

In teeth-proof (b), with `position` assertions disabled and the trigger forced to fixed bottom-right, the **patron-room** test failed on pure geometry (`row 1 badge overlaps the header trigger`) but the **landing-page** test still **passed**. It only checks viewport containment, never intersection with landing content — so if someone later deletes or weakens the one-line `position` assertion in that test, a fixed re-implementation sails through it. Cheap hardening: give the landing test the same intersection sweep against its CTAs, or at minimum leave a comment saying the CSS assertion is load-bearing there. Not a blocker (the patron-room test is the strong one and it holds).

### F4 (LOW) — the MutationObserver's fallback path re-queries the whole document per mutation batch

`sync()` early-returns via `document.contains(current)` **only when a header has already been found**. Before that — e.g. the patron room's nickname gate, which renders no `<header>` — `current` is `null`, so every mutation batch on `document.body` runs a fresh `document.querySelector("header")`. It is cheap and layout-free, and the nickname gate has almost no churn, so I measured no cost. But the guard's short-circuit is one-sided; a page that churns heavily while having no header would pay a full-document query per batch. Optional tidy-up, not a defect today. (This is a nitpick on an otherwise well-judged mechanism — the design is right.)

### F5 (LOW) — the landing `<header>` reports 13–16px of horizontal overflow at 320px

`header.scrollWidth - header.clientWidth` = 16 (pt-BR), 13 (es) at width 320, across all three locales, on the branch. The trigger itself is fully inside the viewport (x 260→300) and the patron room's document-level overflow is 0, so nothing is visibly clipped and no page-level horizontal scroll appears. **I did not measure this on base**, so I cannot say whether the trigger caused it or it predates this branch — flagging it honestly rather than claiming either. Worth a one-line check when F1 is fixed.

### F6 (LOW) — the portal selector is global (`document.querySelector("header")`); the admin surface is an unverified third target

The portal target is "the first `<header>` on the page", app-wide. The app has three: `app/page.tsx`, `PatronRoom.tsx`, and **`app/(patron)/[room]/admin/AdminRoom.tsx`** (line 325). Only the first two are covered by the ticket, the evidence and the spec. I probed `/{room}/admin` at 390 / 320 / 1280 and found **no `<header>` in the DOM and trigger count 0** at the state my probe reached (the host-auth gate), so nothing is injected there in practice on that path — but a genuinely logged-in host on a phone would get the trigger portalled into a header that this ticket never loosened or measured. That is probably *desirable* (feedback from the host surface), just unverified. Cheap follow-up: either add an admin-room assertion, or scope the selector so the injection site is explicit rather than incidental.

### F7 (INFO) — inherited TICKET-71 findings still open

The TICKET-71 review's F1 (safe-area spacer rendered on the wrong side of the pill), F2 (`viewportFit: "cover"` missing, so `env(safe-area-inset-*)` is inert in production), and F4 (dead `--pill-gap` token, stale CSS prose) are all still present on this branch. Out of scope here — noting only so they are not assumed fixed.

---

## Assessment

The engineering judgment on this ticket is good, and I want to be explicit about that because the verdict is a blocker. The team was asked to restore discoverability without re-introducing the overlap, and the obvious move — a smaller fixed button — was **rejected on measurement rather than on principle**, with a footprint table showing a 40px circle still lands 16 intersections on a 35-row room. The chosen answer (a second in-flow affordance at the *other* end of the page) carries the same geometric guarantee as TICKET-71 by construction, and my own harder sweep confirms it: 8,820 checks, zero overlaps, `position: static` read directly at the CSS level, a clean 700/701 breakpoint with no gap and no double-application, and 89 overlaps the moment I force the trigger to `fixed` — so the probe is not vacuous. There is no per-frame measurement anywhere; the `MutationObserver` is genuinely benign DOM-presence detection (5 callbacks at load, still 5 after 30 s live) and reads no geometry. The first-pass clipping defect is properly fixed, and I could not break it across 18 locale x nickname-length x width combinations including a 30-char unbroken nickname at 320px — past where the App Tester stopped. The pre-existing TICKET-71 coverage is untouched (169 added, 0 deleted) and the patron-room sweep has proven teeth against a fixed re-implementation even with its CSS assertion disabled.

What blocks it is not the design. It is that **the branch's full e2e suite is red where base is green**, deterministically, twice, because the new test's 25 extra seeded submits blow a shared per-IP rate-limit budget — starving its own seed and a previously-green TICKET-71 test. Both the Dev and the App Tester validated file-scoped, which cannot see it. The fix is small (reuse the existing seeded room, or seed via a non-rate-limited path), but the gate is the gate, and this ticket's own history is a history of narrow checks that avoided their own failure mode. I am not going to pass a red suite on the argument that the failing assertions are "only" about seeding.

Fix F1, re-run the **full** suite, and this is an approve. F3/F4/F5/F6 are cheap follow-ups, none blocking.

**REQUEST-CHANGES.**
