# TICKET-82 — Reviewer report (D-022 opus gate)

- **Branch:** `ticket/82-tv-player-remount-blackscreen`
- **Base:** `93fc367` → **HEAD:** `81a7537`
- **Worktree:** `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-82`
- **Dev server:** port 3190, `ADVANCE_AUTH=enforce` (pre-existing, not restarted)
- **Verdict:** **APPROVE WITH NITS**

Everything below was re-derived and re-run in a clean context. The developer's account was read only *after* I derived the mechanism from the base commit, and every claim that mattered was independently re-proved.

---

## 1. Root cause — derived independently from `93fc367`

`new YT.Player(el)` does not render *into* `el`; the IFrame API **replaces** `el` in the DOM with its own `<iframe>`. At base, the node handed to the constructor was React-owned and lived **inside the `nowPlaying ? … : idle` branch**:

```jsx
{nowPlaying ? (
  <>
    <div className={styles.main}>
      <div className={styles.video}>
        <div ref={playerDivRef} id="yt-player" className={styles.playerHost} />
```

Two independent defects follow, and both are in the base code:

**(a) The reported black screen — an *idle transition* orphans the player.**
When the queue empties (`nowPlaying === null`), React unmounts that whole subtree and takes the YouTube `<iframe>` with it. `playerRef.current` is **not** cleared — the idle path only calls `stopVideo()` (base lines 380-390). When a patron then adds a song, `nowPlaying` becomes non-null, React mounts a *fresh, empty* host, and the player effect takes its `if (playerRef.current)` branch and calls `loadVideoById()` on a player object whose iframe is no longer in the document. Nothing renders. There is no recovery path — only a manual page refresh — which is exactly what the Tech Lead had to do.

**(b) The watchdog `recreate` rung was itself permanently broken at base.**
`recreate` does `player.destroy()` → `setPlayerEpoch(n+1)` → the effect re-runs and calls `new window.YT.Player(playerDivRef.current, …)`. But `playerDivRef.current` is the **original div**, which the API detached at the *first* creation and never gave back; `destroy()` removes the iframe and does not restore it. So from the second creation onward the constructor is handed a node with `parentNode === null`. The last-resort self-heal on an unattended kiosk could never produce a visible player. **The developer's claim on this point is correct** — verified by reading `93fc367` directly, not by trusting the write-up.

### Does this match the "every queue change remounts the player" hypothesis?

**No — the hypothesis is refuted.** I checked it explicitly:

- Adding a song while one is playing changes `queue` and re-renders, but `nowPlaying` stays non-null, so the `styles.main` subtree is **not** unmounted and React does not touch the div's fiber position. The up-next rail flip (`upcoming.length > 0`) is a *sibling* subtree.
- The effect re-runs, but with `currentVideoIdRef.current === nowVideoId` it returns immediately without touching the player.
- Empirically confirmed: the "queue update while playing" test **passes at base commit** (see §2).

**The precise trigger is narrower:** the head of the queue must go **empty** (`nowPlaying → null`, i.e. the show runs dry / the last song ends) and then be **refilled**. The unmount at the idle transition is what kills the iframe; the refill is what makes the failure visible. A queue change alone is harmless.

This is a materially different — and much easier to hit at a venue than it sounds: the last song ending is a routine event between sets.

---

## 2. Negative control — the regression test has teeth

Fix reverted, new tests kept:

```
git checkout 93fc367 -- components/tv/TvScreen.tsx components/tv/tv.module.css
PORT=3190 npx playwright test e2e/tv.spec.ts --grep "TICKET-82" --reporter=list
```

Output I personally observed:

```
Running 3 tests using 1 worker

  ✓  1 [chromium] › e2e/tv.spec.ts:462:7 › /tv › player survives a queue update while fullscreen — no remount, no black screen (TICKET-82) (6.4s)
  ✘  2 [chromium] › e2e/tv.spec.ts:505:7 › /tv › player survives the queue emptying and refilling — the reported black screen (TICKET-82) (8.2s)
  ✓  3 [chromium] › e2e/tv.spec.ts:550:7 › /tv › a real track change loads the new video in the SAME player (TICKET-82) (5.8s)

  1) … player survives the queue emptying and refilling — the reported black screen (TICKET-82)

    Error: expect(received).toBe(expected) // Object.is equality
    Expected: true
    Received: false

    > 530 |     expect.soft(idle.sameNode).toBe(true);

    Error: expect(received).toBe(expected) // Object.is equality
    Expected: true
    Received: false

    > 540 |     expect(after.sameNode).toBe(true);

  1 failed
  2 passed (1.4m)
```

