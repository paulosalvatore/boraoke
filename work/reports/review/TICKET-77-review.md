# TICKET-77 — Reviewer gate report (FULL re-review: analytics link + host logout)

**Verdict: APPROVE — conditional on one blocking delivery action (commit + push; see §1).**

This review **supersedes and overwrites** the earlier APPROVE that covered the analytics-link scope only. It is the review of record for **both** the analytics discoverability link **and** the host logout control, reviewed together.

- Repo: `boraoke` (live at boraoke.com)
- Worktree: `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-77`
- Branch: `ticket/77-analytics-discoverability`
- Merge-base with `origin/main`: `a2c47bcf87eb4f55a126b6e0cdae2c30c1b2d672`
- Review date: 2026-08-08
- Reviewer context: clean, no prior context; every claim below was independently re-verified from scratch. No dev-reported numbers were trusted or reused.

---

## 1. BLOCKING (delivery, not code): the entire logout scope is uncommitted, and no PR exists

This is the one item standing between this ticket and merge. The **code is correct** — everything in §3–§10 below passes — but the reviewed work is **not in any deliverable artifact**.

```
$ git status --porcelain
 M app/(patron)/[room]/admin/AdminRoom.tsx
 M app/(patron)/[room]/admin/admin.module.css
 M e2e/render-and-links.spec.ts
 M work/evidence/TICKET-77/authorised-1440.png
 M work/evidence/TICKET-77/authorised-390.png
 M work/evidence/TICKET-77/unauthorised-1440.png
 M work/evidence/TICKET-77/unauthorised-390.png
 M work/tickets/TICKET-77-analytics-discoverability.md
?? work/evidence/TICKET-77/after-logout-gate-1440.png
?? work/evidence/TICKET-77/logout-confirm-1440.png
```

Splitting committed from uncommitted:

```
$ git diff a2c47bc HEAD --stat        # what is COMMITTED on the branch
 app/(patron)/[room]/admin/AdminRoom.tsx            |  41 ++++++
 e2e/render-and-links.spec.ts                       |  28 +++++
 ... (analytics link only)

$ git diff HEAD --stat                # what is UNCOMMITTED in the working tree
 app/(patron)/[room]/admin/AdminRoom.tsx            |  65 +++++++++++++++++
 app/(patron)/[room]/admin/admin.module.css         |  13 ++++
 e2e/render-and-links.spec.ts                       |  79 +++++++++++++++++
 ... (the ENTIRE logout scope)
```

And there is no PR at all:

```
$ gh pr list --head ticket/77-analytics-discoverability --json number,title,state,isDraft
[]
```

So: the committed branch contains **only** the analytics link. 100% of the logout control — implementation, CSS, all 3 new e2e tests, and the two new evidence screenshots — exists solely as uncommitted working-tree state. Sibling PR #53 (TICKET-76) is blocked on the logout control shipping; as things stand, nothing that would unblock it has been delivered.

**Required before merge (mechanical, no code change):**

1. Commit the logout scope (via the `commit` skill, explicit file list) — the three source files, both new screenshots, the four updated screenshots, and the ticket file.
2. Push the branch and open the PR.
3. Re-verify the pushed content is byte-identical to what I reviewed. SHA-256 of the exact working-tree content this review covers:

```
624b0e077b099fce0ce0001364fc2e0e53f0ac6b19d4e167dd712e23425b23fb  app/(patron)/[room]/admin/AdminRoom.tsx
cb1eca3b9a9500e5b98b3c9d54abab0bf352bce4a96cea2a7f8eac147005535f  app/(patron)/[room]/admin/admin.module.css
8747ce868923719720193636de33e96340cf7f8df534915649810dc0cb8adf3d  e2e/render-and-links.spec.ts
```

If the pushed content matches those hashes, this APPROVE stands with no re-review needed. If any of it changes, the changed part needs a fresh pass.

Also note the branch is 2 commits behind `origin/main` (`git rev-list --left-right --count origin/main...HEAD` → `2  4`). Not a defect and not blocking — the GitHub PR diff is computed from the merge-base, so it will render correctly — but a rebase/merge before merging keeps the diff honest. This is also why a naive `git diff origin/main --stat` misleadingly shows ~40 files: those extras are reverse-deltas of main's two newer commits (TICKET-74/75), **not** changes made by this branch. All scope analysis below is correctly computed against the merge-base.

---

## 2. Scope / boundary check — PASS, zero violations

