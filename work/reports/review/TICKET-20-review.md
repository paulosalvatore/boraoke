# TICKET-20 — Reviewer Report

**Verdict: APPROVE**
**Reviewer:** Reviewer agent (sonnet pass — D-022; non-trivial diff, opus pass warranted but test/evidence quality is high and all checks mechanically verified; TM may escalate to opus if needed)
**Date:** 2026-07-07
**PR:** paulosalvatore/boraoke#17
**Branch:** `ticket/20-p0-ux-fixes`
**Worktree:** `/Users/paulosalvatore/Documents/GitHub/cantai/.worktrees/ticket-20`

---

## Bootstrap Checklist

- [x] Ticket read: `work/tickets/TICKET-20-p0-ux-fixes.md`
- [x] Dev report read: `work/reports/dev/TICKET-20-dev-report.md` — current (updated with CI SHAs in commit 3bf17fb)
- [x] App Tester PASS: `work/reports/testing/TICKET-20-app-test.md` — PASS, 8/8 items, minor gap D1 (no isEphemeralRoomStore unit test)
- [x] Security: TM-waived N/A-by-content — assessed below
- [x] CI: build-and-test PASS (GitHub Actions run 28873796812, 2m35s); Vercel PASS (both cantai + boraoke deployments)
- [x] Full diff read locally from `origin/ticket/20-p0-ux-fixes` (git-local-first, TICKET-F18)
- [x] Unit tests run personally: **333/333 PASS** (Jest, 23 suites, 1.689s)
- [x] Build run personally: **`npm run build` exit 0** (typecheck clean)
- [x] E2e run personally: **28/28 PASS** (Playwright, 1.6m, serial worker)

---

## CI Verification (S1)

```
Vercel           pass    Deployment completed
Vercel Preview   pass
build-and-test   pass    2m35s — https://github.com/paulosalvatore/cantai/actions/runs/28873796812
```

No required check is pending or failing. CI terminal-green. ✓

---

## Security Waiver Assessment

TM waived full security pass (N/A-by-content: no new API endpoints). Three security-adjacent areas examined:

### (a) RESERVED_ROOM_IDS completeness

All top-level `app/` directories enumerated:

```
app/                → root (/) — not a room slug
app/(patron)/[room] → catch-all room slug — the very thing being guarded
app/admin           → /admin — RESERVED ✓
app/api             → /api/* — RESERVED ✓
app/new             → /new — RESERVED ✓
app/tv              → /tv — RESERVED ✓
```

`RESERVED_ROOM_IDS = {"new", "api", "tv", "admin", "default"}` covers every static top-level route that could be shadowed by a room slug. The list is **complete** for the current app structure.

### (b) `/new?name=` prefill — injection risk

```typescript
const params = new URLSearchParams(window.location.search);
const preset = params.get("name");
if (preset) setName(preset.slice(0, 60));
```

`preset` is set as React state and rendered as `value={name}` on a controlled input. React auto-escapes all JSX attribute values — no reflected XSS path. The 60-char slice is consistent with the server-side 60-char trim in `createRoom`. Safe. ✓

### (c) deriveRoomName in room-404 recreate CTA

```tsx
const suggestedName = roomId ? deriveRoomName(roomId) : "";
// ...
<Link href={`/new?name=${encodeURIComponent(suggestedName)}`}>
  Recriar sala "{suggestedName}"
</Link>
```

`roomId` is only passed to `RoomNotFound` when `isValidRoomId(room)` is true (enforced server-side before the component renders). `deriveRoomName` output is rendered as JSX text (React auto-escapes) and the href uses `encodeURIComponent`. No injection. ✓

**Waiver verdict: CONFIRMED — no security escalation needed.** All three concerns are correctly handled.

---

## Scope Verification

Ticket required: items 1a/1b, 2, 3, 4, 5, and the e2e render+link suite.

- `lib/store/**` NOT touched (diff stat confirms — constraint respected). ✓
- All 5 functional items delivered.
- E2e render+link suite delivered (10 new specs).
- No unrequested features; no drive-by refactors.

---

## Code Review

### lib/rooms.ts

**Slug logic (Item 4)**

`slugify()` returns the clean slug (no suffix). `createRoom()` loop appends a suffix ONLY when `isReservedRoomId(id)` OR `roomBackend.get(id) !== null`. Loop bound = 8 attempts; each attempt generates a fresh `randomBase32(4)` suffix (~1M space). Practical collision probability: negligible.

