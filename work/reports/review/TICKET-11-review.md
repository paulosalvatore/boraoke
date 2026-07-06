# Review Report — TICKET-11: In-App Feedback Widget

- **Reviewer:** Reviewer agent (D-011, opus pass)
- **Date:** 2026-07-05
- **PR:** #11 · branch `ticket/11-feedback-widget` · worktree `.worktrees/ticket-11`
- **Verdict:** APPROVE

---

## Gate pre-conditions (S1 / S2)

| Gate | Status | Evidence |
|---|---|---|
| App Tester | PASS | `work/reports/testing/TICKET-11-app-test.md` — 105/105 units, 3/3 e2e, 5 screenshots committed |
| Security | PASS-WITH-NOTES | `work/reports/security/TICKET-11-security.md` — M1 fixed, L1/L2 follow-ups recorded |
| CI (S1) | GREEN | `gh pr checks 11` → Vercel: pass, Vercel Preview Comments: pass. No required checks pending. |
| Dev report (TICKET-F23) | Current | Reads 106/106 post-M1; matches reviewer's own run. |

---

## Reviewer's own test run

```
cd .worktrees/ticket-11
npm test -- --no-coverage

Test Suites: 5 passed, 5 total
Tests:       106 passed, 106 total
Time:        0.408s
```

Build clean (`npm run build`): all routes registered, lint + types green, `/api/feedback` (dynamic), `/tv` (static), `/` (static). No client bundle exposure of server-only symbols.

E2E: `playwright.config.ts` hardcodes port 3040 (pre-existing, not introduced by this PR — INFRA-1 already logged by App Tester). Running the dev server on 3011 and pointing Playwright at the correct port gives 3/3 green, consistent with App Tester's report. The playwright config bug is a follow-up item, not blocking.

---

## Spec fidelity — feedback-loop.md Part A

### AC1 — 2-tap submit
PASS. `FeedbackSheet.tsx` wires each sentiment button directly to `submit(sentiment)`. Tapping a face IS the submit; text and category toggle state beforehand and ride the POST body. The App Tester confirmed the 2-tap flow live (FAB click → sheet; sentiment click → confirmation).

### AC2 — Auto-context, no user effort
PASS. `useFeedbackContext.ts` reads `uuid`/`nickname`/`roomId`/`mode` from localStorage and `route`/`role` from pathname. The server augments `appVersion` (from `GIT_SHA` / `VERCEL_GIT_COMMIT_SHA` env), `userAgent` (coarsen from header), `createdAt` (server time). The route handler explicitly overwrites any client-supplied values for those three fields — never trusted from the client. The App Tester intercepted a live POST and confirmed the server-filled fields via admin GET.

### AC3 — Durable store + watermark read path + token guard
PASS. Durable via `lib/feedback-store.ts` (own store, own keyspace, mirrors TICKET-6 pattern). GET `/api/feedback?since=<id>` returns `{items, watermark}`. Token guard is fail-closed: when `FEEDBACK_ADMIN_TOKEN` is unset, `isAdmin()` returns false immediately. App Tester verified the watermark cursor live: two submitted items, `since=<id1>` returns only id2.

### AC4 — 6th submission rejected 429, friendly copy
PASS. `hitRateLimit` is a 5/uuid/hour fixed-window counter, server-side and durable. 6th hit → 429 with pt-BR copy. Tested in unit suite and live by App Tester.

### AC7 — No widget on /tv
PASS. `FeedbackWidget.tsx` returns `null` when `pathname === "/tv" || pathname?.startsWith("/tv/")`. E2E test `feedback.spec.ts:29` confirms no button found on `/tv`. App Tester screenshot `apptester-04-tv-no-widget-desktop.png` confirms the clean TV screen.

### Admin token never client-shipped
PASS. `FEEDBACK_ADMIN_TOKEN` has no `NEXT_PUBLIC_` prefix. Store has `import "server-only"`. Security report confirms no token in `.next/static/` grep. This was also explicitly in the security checklist (PASS).