Complete set of paths touched vs merge-base, committed **and** uncommitted combined:

```
app/(patron)/[room]/admin/AdminRoom.tsx
app/(patron)/[room]/admin/admin.module.css
e2e/render-and-links.spec.ts
work/events/by-branch/ticket-77-analytics-discoverability.jsonl
work/evidence/TICKET-77/after-logout-gate-1440.png
work/evidence/TICKET-77/authorised-1440.png
work/evidence/TICKET-77/authorised-390.png
work/evidence/TICKET-77/logout-confirm-1440.png
work/evidence/TICKET-77/unauthorised-1440.png
work/evidence/TICKET-77/unauthorised-390.png
work/reports/review/TICKET-77-review.md
work/tickets/TICKET-77-analytics-discoverability.md
```

That is exactly the allowed set: the three source files, `work/tickets/TICKET-77-*.md`, `work/evidence/TICKET-77/*`, the review report, plus the benign machine-generated `work/events/by-branch/*` log. Nothing else.

Every forbidden path verified untouched (checked against both the committed diff and the working tree):

| Path | Status |
| --- | --- |
| `messages/en.json` | clean |
| `messages/es.json` | clean |
| `messages/pt-BR.json` | clean |
| `app/admin/analytics/**` | clean |
| `app/api/host/analytics/route.ts` | clean |
| `lib/host-auth.ts` | clean |
| `app/api/host/session/route.ts` | clean |
| `components/SavedRooms.tsx` | clean |
| `lib/rooms.ts` | clean |
| `app/api/rooms/route.ts` | clean |
| `app/(patron)/[room]/tv/page.tsx` | clean |
| `components/FeedbackWidget.tsx` | clean |
| `components/feedback/**` | clean |
| `app/page.tsx` | clean |
| `app/globals.css` | clean |
| `app/layout.tsx` | clean |

The i18n boundary is respected in particular: no `messages/*.json` file is touched, consistent with the stated constraint that a sibling agent owns those this cycle.

## 3. Auth-weakening check — PASS

`app/api/host/session/route.ts` is **completely untouched** — confirmed by diff against merge-base and by `git status`. The dev calls the pre-existing `POST /api/host/session` endpoint; no auth code, no session code, and no token-resolution code (`lib/host-auth.ts` likewise untouched) was modified. There is no auth-surface change in this ticket. The only new network call is a `POST` to an endpoint that already existed and already had its own server-side authorization.

Worth stating explicitly since it is the security point of the ticket: this change **adds** a way to end a session. It removes none. The previously-dead `POST /api/host/session` gains its first caller.

## 4. Gates re-run from scratch (real output)

### `npm test` (jest) — PASS

```
Test Suites: 43 passed, 43 total
Tests:       683 passed, 683 total
Snapshots:   0 total
Time:        1.339 s, estimated 2 s
Ran all test suites.
```

### `npx tsc --noEmit` — delta 0, PASS

The repo has a large pre-existing error baseline (missing `@types/jest`, so every `describe`/`it`/`expect` in `__tests__/` errors). I measured the delta myself rather than reading the absolute number, by checking out the merge-base into a throwaway detached worktree sharing this worktree's `node_modules`:

```
branch (ticket/77):                   2190 errors
merge-base a2c47bc:                   2190 errors
                            delta =      0
```

For completeness, `origin/main` tip reports 2314 — *higher* than the branch, purely because main's two newer commits added test files that inherit the same pre-existing `@types/jest` gap. The merge-base comparison above is the fair one.

Additionally, zero errors reference any changed file:

```
$ npx tsc --noEmit 2>&1 | grep -E "AdminRoom|render-and-links|admin.module"
NONE
```

### `npm run build` — PASS

Next build completed successfully; full route table emitted, including `ƒ /api/host/session`. No errors, no type failures, no new warnings attributable to this change.

### Full e2e: `PORT=3199 npx playwright test --reporter=list` — PASS, 81/81

Run in the foreground on port 3199 to avoid the dev's leftover state on 3189. Completed in 3.4m.

```
  81 passed (3.4m)
```

All four new tests pass (three of them logout):