Unicode handling: `.normalize("NFD").replace(/[̀-ͯ]/g, "")` — correct NFD diacritic stripping. "São João do Açaí" → "Sao Joao do Acai" → `sao-joao-do-acai`. Empty-after-strip falls back to `"sala"`. ✓

**isEphemeralRoomStore (Item 1a)**

```typescript
return resolveDriver() === "memory" && process.env.NODE_ENV === "production";
```

The dual guard (`memory AND production`) is correct: dev/CI runs memory but is not production, so the notice never leaks into local UX or test assertions. ✓

**deriveRoomName (Item 1b recreate path)**

The trailing-suffix regex `/^[0-9a-hjkmnp-tv-z]{4}$/` matches the Crockford base32 alphabet exactly (same alphabet as `randomBase32`). Title-cases without external dependencies. Purely cosmetic — user can edit before recreating. ✓

### app/(patron)/[room]/page.tsx

Malformed-URL path (fails `isValidRoomId`) passes `RoomNotFound` without `roomId` — no recreate CTA on malformed slugs, which is correct. Valid-but-missing path passes `roomId` → recreate offered. ✓

### app/new/page.tsx

`?name=` prefill via `useEffect` (avoids Suspense boundary requirement for `useSearchParams` in a client page) — the correct pattern for Next.js 13+ app router. ✓

### app/page.tsx

Input contrast fix uses `var(--bg)` and `var(--text-muted)` CSS variables — token-based, no magic values. ✓

### app/(patron)/[room]/PatronRoom.tsx

Player-hint link: `href={/${roomId}/tv}`, `target="_blank"`, `rel="noreferrer"`, `data-testid="patron-player-hint"`. Design decision documented inline. ✓

### app/(patron)/[room]/admin/AdminRoom.tsx

Two new links with correct `data-testid` attributes and `target="_blank" rel="noreferrer"`. ✓

---

## Test Suite Quality

### Unit Tests (333/333 — verified)

New suites added:
- `isReservedRoomId`: reserves all 5 static routes; does not reserve substrings ("television" ≠ reserved). ✓
- `deriveRoomName`: clean id, suffix-stripped id, single-segment id — correct output. ✓
- `createRoom` integration: clean slug minted; suffix on collision; reserved name forces suffix. These are the critical test cases for TICKET-20's slug change. ✓

The test for reserved names iterates all 5 reserved values (TV/Admin/API/New/Default) and asserts the minted id is NOT reserved and matches `^<name>-[base32]{4}$`. ✓

**Gap:** No unit test for `isEphemeralRoomStore()`. Noted by App Tester. See NIT-1 below.

### E2e Suite Quality (28/28 — verified locally)

**Assertions meaningful (not just non-404):**

Each test checks essential elements by role, label, testid, or content:
- Landing: `getByRole("link", {name: /criar a sala/i})`, `getByLabel(/código da sala/i)`, button enabled after fill ✓
- /new: form presence by label and button ✓
- /new?name=: `toHaveValue("Bar Do Paulin")` — directly tests the prefill feature ✓
- /[room]: join form → song input heading → queue heading → player-hint `href` attribute ✓
- room-404: exact text, `data-testid="recreate-room"`, href pattern, back link ✓
- /[room]/tv (seeded): `tv-hero` contains song title, `#yt-player` count = 1 ✓
- /[room]/tv (idle): `tv-idle` visible, copy text, `#yt-player` count = 0 ✓
- /[room]/admin: login gate, pause/skip buttons, mode switcher radiogroup, admin-patron-link and admin-tv-link hrefs ✓
- Legacy redirects: URL assertions after navigation ✓

**Link crawler — genuinely crawls:**

Uses `document.querySelectorAll("a[href]")` at runtime — collects all same-origin hrefs actually present in the rendered DOM. Not a fixed list. Covers `/`, `/new`, `/${id}/tv`, `/${id}`. Admin-after-login links are excluded (auth-gated page) — covered by the render assertion test instead. Reasonable design. ✓

**Determinism:**

`warmUp()` pre-compiles all routes before any seeding, correctly addressing the in-memory store first-compile reset pattern. ✓

One concern: `page.waitForTimeout(300)` in `crawlLinks()` after `page.goto()`. This is a sleep-and-hope for React hydration. In practice, `page.goto()` already waits for the load event, and 300ms is generous for a local dev server. Low fragility risk, but see NIT-2.

---

## Rebase Surface

- PR #15 (docs) merged to main before this PR — docs only, no conflict.
- PR #16 touches `lib/store/**` — this PR does NOT touch `lib/store/**` (confirmed by diff stat). No conflict surface. ✓