---

## Watermark design assessment (load-bearing for house intake idempotency)

**ID format:** `base36(ms).padStart(9, "0") + "-" + uuidv4().replace(/-/g,"").slice(0, 12)`

**Monotonicity at different milliseconds:** Guaranteed. The 9-char base36 prefix encodes `Date.now()` and covers timestamps well beyond year 5000. IDs from different milliseconds sort chronologically under lexicographic comparison. ✓

**`since` semantics (strictly-greater):** `list({ since })` applies `r.id > since` on both drivers, which means:
- Re-running from the same watermark never returns already-processed items (idempotent). ✓
- If the watermark item itself is later deleted, the cursor still works (id still exists as a string for comparison). ✓

**Same-millisecond ordering (design note — not blocking):** Two IDs generated within the same millisecond share the same timestamp prefix; the ordering is then determined by the random 12-char suffix. If item A and item B are both generated at ms T, and A is elected watermark, whether `B.id > A.id` is true depends on the random suffix comparison — non-deterministic. At cantai's current traffic scale (early access, small venue count), same-ms collisions are astronomically unlikely. In the worst case a single feedback entry is skipped on one intake run; the intake agent is fuzzy aggregation, not transactional ETL, so one missed item does not break correctness. This is an acceptable design trade-off for the prototype/MVP phase, consistent with how the queue store and all other counters are designed in this codebase. The design choice is honest and explicitly reasoned in the dev report ("the `since` cursor is then a clean lexicographic cut"). It should be revisited if cantai ever reaches high-concurrency feedback volumes.

**No duplicate IDs possible:** Same-ms collision also requires the same 12-char random hex suffix from a uuidv4 — the combined probability is negligible. ✓

**Conclusion:** The watermark is sound for the intake's idempotency guarantee at current scale. The same-ms non-determinism is a theoretical gap, documented as a NIT.

---

## Feedback store drivers

Mirrors TICKET-6's pattern faithfully:
- `FeedbackStore` interface + `MemoryFeedbackStore` + `UpstashFeedbackStore` (injectable client) + env-selected singleton. ✓
- `lib/feedback-store.ts` has `import "server-only"` at line 22. ✓
- Key namespace `feedback:*` is entirely separate from `room:*` (queue store). `lib/store.ts` / `lib/store/` untouched. ✓
- Both drivers tested against the same contract suite in `feedback-store.test.ts` via `describe.each`. The suite covers: chronological ordering, `since` cursor idempotency, `limit` cap, `get`/`updateStatus`, and rate-limit isolation per uuid. ✓
- `UpstashFeedbackStore.clear()` does not reset rate-limit keys (they have TTL). Harmless: store tests create a fresh `FakeRedis` per test via `make()`, so rate state is always clean. ✓

---

## API route validation matrix

| Check | Verdict |
|---|---|
| Body size cap before JSON parse | PASS — `MAX_BODY_BYTES = 8192` enforced first |
| sentiment required + enum | PASS — 400 on missing or non-SENTIMENTS value |
| category optional + enum | PASS — 400 on invalid value; undefined accepted |
| text optional, capped at 1000 | PASS — `str(text, MAX_TEXT)` slices |
| context.uuid required, regex | PASS — `UUID_RE` enforced; 400 on missing or malformed |
| rate limit server-side | PASS — 429 with pt-BR on 6th/hour |
| server augments (never trusts client) | PASS — appVersion/UA/createdAt from server sources |
| admin GET fail-closed | PASS — false when FEEDBACK_ADMIN_TOKEN unset |
| timing-safe compare (M1 fix) | PASS — length guard first, then `crypto.timingSafeEqual` |
| PATCH status enum | PASS — FEEDBACK_STATUSES.includes() check |
| PATCH no mass-assignment | PASS — only id/status/triageRef extracted |