```
✓ 52 › render-and-links.spec.ts:304 › /[room]/admin: HOST_TOKEN-authed session (default room) shows the Analytics link (2.7s)
✓ 53 › render-and-links.spec.ts:320 › /[room]/admin: logout control is absent on the login gate (unauthenticated) (3.2s)
✓ 54 › render-and-links.spec.ts:331 › /[room]/admin: logout control clears the session on the wire (confirm → 401 on re-probe) (3.2s)
✓ 55 › render-and-links.spec.ts:367 › /[room]/admin: logout negative control — a failed clear leaves the host authed (3.2s)
```

Zero failures, zero flakes, zero skips across the whole suite. The pre-existing contrast, TV, moderation, identity, and search suites are all unaffected.

## 5. Wire-level claim is real, not asserted — CONFIRMED

I read the body of `logout control clears the session on the wire` myself. It genuinely probes the API on both sides of the action rather than inspecting DOM state:

```ts
// Sanity: session is genuinely live before we touch logout.
const preRes = await page.request.get(`/api/host/session?room=${id}`);
expect(preRes.status()).toBe(200);
...
await logoutBtn.click();
const confirmGroup = page.getByTestId("admin-logout-confirm");
await expect(confirmGroup).toBeVisible();
// Pre-confirm: session must still be untouched.
expect((await page.request.get(`/api/host/session?room=${id}`)).status()).toBe(200);

await confirmGroup.getByRole("button", { name: /^confirmar$/i }).click();

await expect(token).toBeVisible();
// ...and the session is genuinely dead server-side, not just hidden in the UI.
const postRes = await page.request.get(`/api/host/session?room=${id}`);
expect(postRes.status()).toBe(401);
```

This is stronger than the ticket asked for: there are **three** wire probes, not two. The middle one pins that merely *opening* the confirm prompt does not touch the session — so the confirm step is verified to be a real gate, not decoration. The final `401` is an unfaked server response on a room-scoped probe. The dev's evidence claim of 200 → 401 is therefore not just plausible, it is reproduced by a test I ran myself.

## 6. Negative control genuinely has teeth — CONFIRMED BY MUTATION TEST

The test does stub the POST via route interception and asserts both required things:

```ts
await page.route("**/api/host/session*", (route) => {
  if (route.request().method() === "POST") {
    return route.fulfill({ status: 500, body: "{}" });
  }
  return route.continue();
});
...
// dashboard still shown (no false "logged out" claim)
await expect(page.getByRole("button", { name: /pausar|retomar/i })).toBeVisible();
// and the real, unstubbed session is still live
await page.unroute("**/api/host/session*");
const stillLiveRes = await page.request.get(`/api/host/session?room=${id}`);
expect(stillLiveRes.status()).toBe(200);
```

Note the `unroute` before the follow-up probe — so the final `200` is a genuine server response, not the stub echoing back.

Reading it is not proof, so I **proved it empirically**. In a throwaway detached worktree (never touching the branch), I copied in the branch's three changed files and then deleted the `res.ok` gating, making the handler flip to the gate unconditionally:

```diff
-      const res = await fetch(`/api/host/session${roomQuery}`, { method: "POST" });
-      if (res.ok) {
-        setAuth("gate");
-      }
+      await fetch(`/api/host/session${roomQuery}`, { method: "POST" });
+      setAuth("gate");
```

Result against the mutated build:

```
  2) › logout negative control — a failed clear leaves the host authed
    Error: expect(locator).toBeVisible() failed
    Locator: getByRole('button', { name: /pausar|retomar/i })
    Expected: visible
    Error: element(s) not found
    > 393 |   await expect(page.getByRole("button", { name: /pausar|retomar/i })).toBeVisible();

  2 failed
    › logout control clears the session on the wire (confirm → 401 on re-probe)
    › logout negative control — a failed clear leaves the host authed
  1 passed (29.6s)
```

The negative control **fails** the moment the `res.ok` check is removed, and so does the wire test. The check is load-bearing and the test suite would catch its removal. This is the strongest form of the claim the ticket wanted, and it holds. The throwaway worktree was removed afterwards; the branch was never modified.

## 7. `res.ok` gating in the handler — CONFIRMED CORRECT

```ts
async function handleLogout() {
  setLoggingOut(true);
  try {
    const res = await fetch(`/api/host/session${roomQuery}`, { method: "POST" });
    if (res.ok) {
      setAuth("gate");
    }
  } catch {
    // network hiccup — stay authed; host can retry
  } finally {
    setLoggingOut(false);
    setConfirmingLogout(false);
  }
}
```