---

## Dev Report Currency (TICKET-F23)

Read from PR branch, not main checkout. Report reflects implemented state:
- Status updated from in-progress → implemented ✓
- CI run SHA and checks recorded in commit 3bf17fb ✓
- Implementation log covers all 5 items + test counts ✓

---

## Findings

### BLOCKING

None.

### NITS (non-blocking, optional)

**NIT-1 — `isEphemeralRoomStore()` unit test gap**

The function is a one-liner and behavior is proven by App Tester's local confirmation, but a unit test would allow future refactors to be caught without requiring a prod deployment. Suggest a follow-up ticket. Not required for this PR.

**NIT-2 — `page.waitForTimeout(300)` in crawlLinks**

```typescript
await page.waitForTimeout(300);
```

A deterministic wait (e.g. `page.waitForLoadState('domcontentloaded')` or waiting for a specific element known to render last) would be more robust. In practice, the 300ms is sufficient and the spec passes reliably. Follow-up improvement.

---

## Evidence Cited

- `work/reports/dev/TICKET-20-dev-report.md` — dev report, current
- `work/reports/testing/TICKET-20-app-test.md` — app-tester PASS, 8/8 items
- `work/evidence/ticket-20/` — 15 PNGs (7 dev + 8 app-tester)
- Reviewer own runs: 333/333 unit (Jest 1.689s), build exit 0, 28/28 e2e (Playwright 1.6m)
- CI: build-and-test PASS (Actions run 28873796812)

---

## Verdict

```
[reviewer] APPROVE — TICKET-20 P0 UX fixes + render/link test suite.

All gates clear: CI terminal-green (build-and-test PASS), App Tester PASS (8/8 items, 15 evidence
shots), security waiver confirmed (RESERVED_ROOM_IDS complete, no injection surfaces). Reviewer
own runs: 333/333 unit, build exit 0, 28/28 e2e (all verified locally against origin/ticket/20-p0-ux-fixes).

Slug logic correct (unicode, empty, reserved, collision). isEphemeralRoomStore gates correctly on
memory+production. E2e assertions are meaningful, link crawler genuinely crawls DOM hrefs, warmUp
pattern handles in-memory reset correctly. lib/store/** untouched. Two nits (isEphemeralRoomStore
unit test, crawlLinks sleep) — both non-blocking; suggest follow-up tickets.

Ready for TM merge.
```

---

# D-022 OPUS SECOND PASS (merge-counting) — Reviewer (opus)

**Date:** 2026-07-07 · **Model:** opus (claude-opus-4-8) · **Verdict: APPROVE (merge-counting)** with 4 filed follow-ups.

This pass is the judgment layer requested because the TL explicitly distrusted prior coverage ("I think app tester didn't test properly"). I re-verified everything locally against the exact merging tip `origin/ticket/20-p0-ux-fixes` (155629173).

## Self-verification (opus, on the merging tip)
- Unit: **333/333** pass (Jest, 2.0s).
- E2e: **28/28** pass (Playwright, 1.3m) — incl. all 10 render-and-links specs.
- Build: `next build` exit 0, clean.
- `lib/store/**`: diff is **empty** — PR #16 (store, merging concurrently) has zero overlap; no rebase collision surface. Branch merge-base == current `main` (c84bd5d), so it is already current vs main.
- CI: last GitHub Actions `CI` run is **success** on 9cd8467; the only commits after it (tip 155629173) are evidence PNGs + the two report `.md`s + event-log jsonl — **zero source/test code** (verified via `git diff 9cd8467..tip --stat`). ci.yml triggers on `pull_request`. S1 satisfied in substance: all merging code is green both by the last CI run and by my own full local run on the tip. Non-blocking observation, not a pending required check.

## TL-TRUST RULING — would THIS suite have caught the original bugs?

**Partially — and the one it would MISS is the exact bug the TL personally flagged.**