Tree restored afterwards with `git checkout HEAD -- …`; **`git status --short` was empty** (verified, printed `STATUS_CLEAN_OK`).

### Which assertion actually catches the reported bug

`expect(after.sameNode).toBe(true)` at line 540 — the **node-identity** assertion after the refill. `idle.sameNode` at line 530 (soft) catches the earlier symptom: the iframe torn out at the idle transition. A mere *presence* check (`iframe exists`) would **not** have caught this: at base, post-refill there is no iframe at all, but a naive implementation that remounted a fresh player every time would also satisfy presence while reintroducing the flicker/fullscreen loss. Asserting identity against a node captured before the transition is the right shape.

### The `ORPHANED:` marker really fires

Line 540 is a hard assertion, so line 546 (`expect(after.loaded).toEqual(["oHg5SJYRHA0"])`) never executed in the run above. I did **not** take the developer's word for the marker: I temporarily downgraded lines 540-546 to `expect.soft` in the broken state and re-ran. Observed:

```
    Error: expect(received).toEqual(expected) // deep equality
    - Expected  - 1
    + Received  + 1

      Array [
    -   "oHg5SJYRHA0",
    +   "ORPHANED:oHg5SJYRHA0",
      ]

    > 544 |     expect.soft(after.loaded).toEqual(["oHg5SJYRHA0"]);
```

So the `isConnected` check inside the stub's `loadVideoById` is live and discriminating, and it independently confirms mechanism (a) above: a `loadVideoById` into a detached player. The spec file was restored immediately (`git checkout HEAD -- e2e/tv.spec.ts`); tree clean.

### Are the two always-green tests vacuous?

**No — they are legitimate guard rails, not blind tests, but they must not be read as proof of the fix.**

- Test 1 (queue update while fullscreen) passes at base **because the broad hypothesis is wrong** — a rail update genuinely never touched the player. Its value is forward-looking: it locks in that a future change (e.g. keying the video subtree, or moving the host under a re-rendering wrapper) cannot start remounting on queue churn.
- Test 3 (real track change) passes at base because `loadVideoById` on the live instance was already the behaviour. Its value is the *other half of the contract*: it prevents a "fix" that rebuilds the iframe per track, which would reintroduce flicker and fullscreen loss.

Both assert node identity and creation counts, so neither is tautological. The one caveat is N1 below.

---

## 3. Fixed state — green

```
PORT=3190 npx playwright test e2e/tv.spec.ts --grep "TICKET-82" --reporter=list
  ✓ 1 … queue update while fullscreen (12.5s)
  ✓ 2 … queue emptying and refilling (9.5s)
  ✓ 3 … real track change (5.7s)
  3 passed (1.0m)
```

---

## 4. Vacuous-test trap check — stub fidelity

The one behaviour that causes the bug is element replacement, and the stub is faithful to it:

```js
const iframe = document.createElement("iframe");
iframe.id = el.id; iframe.className = el.className;
el.parentNode!.replaceChild(iframe, el);
```

This is exactly what the real IFrame API does (synchronously, inside the constructor). Consequences I checked:

- **Could these tests pass against a broken implementation?** Test 2 cannot — it needs a node that is the *same object* before and after an idle round-trip, which is only achievable if the host is never unmounted. Test 1 and 3 could pass against a broken implementation, but only in the sense that they were already green at base; they are complementary guards, not the proof.
- **Could `ORPHANED:` silently not fire?** Only if the orphaned iframe stayed `isConnected`. Proved live above that it does fire, with the exact expected string.
- The stub's `getPlayerState()` returns `PLAYING` and `getCurrentTime()` advances monotonically, which deliberately keeps the stall ladder quiet — correct, so these tests measure the mount lifecycle and not watchdog noise. It also means these tests say nothing about the ladder (see N2).
- Independent corroboration: the committed evidence under `work/evidence/TICKET-82/` uses a separate script and a green/black paint panel; I opened `broken-03-after-adding-song.png` (solid black video panel, sidebar correctly reading "Song B") and `fixed-03-after-adding-song.png` (green `▶ PLAYING oHg5SJYRHA0`). The diagnostics JSONs match what I reproduced myself (`ORPHANED:oHg5SJYRHA0` / `iframePresent:false` vs `["oHg5SJYRHA0"]` / `sameNodeAsStep1:true`). Evidence is genuine, not decorative.

---

## 5. Correctness of the fix (kiosk safety)

