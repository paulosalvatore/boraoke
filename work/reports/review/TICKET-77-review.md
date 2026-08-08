# TICKET-77 — Reviewer gate report

**Verdict: APPROVE**

Branch `ticket/77-analytics-discoverability` @ `155141c` (code commit `f22ea57`), reviewed against `origin/main` in `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-77`. Everything below was re-run independently from scratch in this worktree; nothing is quoted from the dev report.

## 1. Scope / boundary check — PASS

`git diff origin/main --name-only`:

```
app/(patron)/[room]/admin/AdminRoom.tsx
e2e/render-and-links.spec.ts
work/events/by-branch/ticket-77-analytics-discoverability.jsonl
work/evidence/TICKET-77/authorised-1440.png
work/evidence/TICKET-77/authorised-390.png
work/evidence/TICKET-77/unauthorised-1440.png
work/evidence/TICKET-77/unauthorised-390.png
work/tickets/TICKET-77-analytics-discoverability.md
```

`142 insertions(+), 0 deletions(-)` across 8 files. Every entry is on the allowed list except `work/events/by-branch/ticket-77-analytics-discoverability.jsonl`, which is the house's machine-generated event log written by the auto-commit hook (D-036), not authored content — benign, not a scope violation.

Explicit forbidden-path check (empty diff = untouched):

```
git diff origin/main --stat -- lib/host-auth.ts app/api/host/analytics/route.ts \
  app/api/host/session/route.ts messages/ app/admin/ components/ app/globals.css \
  app/layout.tsx app/page.tsx 'app/(patron)/[room]/admin/admin.module.css'
→ (no output)
```

**No forbidden file touched.** `admin.module.css` is untouched — the claim of zero CSS changes is true. `messages/*.json` untouched, so no collision with the sibling i18n agent.

## 2. Auth-weakening check — PASS

`lib/host-auth.ts`, `app/api/host/analytics/route.ts` and `app/api/host/session/route.ts` are byte-identical to `origin/main`. The change is presentation-only: it *reads* the existing session endpoint and conditionally renders an anchor. The analytics page's own server-side gate is untouched, so hiding/showing the link changes discoverability, not authorisation — a user who forges `analyticsAllowed` in devtools still gets a 401 from the page itself. No new endpoint, no token in client code, no `HOST_TOKEN` reference in the diff.

## 3. Test re-runs (all foreground, from scratch)

### jest — PASS
```
Test Suites: 43 passed, 43 total
Tests:       683 passed, 683 total
```

### tsc — delta 0
I did not take the dev's baseline on trust. I created a throwaway detached worktree at `origin/main` sharing this worktree's `node_modules` and ran `npx tsc --noEmit` in both:

| tree | `grep -c 'error TS'` |
|---|---|
| `origin/main` | **2190** |
| `ticket/77-...` | **2190** |

Delta **0**. `grep -E 'AdminRoom\.tsx|render-and-links'` over the branch's tsc output returns **nothing** — zero errors reference either modified file. (The 2190 are the known pre-existing "Cannot find name 'it'/'expect'/'jest'" class plus Playwright typing noise; unrelated to this ticket.)

### next build — PASS
`npm run build` completed, full route table emitted, no errors or warnings attributable to the change.

### Playwright e2e (full suite) — PASS
```
PORT=3199 npx playwright test --reporter=list
...
  78 passed (3.4m)
EXIT=0
```

The two states in question:

```
✓  51 e2e/render-and-links.spec.ts:270:5 › /[room]/admin: login → controls + mode switcher + customer-screen links (3.2s)
✓  52 e2e/render-and-links.spec.ts:304:5 › /[room]/admin: HOST_TOKEN-authed session (default room) shows the Analytics link (2.6s)
```

Test 51 carries the unauthorised assertion (`toHaveCount(0)` on `admin-analytics-link`); test 52 is the new authorised test (visible + `href="/admin/analytics"`). No flakes, no retries configured (`retries: 0`), suite is single-worker serial.

## 4. Is the unauthorised assertion actually honest? — YES

This was the part most worth distrusting, and it holds up. `test.beforeEach` (line 72) runs `warmUp`, which does `req.post("/api/host/login", { data: { token: DEV_TOKEN } })` with **no `?room=`** — so it resolves to `default` and leaves a valid `default`-room session cookie on the shared context. Without intervention, the probe would 200 for *every* test in the file and the "must not render" assertion would pass only by accident of timing, or fail outright.