**M1 fix correctness:** `if (a.length !== b.length) return false; return timingSafeEqual(a, b);` — correct order. Length guard comes BEFORE `timingSafeEqual`, which is mandatory (timingSafeEqual throws on unequal lengths). The length mismatch leaks only the token length, not its contents — acceptable for a long random secret. New test at `api-feedback.test.ts:128` covers the same-length wrong token path. Verified the test is exercising the `timingSafeEqual` branch. ✓

---

## Widget and UX

**layout.tsx (sole wave-2 owner):** 6-line additive change — one import line, one component mount after `{children}`. No interference with page state, no structural changes. ✓

**FeedbackWidget.tsx:** Floating pill FAB, Escape-to-close (useEffect), backdrop-click-close via `onClick` on the overlay checking `e.target === e.currentTarget`. `role="dialog" aria-modal="true" aria-label="Enviar feedback"`. ✓

**FeedbackSheet.tsx:** Sentiment buttons have `aria-label` (pt-BR label text). Category chips have `aria-pressed`. Sentiment group has `role="group"`. Category group has `role="group"`. Confirmation `<p>` on `autoFocus` close button. All copy pt-BR. ✓

**Focus trap:** Not implemented (App Tester noted). Keyboard users can tab outside the sheet. Acceptable for MVP; logged as follow-up. (NIT)

**useFeedbackContext.ts:** `safeLocalStorage()` guards against SSR. `readOrCreateUuid` only mints a new uuid if `crypto.randomUUID` is available (falls back gracefully). Role derived from pathname (`/host*` → host, else patron). ✓

**CSS Module scoping:** `FeedbackWidget.module.css` uses CSS custom properties referencing the design system tokens. Does not touch `globals.css`. ✓

---

## Ownership discipline

Diff verified against `git merge-base origin/main origin/ticket/11-feedback-widget`. The following forbidden files show zero diff:
- `lib/store.ts`, `lib/store/` (queue store) — clean
- `app/page.tsx` — clean
- `app/tv/` — clean
- `app/host/` — clean
- `globals.css` — clean

Owned files touched: `app/layout.tsx`, `components/FeedbackWidget.tsx`, `components/feedback/**`, `app/api/feedback/route.ts`, `lib/feedback-store.ts`, `lib/feedback-types.ts`, tests, e2e, `.env.example` (appended one block). ✓

---

## Deferred scope

Micro-prompts (after first song / host session end) explicitly marked "droppable" in the spec. Dev report records the deferral and the reason (core sheet + API + store consumed the budget). This is a legitimate scope decision; the FAB already delivers zero-friction capture on every patron/host page. ✓

---

## Rebase surface vs main (post-#8/#9)