`setAuth("gate")` occurs **only** inside `if (res.ok)`. A non-2xx response leaves the host authed; a thrown network error is caught and also leaves the host authed. The `finally` correctly resets the transient UI flags on every path, so the control cannot get stuck in a spinning/confirming state. Both confirm buttons are `disabled={loggingOut}`, preventing a double-submit. The endpoint is called room-scoped (`roomQuery` = `?room=${encodeURIComponent(roomId)}`), matching the GET probe's scoping and correctly encoded.

The failure mode this avoids is the right one: falsely telling a host they are logged out while their cookie is still live on a shared venue tablet would be a genuine (if minor) security-UX defect. The dev chose the safe direction.

## 8. Visual check — PASS at both widths

All six screenshots opened and inspected directly.

- **`authorised-1440.png`** — header reads `Sala do público ↗` · `Abrir /tv ↗` · `Analytics` (three bordered pills) then **`Sair`** in muted grey, borderless, smaller. The visual hierarchy is exactly as intended: `Sair` is unmistakably a secondary meta-action, not a peer of the navigation pills. No clipping, no overflow.
- **`logout-confirm-1440.png`** — `Sair` is replaced in place by `Confirmar` (filled accent red) + `Cancelar` (outlined, muted). Destructive-affirmative styling on the confirm, low-emphasis on the cancel. The swap causes no layout shift in the rest of the header; the pills to the left stay put. The confirm pair is clear and unambiguous.
- **`after-logout-gate-1440.png`** — post-logout the app is back on the clean login gate (`CÓDIGO DO HOST` + `Entrar`), room `default`. Correct end state, and consistent with the wire test's `401`.
- **`authorised-390.png`** — at 390px the header wraps to three rows (wordmark/badge, then the two link pills, then `Analytics` + `Sair`). `Sair` remains muted and legible, sits comfortably beside the `Analytics` pill, and nothing is clipped or overlapping. Layout intact.
- **`unauthorised-1440.png` / `unauthorised-390.png`** — Analytics link **absent**, `Sair` **present**. Header still balanced with the gap where Analytics would be; no orphaned separator or dangling spacing at either width.

**On the Analytics-absent / Sair-present distinction: this is correct, not a bug.** The two controls are gated on genuinely different things, and the asymmetry follows directly from the auth model:

- *Analytics* is **site-wide**, gated on a `default`-room `HOST_TOKEN` session (`app/api/host/analytics/route.ts`). A venue host holding only their own room's `hostCode` can never authenticate `default` (`lib/host-auth.ts` `resolveRoomToken`), so the link must not render for them — showing it would be a link that 401s, which is worse than no link.
- *Sair* is **per-room**, and its precondition is simply "you are the authenticated host of the room you are looking at". Anyone rendering the dashboard at all satisfies that by construction, so it is always available.

So "unauthorised" in these filenames means *not authorised for site-wide analytics*, while still being a fully authenticated host of that room — hence dashboard + `Sair`, minus `Analytics`. That is the intended semantics and the e2e suite pins both halves (test 51 asserts `admin-analytics-link` has count 0 for a per-room `hostCode` session; test 52 asserts it is visible for the `HOST_TOKEN` `default` session).

I also checked the mirror case: the logout control is correctly absent when *nobody* is authenticated, because it lives inside the authed branch of `AdminRoom` — pinned explicitly by test 53 rather than left to assumption. Good instinct by the dev to pin it rather than assume the branch structure.

## 9. Accessibility — PASS

All three new controls are real, native `<button type="button">` elements — the trigger, `Confirmar`, and `Cancelar`. No `div`/`span` click handlers, no `role="button"` fakery. They are therefore keyboard-reachable in DOM order, activate on both Enter and Space, and are exposed correctly to assistive tech.

Focus rings are **not** suppressed. I checked every `outline` declaration reachable by these elements:

- `app/globals.css:43` — `outline: none` is scoped to the `input, textarea, select` rule only. It does not apply to buttons.
- `app/(patron)/[room]/admin/admin.module.css:338` — an `outline` is *added* for `.switch input:focus-visible + .switchTrack`; unrelated to these controls.
- `.logoutBtn`, `.confirmYes`, `.confirmNo` contain no `outline`, no `outline: none`, and no `:focus`/`:focus-visible` override.

So all three inherit the UA's native `:focus-visible` ring. The `.logoutBtn` hit area is `padding: 6px 8px` on 0.8rem text — small but consistent with the header's other meta affordances, and it is a deliberately de-emphasised control.