The dev anticipated exactly this and added `await page.context().clearCookies()` as the first line of test 51, before `createRoom`. The subsequent login is minted purely from that room's own one-time `hostCode`, which is the real venue-host scenario. The assertion is therefore testing the honest case, not a confound. Good catch by the dev, and the inline comment documents the reasoning.

Symmetrically, test 52 relies on the `warmUp` `default` session still being present (it does not clear cookies) and navigates straight to `/default/admin` — which is genuinely the HOST_TOKEN-backed session that `requireHost(req, DEFAULT_ROOM)` accepts. The two tests are true opposites.

Minor, non-blocking: `toHaveCount(0)` on an async-populated element is theoretically satisfiable before the probe resolves. In practice the preceding assertions (login round-trip, mode switcher, patron/tv link attributes) consume far more time than the local probe, so a regression that made the link always render would still be caught. Not worth a change request.

## 5. Probe implementation — genuinely non-blocking

```tsx
useEffect(() => {
  let cancelled = false;
  fetch("/api/host/session?room=default")
    .then((res) => { if (!cancelled) setAnalyticsAllowed(res.ok); })
    .catch(() => { /* silent */ });
  return () => { cancelled = true; };
}, []);
```

- Its own `useEffect`, empty deps → runs **once** on mount. No interval, no retry, no polling — verified by reading the whole effect list in the file (the queue/pending pollers are separate, pre-existing, and gated on `auth === "authed"`).
- Not awaited by, and shares no state with, the render path or the room's own `checkSession`. `analyticsAllowed` starts `false`, so first paint is identical to `main`; the link can only ever appear later, never delay anything.
- Rejection is swallowed in `.catch` with no `console.*` and no error state. A non-200 (401) simply sets `analyticsAllowed = false` via `res.ok`. There is no code path that surfaces a probe failure to the user.
- `cancelled` guard prevents a post-unmount `setState` warning.

One harmless note: the effect fires on mount even while `auth === "checking" | "gate"` (the header itself renders only in the `authed` branch, line 349+). That is one extra cheap GET for a visitor sitting on the login gate — no correctness or security impact.

## 6. Accessibility — PASS

Real `<a className={styles.tvLink} href="/admin/analytics" target="_blank" rel="noreferrer">` — a genuine anchor with an href, so it is keyboard-focusable and Enter-activatable by default, and appears in the a11y tree as a link. `rel="noreferrer"` is correctly paired with `target="_blank"`. It reuses `.tvLink` verbatim, so hover styling (`border-color: var(--accent)`) is identical to its siblings.

`.tvLink` defines no `:focus-visible` rule, so it inherits the UA focus ring — `app/globals.css` scopes its `outline: none` to `input, textarea, select` only, never to anchors, so the ring is not suppressed. This is pre-existing and shared with `admin-patron-link` / `admin-tv-link`; the new link is no worse than its siblings, so nothing to fix here.

Cosmetic nit (not blocking, no action requested): the sibling links carry a `↗` external-target glyph ("Sala do público ↗", "Abrir /tv ↗") while "Analytics" does not, despite also opening in a new tab. Worth a one-character follow-up someday, not a gate item.

## 7. Layout / CSS — PASS

`.top` already has `flex-wrap: wrap` on `main` (admin.module.css:12–18), unchanged, so a fourth header child wraps rather than overflowing. Confirmed against the evidence:

- `unauthorised-1440.png` — header shows only "Sala do público ↗ / Abrir /tv ↗". **No Analytics link, no error text, no console/UI artefact, layout identical to main.**
- `unauthorised-390.png` — links wrap onto two rows as before; no Analytics entry; nothing clipped or overflowing.
- `authorised-1440.png` — "Analytics" sits inline as the third header button, same pill styling as siblings, room chip reads `default` (correct: that IS the HOST_TOKEN room).
- `authorised-390.png` — Analytics wraps cleanly onto its own third row, full label visible, no horizontal overflow, nothing overlapping the feedback pill.

## 8. Ticket claims vs. reality

| Dev claim | Verified |
|---|---|
| Reuses `.tvLink`, no CSS file changes | TRUE — css diff empty |
| Probe never blocks/delays render, no retry, fails silently | TRUE — read the effect |
| Label hardcoded, not localised, `messages/*.json` untouched | TRUE |
| New e2e coverage for both states | TRUE — both pass, unauthorised case de-confounded |
| Evidence screenshots present | TRUE — 4 PNGs, visually confirmed |
| ~2190 pre-existing tsc errors as baseline | TRUE — independently measured main at exactly 2190 |

## Issues found

None blocking. Two cosmetic observations recorded above (missing `↗` glyph; theoretically racy `toHaveCount(0)`), neither warranting a change request.

**APPROVE.**