`.env.example` is the one collision point between wave-2 PRs. TICKET-11 appended a new block after the TICKET-6 block. TICKET-7 (PR #10, host controls) also appends `.env.example`. Sequential-merge rule applies: whichever merges second will need a trivial rebase of the `.env.example` append. No semantic overlap between the two PRs (different files, different keys, different API routes). ✓

---

## Blocking items

None.

---

## Nits (non-blocking)

1. **Same-ms ID ordering** (design note): same-millisecond IDs sort non-deterministically by random suffix. At current scale, negligible risk. Revisit if high-concurrency feedback volumes emerge.
2. **playwright.config.ts port hardcode** (INFRA-1, pre-existing): port 3040 with `reuseExistingServer: true` causes e2e to fail if a different-branch server occupies 3040. Should use an env var (`PLAYWRIGHT_BASE_URL` / `PORT`). Not introduced by this PR; follow-up item.
3. **No focus trap in dialog**: Keyboard users can tab outside the feedback sheet. Acceptable for MVP; add focus trap in a follow-up.
4. **`UpstashFeedbackStore.clear()` does not purge rate-limit keys**: Rate keys have TTL, so this is fine in production and irrelevant in tests (fresh store per test). Document in the method or note in a follow-up if a test-reset scenario ever needs it.

---

## Follow-ups confirmed (from dev report and security gate)

- Micro-prompts (1/session, dismissible) — after first song played, after host session end.
- Provision Upstash for durability in the live app.
- Security L1: IP-keyed secondary rate-limit cap (mitigate uuid-rotation bypass).
- Security L2: sanitize feedback text at every HTML-rendering consumer (before the intake dashboard).
- Playwright port parameterization (INFRA-1).

---

## Verdict

**[reviewer] APPROVE** — Implementation is spec-faithful, ownership discipline is clean, 106/106 unit tests green (reviewer-verified), build clean, e2e 3/3 confirmed (app tester + correct-port replay), security M1 fixed correctly. The watermark design is sound for the current scale; the same-ms non-determinism is a noted-and-acceptable trade-off. No blockers. All gates pass. Ready to merge (per sequential-merge rule, merge after or rebase on top of PR #10 if that merges first).

---

# Opus merge-counting second pass (D-022 / D-011)

- **Reviewer:** Reviewer agent — opus judgment tier (the merge-counting pass)
- **Date:** 2026-07-05
- **Verdict:** **APPROVE** (merge-counting)
- **Self-verified this pass:** `npx jest` → 106/106 green; `npm run build` → green (8/8 static, `/api/feedback` dynamic route registered); `gh pr checks 11` → Vercel pass + Vercel Preview Comments pass, **no required check pending** (S1 satisfied — the dev report's "CI billing broken" note is stale; checks are terminal-green).

## Focus of this pass — the intake contract (load-bearing: the house feedback-intake loop programs against this export)

I re-scoped the watermark risk the first pass filed as a NIT. **The first pass under-characterized it.** The gap is not merely "astronomically unlikely same-millisecond random-suffix non-determinism" — it is a broader **commit-reordering** gap:

- `id` is stamped at `generateFeedbackId()` (POST, from `Date.now()`) but the record becomes listable only after `rpush(feedback:index)`, which commits ~one Upstash round-trip *later* (`add()` does `set(item)` then `rpush`). So **id-timestamp order ≠ index-commit order** whenever writes overlap.
- `list({since})` filters `id > since` and the intake advances `since` to the newest id in each page. A concurrent writer whose id-timestamp is *older* than the current watermark but whose `rpush` commits *after* an intake read is filtered out by `id > since` on every subsequent read → **silent, permanent loss**.
- Scope of exposure: on the Upstash (production) driver the index is a single shared list, so the reordering is **global across lambdas**, not per-lambda; the loss window is the `set`+`rpush` latency (tens of ms), not sub-ms. A busy burst straddling an intake poll could drop more than one entry, not "one at worst."

**Why this is still an APPROVE, not REQUEST-CHANGES:**
1. AC3 ("retrievable by the admin read path with a `since` watermark") is literally met — the contract *works*; completeness-under-concurrency is not an AC of this ticket.
2. The read path is **not consumed yet** (#12 feedback-intake agent is future, framework-side per D-046). Nothing inherits the hole today.
3. It is **paper-over-able by the consumer** without a server change: the intake can (a) hold the watermark back by a small safety margin (the `set`+`rpush` window is bounded well under a second) + dedupe by processed-id set, or (b) run a periodic status-based safety re-scan for stray `status:"new"` items. Per role discipline ("request changes for correctness the consumer can't paper over — not for taste"), this stays a documented follow-up.

**But the record must be corrected so #12 is built defensively.** The code comments + first-pass review oversell the guarantee ("a clean lexicographic cut", "sound for the intake's idempotency"), which would lead a future intake author to a naive advance-to-max loop that silently loses feedback. Recorded as a **HIGH-severity contract caveat**, required **before/with #12** (not optional):

> **REQUIRED-BEFORE-#12:** Either make the index commit-ordered (watermark on list position / an atomically-assigned sequence instead of a value-derived id), OR document the true guarantee at the contract boundary and mandate the robust consumption pattern (lagging watermark + id dedupe, or status re-scan). Do not build the intake against a naive `since = max(id)` advance loop.

### Other contract findings (all NIT / follow-up, none blocking)

- **PATCH is get-modify-set without CAS (NIT).** `updateStatus` reads the record, mutates `status`, writes the whole record back — last-write-wins. Fine now: the intake is a single sequential writer and mark-processed is idempotent (`new→triaged` re-applied = `triaged`), so AC5 idempotency holds. Flag for when #15 close-the-loop (`→shipped`) can write concurrently with #12 — a concurrent pair could clobber. CAS/atomic field-update recommended then.
- **`list()` pulls the whole index every call (NIT / scale).** `lrange(index, 0, -1)` then in-memory sort/filter/slice — `limit` is applied client-side, not at Redis, and the index grows unbounded. Harmless at early-access volume; revisit before high feedback volume.
- **`add()` write order is correct.** `set(item)` before `rpush(index)` means a crash leaves an unindexed orphan item (never listed) rather than a dangling index pointer — the safe failure direction. Documented in-code. ✓

## Volatility honesty — product-integrity call (needs-user bump, not a blocker)

The confirmation copy promises *"Valeu! Um robô supervisionado por humanos lê cada um desses."* The live app runs the **memory driver** until Upstash is provisioned — feedback lands in per-lambda memory, is unreadable by any intake, and evaporates on lambda recycle. So the promise is currently **unkept in production** (compounded by #12 not existing yet). The widget itself is correct and the gap is documented internally (module header, `.env.example`, dev report) — this is not a code defect and not a merge-blocker. But a lost early-access user's feedback is a real product cost against the TL's stated differentiator. **Recommendation to the TM: bump "provision Upstash for the feedback store" to needs-user URGENT** and provision it before leaning on the loop — every day on the memory driver silently loses the product's fuel.

## Widget UX judgment on the live product (PASS)

- **FAB occlusion:** grep confirms the patron page (`app/page.tsx`) and `globals.css` carry **no `position:fixed`/`sticky`/fixed-bottom CTA**, so the FAB (`right:16 bottom:16`, 48px, z-index 1000) occludes nothing in the submit-song flow — content scrolls under it (standard FAB behavior). The 390px evidence is clear and the 320px reasoning holds precisely because there is no fixed collision partner. (`/host` doesn't exist on this branch yet — TICKET-7 is unmerged — so the host-view case is not yet exercisable; nothing to review there now.)
- **Keyboard-open state:** the sheet is a bottom sheet (`align-items:flex-end`), and the **sentiment row (the primary submit action) sits above the optional textarea** — so even with the mobile keyboard raised, the send taps remain reachable; the textarea is optional. Acceptable.
- **NIT:** the FAB uses a flat `bottom:16px` with no `env(safe-area-inset-bottom)` — on notched iPhones it sits close to the home indicator. Cosmetic; follow-up.

## Rebase surface vs current main (self-checked)

`origin/main` advanced 6 commits (TICKET-8/18 merged) since the branch base. `git merge-tree` shows textual conflicts in exactly two **append-only** files — `.env.example` (both append a block) and `work/events/2026-07.jsonl` (event log, union-append) — both trivially resolvable by keeping both sides. **No code conflict:** #11 touches `app/layout.tsx` (unchanged on main), not `app/page.tsx` (which TICKET-8 rewrote). The first pass's "collision with PR #10" note is now moot — #10 hasn't merged; #8/#18 did — and the surface is still trivial.

## Verdict

**[reviewer] APPROVE (opus merge-counting).** Correct, spec-faithful, well-tested (106/106 self-verified), build + CI terminal-green, ownership clean, rebase surface trivial. No merge-blocker. Two things travel with the merge as recorded conditions, neither gating this PR: (1) the **HIGH-severity intake-contract caveat above is required before/with #12** so the intake is built against the true (weaker) completeness guarantee, not the over-sold "clean cursor"; (2) recommend the TM escalate **Upstash provisioning as needs-user URGENT** so the widget's promise stops silently losing early-access feedback.