| Concern | Finding |
|---|---|
| `components/tv/watchdog.ts` | **Untouched** (not in `git diff --name-only`). The `replay`/`reload`/`recreate`/`advance` state machine is byte-identical; `__tests__/tv-watchdog.test.ts` green. |
| `recreate` rung now produces a working player | **Yes.** `destroy()` → `playerRef=null`, `playerNodeRef=null`, epoch bump → effect create path builds a **fresh** `document.createElement("div")` target inside the still-mounted host and `host.replaceChildren(target)` clears the corpse. The constructor now always receives an attached node. This genuinely fixes defect (b). |
| Auto-advance on `ENDED` | Handler body unchanged (diff shows no edit inside `onStateChange`). |
| `onError` unplayable-skip | `isFatalPlayerError` → `skipUnplayable()` unchanged. `e2e/tv-watchdog.spec.ts` (onError 150 / 100 / non-fatal) green. |
| TICKET-46/62 self-heal reloads | `selfHealReload`, `clearSelfHealMarker`, the Layer-1 interval and the Layer-2 401 branch are all outside the diff. `e2e/advance-auth.spec.ts` 4/4 green. |
| Liveness guard — rebuild loop risk | Guard fires only when `playerNodeRef.current === null || !host.contains(node)`. In the healthy path the node is the iframe inside the host, so it never fires. Even in a pathological case it could only rebuild once per effect run, and the effect is gated on the if-changed `queue` write plus `playerEpoch` — there is no self-retriggering cycle (the create path does not bump the epoch). No tight loop reachable. See N3 for the one fragile assumption. |
| Liveness guard — destroying a healthy player | Cannot: `host.contains(iframe)` is true for the whole life of a live player, since React never touches the host's children (JSX renders it childless) and only the create path calls `replaceChildren`. |
| Player leaked on unmount | **Fixed, and this is new.** The `[]`-dep hygiene effect now calls `playerRef.current.destroy()` on unmount. At base the imperative player and its `postMessage` listeners outlived the component. Improvement, not a regression. |
| `display:none` on the parked player | `display:none` does **not** reload or re-src an iframe (unlike moving it in the DOM), so the player is genuinely parked. Audio cannot leak while hidden: the `!nowVideoId` branch calls `stopVideo()` and nulls `currentVideoIdRef`, which also silences the watchdog tick while parked. Correct. See N4 for the one behavioural edge. |
| React/imperative DOM coexistence | Safe: the host is rendered childless in JSX, so React never reconciles the children we insert imperatively. This is the standard pattern for third-party-owned nodes and is exactly why the fix works. |
| Hydration | The host renders empty server-side and is filled in an effect — no mismatch. |

---

## 6. CSS / TICKET-70 regression

`.mainHidden { display: none; }` is a single new rule, applied only to `.main` and only when `nowPlaying` is null. The up-next rail lives in a *different* subtree (`.rail`, still inside the `nowPlaying ?` branch) and is never reached by the new rule. The card's internal structure (`.who` on its own line, `.metaRow` sharing title + table badge) is untouched by the diff.

```
PORT=3190 npx playwright test e2e/tv.spec.ts --grep "TICKET-70" --reporter=list
  ✓ 1 … realistic Brazilian nicknames render in full on a long room slug (3.4s)
  ✓ 2 … an 11-char Brazilian nickname still fits at 1440x900 (2.1s)
  ✓ 3 … a pathologically long nickname degrades gracefully (1.9s)
  3 passed (40.7s)
```

No TICKET-70 regression.

---

## 7. Scope discipline

```
git diff --name-only 93fc367 HEAD
components/tv/TvScreen.tsx
components/tv/tv.module.css
e2e/tv.spec.ts
work/events/by-branch/ticket-82-tv-player-remount-blackscreen.jsonl
work/evidence/TICKET-82/…  (README + 6 png + 2 json)
```

**Clean.** None of the sibling-owned paths (`components/SongSearch.tsx`, `lib/youtube-search.ts`, `lib/search-cache.ts`, `app/api/search/**`, `app/page.tsx`, `app/globals.css`, `messages/*.json`, `components/feedback/**`, `work/design/**`) appear.

---

## 8. Other suites