One thing I checked on my own initiative: contrast of the new muted control. `--text-muted: #888` on `--bg: #0d0d0d` computes to **≈5.49:1**, comfortably over the 4.5:1 AA threshold for small text. No defect. See §11 for a minor test-coverage follow-up on this.

## 10. Confirm-step judgment call — reasonable, endorsed

The TM's brief said "Consider whether it warrants a confirmation step; use your judgement and justify the call." The dev required confirm-before-act, justified as: shared venue tablet, and re-entry requires the host code.

I think this is the right call, and the justification is sound rather than merely plausible:

- The cost of an accidental logout is not trivial. The host is mid-service, the control sits in a header they touch for other reasons, and recovery requires locating and re-entering the host code — plausibly disruptive while a queue is running in a loud venue on a shared tablet.
- The cost of the confirm step is one extra tap on a rarely-used action. Logout is not a hot path; friction here is close to free.
- It reuses an established in-app pattern (the two-step `Remover` on a queue row) with existing `styles.confirm` / `confirmYes` / `confirmNo` classes and the existing `t("confirm")` / `t("cancel")` keys. So it costs no new CSS pattern, no new translation keys, and it is a UI vocabulary the host has already learned elsewhere in the same dashboard.
- It sidesteps the "are you sure" anti-pattern critique, which mainly applies to *frequent, low-stakes, easily-undone* actions. This is infrequent, moderately disruptive, and not one-tap-undoable.

The asymmetry favours confirming. I agree with the dev; nothing to flag.

## 11. Non-blocking observations (follow-ups, not merge blockers)

1. **Hardcoded `Sair` and `Analytics` strings.** Both are justified for this cycle (a sibling agent owns `messages/*.json`, and respecting that boundary was the right call — violating it to add two keys would have been worse). But it does leave two untranslated strings in a product with pt-BR/en/es. `Analytics` is genuinely identical across all three; `Sair` is not (`Log out` / `Salir`). Worth a small follow-up ticket to add both keys once the i18n files are free. Low severity — the room-language selector governs patron-facing copy, and this is a host-only control in a dashboard whose source locale is pt-BR.
2. **No contrast assertion on `.logoutBtn`.** The repo has a strong `e2e/contrast.spec.ts` discipline, including explicit "latent C3" coverage of admin controls, but `grep` confirms it has no case for the new muted button. The value passes AA on my own calculation (≈5.49:1), so this is a coverage gap rather than a defect — but the house pattern here is to pin it. Cheap follow-up.
3. **The analytics probe fires on every `/[room]/admin` mount, including on the login gate**, since its `useEffect` has an empty dep array and runs independent of auth state. Harmless — one extra request that 401s silently and is correctly designed to never block or delay the dashboard — but it is a request an unauthenticated visitor triggers. Not worth changing; noting only for completeness.
4. **Branch is 2 commits behind `origin/main`.** Rebase before merge (see §1).

---

## Verdict

**APPROVE**, conditional solely on §1: commit and push the logout scope, open the PR, and confirm the pushed content matches the three SHA-256 hashes recorded above. No code changes are required.

Every substantive check passes:

- Scope: clean — 12 paths, all within the allowed set, zero forbidden files touched.
- Auth-weakening: none — `app/api/host/session/route.ts` and `lib/host-auth.ts` completely untouched; the change adds the first caller to a previously-dead endpoint and weakens nothing.
- jest: 683/683 pass. `tsc --noEmit`: delta 0 vs merge-base, no error references a changed file. `npm run build`: succeeds.
- e2e: 81/81 pass, including all 3 new logout tests and the new analytics-link test.
- The wire-level test really probes the API (three probes: pre, pre-confirm, post), asserting 200 → 200 → 401.
- The negative control genuinely has teeth — **proved by mutation**: removing `res.ok` makes it fail.
- `handleLogout` gates `setAuth("gate")` strictly inside `if (res.ok)`, with a catch that also preserves the authed state.
- Visuals correct at 1440 and 390; the Analytics-absent/Sair-present asymmetry is correct by design, not a bug.
- All controls are native `<button>`s with native focus rings intact.
- The confirm-step judgment call is well-reasoned and endorsed.

This is careful work — particularly the decision to strip cookies in the pre-existing admin test so the analytics assertion tests the honest scenario, the three-probe wire test, and building a negative control that actually fails when the implementation is broken. The one gap is delivery, not engineering.