- **Bug #2 (the invisible join input) was a CONTRAST/camouflage bug, not a missing-element bug.** The fix (app/page.tsx) changes the input fill from `var(--surface)` (identical to the card behind it → camouflaged, looked absent) to `var(--bg)` + a `var(--text-muted)` border. The new regression test (`render-and-links.spec.ts:78`) asserts `getByLabel(/código da sala/i)` → `toBeVisible()` → `fill()` → button `toBeEnabled()`. **Playwright's `toBeVisible()` returns TRUE for a same-background-color (camouflaged) input** — it checks DOM presence, `display`, `visibility`, non-zero box; it does **not** evaluate colour contrast. So this assertion would have **passed on the OLD broken input**. It does not protect against a re-camouflage. This is precisely the existence-only false-assurance the TL complained about — and the test comment ("bug #2: must be present + usable") mildly over-claims the coverage it provides.
- **The actual fix IS correct and IS human-verified** by review-grade screenshot evidence (`01-landing-join-input-visible.png`, `apptester-01-landing-join-input.png`) showing the field now visibly reads as an input. So the shipped behaviour is right; what's absent is *automated regression protection for the contrast class*.
- **What the suite genuinely DOES add (real value, not theatre):** per-page render assertions across all 6 route families; a link crawler that actually enumerates same-origin `<a href>`s from the live DOM and GETs each asserting non-404; real create→read→login round-trips with a `warmUp` that correctly handles the `next dev` in-memory singleton reset. It would catch a whole-element-missing regression, a dead/404 internal link, a broken redirect, a missing player-hint/recreate path. That is a meaningful, maintainable step up from the prior coverage.

**Bottom line for the TL:** the suite is a real improvement and answers most of the distrust, but it would NOT catch a recurrence of the specific camouflage bug — a `toBeVisible()` pass on a visually-invisible-but-DOM-present element is still in the suite. I am not blocking on it (fix is correct + screenshot-verified + code green), but I am filing the contrast-smoke-assertion as a required follow-up so the class the TL hit gets real automated protection.

## Other concerns (all resolved)
2. **Ephemeral notice won't false-positive post-Upstash.** `isEphemeralRoomStore() = resolveDriver()==="memory" && NODE_ENV==="production"`. `resolveDriver()` reads `STORE_DRIVER` (explicit) else `UPSTASH_REDIS_REST_URL` presence — the **same** selection `createBackend()` uses (verified), so it reads the actual driver, not a divergent copy. With Upstash live in prod, driver = `upstash` → `false` → notice correctly stays hidden. ✓
3. **Slug migration backward compat is safe.** `ROOM_ID_RE = /^[a-z0-9-]{1,64}$/` accepts both clean slugs and legacy suffixed ids; rooms are looked up by exact stored key, so any already-shared suffixed link (e.g. `bar-do-paulin-hjj2`) still resolves by its stored id. The clean-slug change affects only **newly minted** ids, never existing keys. `deriveRoomName` strips the trailing 4-char base32 suffix for the recreate prefill (unit-tested). No URL-contract break for existing links. ✓
4. **Collision-suffix UX is silent (minor).** A second "Bar do Paulin" gets `bar-do-paulin-<sfx>` and the creator is not told their preferred slug was taken. The venue *name* is preserved (stored separately from id) and the creator does see the final suffixed join-url. Acceptable to ship; filed as a low-priority UX follow-up.
5. **`lib/store/**` untouched** — verified empty diff; no PR #16 collision. ✓

## Filed follow-ups (none block this merge)
- **F/A (HIGH, test hardening):** add a reusable computed-style contrast smoke assertion — assert the join input's computed `background-color` differs from its parent card's — and extend the helper across form inputs. Closes the camouflage class the TL hit. (class-level prevention)
- **F/B (NIT):** correct the `render-and-links.spec.ts:78` comment so it no longer implies it covers bug #2's *visual* failure mode.
- **F/C (NIT, carried from sonnet):** add a direct `isEphemeralRoomStore()` unit test (memory+production → true; upstash → false).
- **F/D (NIT, carried from sonnet):** replace the `crawlLinks` `waitForTimeout(300)` with a deterministic wait.
- **F/E (LOW UX):** tell the creator when their preferred slug collided and a unique link was generated.

## Verdict
```
[reviewer][opus] APPROVE (D-022 merge-counting) — TICKET-20 P0 UX fixes + render/link suite.
Re-verified on the merging tip: 333/333 unit, 28/28 e2e, build exit 0, lib/store/** untouched
(no PR #16 collision), branch current vs main. Ephemeral detection reads the real driver and
won't false-positive now that Upstash is live; slug migration preserves existing suffixed links;
reserved-slug set complete. TL-trust ruling: the suite is a genuine, DOM-crawling improvement but
its landing assertion is toBeVisible()-only and would NOT catch a recurrence of the specific
contrast/camouflage bug (#2) — that fix is correct and screenshot-verified, so not blocking, but a
computed-style contrast smoke assertion is filed as a required HIGH follow-up (F/A). 4 other
non-blocking follow-ups filed. Cleared for TM merge.
```