- **Jest:** `npm test` → **44 suites / 757 tests passed**, 3.8s. Green.
- **`e2e/tv.spec.ts` + `e2e/tv-watchdog.spec.ts` + `e2e/advance-auth.spec.ts`:** 16/16 passed.
- **`e2e/render-and-links.spec.ts` + `e2e/rotation-modes.spec.ts`:** flaky, and I verified the flake is pre-existing rather than accepting the claim:
  - Run A (HEAD): 2 failed — `landing renders create CTA…` and `/[room]/admin: login → controls…` (`admin-analytics-link` count 1, expected 0).
  - Run B (**base code restored for the two tv files**): `render-and-links.spec.ts` **16/16 passed**.
  - Run C (HEAD again): 2 failed, but a **different pair** — `landing venue labels expose clean accessible names` and `/[room]/admin: logout control is absent on the login gate`.

  A failure set that changes between identical runs, and that clears on a run where nothing relevant changed, is non-deterministic host-session/in-memory-store bleed against a long-lived dev server — not a consequence of this diff, which cannot reach the landing or admin surfaces at all. **Pre-existing flake, confirmed by experiment.**

Final `git status --short`: empty.

---

## Findings

No blocking findings. Nits, in rough order of usefulness:

**N1 (low) — `isFullscreenElement` in test 1 is close to tautological.**
The stub installs `Object.defineProperty(document, "fullscreenElement", { get: () => document.querySelector("iframe[data-yt-instance]") })`. The getter re-queries on every read, so `document.fullscreenElement === node` is true whenever *any* marked iframe exists and `__tracked` points at it — it can never distinguish "fullscreen survived" from "an iframe exists". The real fullscreen guarantee in that test rests on `sameNode`, which is sound. Nothing to fix in the assertion logic; just don't read that line as fullscreen coverage. If you want genuine coverage, capture the fullscreen element at track time and compare object identity, or drop the assertion and let the comment carry the intent.

**N2 (medium, follow-up) — the `recreate` rung still has no regression test.**
Defect (b) is the more alarming of the two: on an unattended kiosk, the last-resort self-heal was silently a permanent black screen, and *nothing in the suite would have told us*. `__tests__/tv-watchdog.test.ts` covers the pure state machine only, and `e2e/tv-watchdog.spec.ts` covers just the `onError` paths. The TICKET-82 stub deliberately keeps the ladder quiet, so it does not exercise `recreate` either. The fix is correct by construction, but the defect class ("a self-heal rung that heals into nothing") is exactly the one this product has already shipped twice. Suggested follow-up: a test whose stub freezes `getCurrentTime()` until the ladder reaches `recreate`, then asserts `__ytDestroyed === 1`, `__ytCreated === 2`, and that a **new, connected** `iframe[data-yt-instance]` is inside the host. Not blocking this PR.

**N3 (low) — `playerNodeRef.current = host.firstElementChild` assumes a synchronous replace.**
True of today's IFrame API (the constructor replaces the element before returning), so the guard is correct as written. But if that ever changed, `playerNodeRef` would capture the *target* div, the API would later swap it out, and the liveness guard would then destroy-and-rebuild the player on every queue change (bounded, not a tight loop, but visible churn on the venue TV). Cheap hardening: prefer `player.getIframe?.() ?? host.firstElementChild`, or treat "the target div is still the host's only child" as live rather than orphaned.

**N4 (low) — `display: none` at the idle transition will drop a fullscreen player out of fullscreen.**
An element inside a `display: none` ancestor is not rendered, and browsers exit fullscreen in that situation. So if the venue is in YouTube's own iframe fullscreen and the queue runs dry, the screen leaves fullscreen when the idle poster appears. This is **strictly better than base** (which lost fullscreen *and* black-screened permanently), and arguably desirable — you want the recruitment poster visible when idle. Flagging it only so it is a known, chosen behaviour rather than a surprise at the next venue night. If fullscreen-across-idle turns out to matter, park with zero-size + `visibility: hidden` + `pointer-events: none` instead of `display: none`.

**N5 (info) — `#yt-player` / `.playerHost` are now applied imperatively.** Any selector depending on them still resolves; `render-and-links.spec.ts › /[room]/tv renders the YT iframe host with a seeded queue` passes at HEAD.

---

## Verdict

**APPROVE WITH NITS** (N1–N5; only N2 is worth a follow-up ticket, none are blocking).

The diagnosis is correct and I re-derived it independently; the stated hypothesis ("any queue change remounts the player") is genuinely refuted and the narrower trigger (empty-queue idle transition, then refill) is the real one. The fix is structural rather than a patch over the symptom, it repairs a second latent kiosk-critical defect (`recreate`) as a side effect, it plugs a player leak on unmount, and it leaves the watchdog ladder, auto-advance, unplayable-skip and self-heal paths behaviourally untouched. The regression test has real teeth: it fails on the exact assertion that encodes the bug, and the `ORPHANED:` discriminator was proved live rather than assumed. Scope is clean and TICKET-70 is not regressed.
