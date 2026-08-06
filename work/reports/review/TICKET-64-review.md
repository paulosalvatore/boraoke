# TICKET-64 — Reviewer report (opus, D-022 gate)

- Branch: `ticket/64-docs-record-nits` · worktree `.worktrees/ticket-64` · merge-base `46d25cd`
- Reviewer context: clean. Every claim below is backed by a command I ran in this worktree.

## VERDICT: APPROVE

**Round 1 was REQUEST-CHANGES on two findings (R-1, R-2). Both were fixed and I re-verified them independently in round 2 — see "Round 2 re-review" at the bottom. Verdict flipped to APPROVE.**

The safety invariant holds perfectly (no live identifier touched, 39/39 — re-confirmed in round 2), the code-comment work is correct, and the two record-accuracy defects are resolved. Tests 613/613.

---

## 1. `cantai` occurrence count — PASS (invariant intact)

**BEFORE** — `git grep -c "cantai" origin/main -- app lib components next.config.ts __tests__`:

```
origin/main:__tests__/metadata.test.ts:1
origin/main:app/(patron)/[room]/PatronRoom.tsx:11
origin/main:app/new/page.tsx:1
origin/main:app/page.tsx:2
origin/main:components/feedback/useFeedbackContext.ts:6
origin/main:lib/host-auth.ts:7
origin/main:lib/identity.ts:2
origin/main:lib/room-memory.ts:4
origin/main:lib/rooms.ts:2
origin/main:lib/screen-token.ts:2
origin/main:next.config.ts:1
```

Sum = **39**

**AFTER** — `grep -rn "cantai" app lib components next.config.ts __tests__ | wc -l` → **39**

**39 before, 39 after — identical.** No live-identifier regression.

## 2. No live identifier touched — PASS

`git diff origin/main -- app lib components next.config.ts __tests__` touches exactly two files, and in both the diff is **comment-only** (lines inside a `/** ... */` block). No statement, expression, or string literal changed.

Byte-identical to `origin/main` (empty `git diff --stat`):

- `__tests__/metadata.test.ts` — negative assertion intact at line 16: `expect(JSON.stringify(metadata.title)).not.toMatch(/cantai/i);`
- `next.config.ts` — legacy-host redirect intact at line 19: `has: [{ type: "host", value: "cantai-snowy.vercel.app" }]`
- All localStorage / HMAC identifiers intact and unmodified, verified by grep: `cantai_patron_uuid`, `cantai_host*`, `cantai_rooms_v1` (`lib/room-memory.ts:41`), `cantai_last_room`, `cantai:<room>:*`, and the frozen HMAC salt `"cantai-hostcode-v1"` (`lib/rooms.ts:101`).

## 3. POWERED_BY_FOOTER comments — PASS, wording is technically correct

Zero non-comment lines changed in either file (full diff reviewed; the only `-`/`+` pairs are inside JSDoc blocks).

I verified the nuance the new wording asserts, rather than accepting it:

- `app/(patron)/[room]/tv/page.tsx:18` — `export const dynamic = "force-dynamic";`
- `app/(patron)/[room]/tv/page.tsx:49` — `poweredByFooter={resolvePoweredByFooter(process.env.POWERED_BY_FOOTER)}`, i.e. the env read genuinely happens inside the request-scoped render of a force-dynamic route, not at module init or build time.
- `components/tv/config.ts` — `resolvePoweredByFooter` is a pure function over a raw value; it holds no cached env read.

So "no CODE deploy is needed to pick up the flag, but on Vercel changing the env var's VALUE still requires a redeploy" is accurate and correctly scoped — the old wording ("WITHOUT a rebuild") was the misleadingly incomplete half. Neither overstated nor understated. The two files' phrasings are consistent with each other.

## 4. `work/roadmap.md` factual claims — MOSTLY PASS, one FINDING

Independently verified via `git log --oneline origin/main` and `gh pr list --state all`:

| Claim | Verified |
|---|---|
| TICKET-20 = PR #17 merged | ✅ `da28d0a` / merged 2026-07-07 |
| TICKET-21 = PR #16 merged | ✅ `b271d57` / merged 2026-07-07 |
| TICKET-22 = PR #15 merged | ✅ `60448c9` / merged 2026-07-07 |
| TICKET-23 = PR #18 merged | ✅ `e2977f4` / merged 2026-07-08 |
| TICKET-33 rebrand = PR #20 merged 2026-07-08 | ✅ `a1129ed` / merged 2026-07-08 |
| TICKET-33a brand assets = PR #19 merged 2026-07-08 | ✅ `d57d858` / merged 2026-07-08 |
| TICKET-26 = PR #37 merged 2026-07-20 | ✅ `dba1cbb` / merged 2026-07-20 |
| TICKET-31 = PR #38 merged 2026-07-20 | ✅ `f9a1e3e` / merged 2026-07-20 |
| TICKET-30 i18n = PR #23 merged, ahead of its wave-5 slot | ✅ `e798de5` / merged **2026-07-09** — genuinely earlier than the wave-5 items around it; the roadmap's "delivered well ahead of this proposed wave-5 slot" is supported |
| `https://boraoke.com/` live | ✅ `curl -s -o /dev/null -w '%{http_code}' https://boraoke.com/` → **200** |
| TICKET-48 host-login throttle = PR #30 merged | ✅ `gh pr list` shows #30 MERGED 2026-07-11 |

### 🔴 FINDING R-1 (must fix) — the roadmap describes PRs #39–#42 as OPEN; all four are MERGED, and the branch itself contains their merge commits

`gh pr list --state all --json number,state,mergedAt`:

```
#39 MERGED 2026-08-05T21:40:34Z
#40 MERGED 2026-08-05T21:40:38Z
#41 MERGED 2026-08-05T21:40:27Z
#42 MERGED 2026-08-05T21:40:30Z
```

This is not the tolerable "true as of its stated date, has since moved" case. The four merge commits are **ancestors of this branch's own HEAD** — `git log --oneline HEAD` shows `3f5323c (#39)`, `46d25cd (#40)`, `c7951c7 (#41)`, `37a4035 (#42)`, and the merge-base with `origin/main` is `46d25cd`, which *is* PR #40's merge commit. So the branch was cut from a `main` that already contained all four merges, and the doc was written on top of that state. The claim was false when written, on the very date it is stamped 2026-08-05.

Affected present-tense claims, all requiring correction:

- `work/roadmap.md:31` — heading "Recently delivered, gate-green, **awaiting the TL's merge** (as of 2026-08-05)"
- `work/roadmap.md:33` — "**Four PRs currently sit open**, all verified `MERGEABLE`/`CLEAN` …"
- `work/roadmap.md:39` — "The Upstash search cache (**PR #39, open**) is the mitigation…"
- `work/roadmap.md:95` — wave-4 row 24: "search cache → TICKET-55 (**PR #39, open, gate-green**)"
- `work/roadmap.md:142` — "The Upstash search cache (PR #39, gate-green, **awaiting merge**)"
- `work/roadmap.md:145` — "the deliver-not-merge pile (**currently PRs #39, #40, #41, #42**)"

The irony is load-bearing: the ticket exists to remove "marked in progress when actually merged" staleness from the roadmap, and it introduces a fresh instance of exactly that class. Rewrite these as merged-2026-08-05 facts. The "Merge cadence" open question at line 145 can survive as a standing question, but must not cite an already-drained pile as current.

Everything else in the rewritten roadmap checks out, including the header count "42 PRs merged" (PR #42 is the highest, all 1–42 MERGED).

## 5. `work/tickets/TICKET-58-run-app-stale-clone-path.md` — one FINDING

Verified against the real record:

- PR number, title, merge date: ✅ `37a4035 TICKET-58: repoint run-app skill at the canonical boraoke clone (was the stale 28-behind duplicate) (#42)`, `gh` confirms MERGED 2026-08-05.
- "28 commits behind", the mis-classification-as-cosmetic origin on PR #41, "no ticket file filed at delivery time / D-002 drift": ✅ all corroborated by `work/status/MANAGER-LOG.md` lines 16, 443, 444, 452.
- The `git push -u` / worktree-upstream-points-at-main process note: ✅ corroborated by MANAGER-LOG lines 443–453 and the follow-up removal note at line 468.
- `npm test` skipped-not-faked at delivery: ✅ MANAGER-LOG:452 records it in those words.

### 🔴 FINDING R-2 (must fix) — the reconstructed ticket file states a fabricated count, and attributes it to the reviewer

The file asserts:

> `cantai` occurrence count across `app/ lib/ components/ next.config.ts __tests__/` was **60 before and 60 after** this branch (reviewer independently re-derived the same count).

I re-derived it at the actual historical commits:

- `git grep -c "cantai" 37a4035 -- app lib components next.config.ts __tests__` → sum **39**
- `git grep -c "cantai" 37a4035^ -- …` (its parent) → sum **39**

So the correct figure for PR #42 is **39/39, not 60/60**. The *invariant* the sentence exists to record (count unchanged across the branch) is true; only the magnitude is wrong. I could not reproduce 60 under any plausible path scope — adding `e2e` gives 46, and the number is not derivable from the stated file set. Since this doc's entire purpose is to be a trustworthy reconstruction, and the wrong number is explicitly laundered through "reviewer independently re-derived the same count", it must be corrected to 39/39 (or the magnitude dropped in favour of the invariant alone).

## 6. `work/youtube-quota-form.md` — PASS

Diff is 2 lines, both additive/clarifying:

- A new status header: drafted-not-submitted, key provisioned since 2026-07-07, ~99-searches/day ceiling until filed.
- An inline parenthetical that "Cantai Karaoke Credentials" is the literal external Google Cloud project name and must not be renamed.

The paste-ready form body below is untouched; no answer text's meaning changed. The not-yet-submitted status is consistent with the roadmap's own YouTube-quota bullet and with BOARD.md's growth-arc decisions.

## 7. File-set containment — PASS

`git status --porcelain`:

```
 M app/(patron)/[room]/tv/page.tsx
 M components/tv/config.ts
 M work/roadmap.md
 M work/youtube-quota-form.md
?? work/tickets/TICKET-58-run-app-stale-clone-path.md
```

`git diff --stat origin/main` = 4 files, +53/−44. Exactly the allowed set. No `components/tv/TvScreen.tsx`, no `components/tv/self-heal.ts`, no `app/(patron)/[room]/PatronRoom.tsx`, no `e2e/*`, no `jest.config.ts`, no `work/status/BOARD.md`. Nothing outside the worktree touched.

## 8. Tests — PASS

`npx jest` (run by me, `node_modules` present in this worktree):

```
Test Suites: 43 passed, 43 total
Tests:       613 passed, 613 total
Snapshots:   0 total
Time:        3.445 s
```

613/613 pass. (Console `warn` output from the ADVANCE_AUTH log-mode observation window is expected pre-existing noise, not a failure.)

---

## Claims I could NOT independently verify

- **PR #42's CI results** ("`build-and-test` pass, Vercel pass, Vercel Preview Comments pass") and the **opus APPROVE-WITH-FOLLOWUPS verdict with "all 7 claims re-derived"** in the reconstructed TICKET-58 file. The PR is merged and I did not fetch its check runs or review threads; MANAGER-LOG corroborates the gate chain in substance but not these specific check names. Plausible, unverified.
- **"28 commits behind"** as a live fact — I verified it is what MANAGER-LOG recorded at heartbeat #33, not that the stale clone is 28 behind today. Correctly framed as historical in the doc.
- **BOARD.md-sourced statuses** in the roadmap's per-row "NOT STARTED / blocked on TL vendor decision" cells. I spot-checked these against BOARD.md references only, not exhaustively; they are the roadmap's weakest-evidence cells but are appropriately hedged with "see `work/status/BOARD.md`".

## What was fixed before merge (round 1 findings)

1. **R-2** — the fabricated "60/60, reviewer independently re-derived" framing in `work/tickets/TICKET-58-run-app-stale-clone-path.md`.
2. **R-1** — the six PR #39–#42 "open / awaiting merge / gate-green" claims in `work/roadmap.md`.

---

# Round 2 re-review (post-fix) — APPROVE

Re-verified from scratch; I did not take the fix report on faith.

## Containment still clean — PASS

`git status --porcelain` / `git diff --stat origin/main` — unchanged file set, no scope creep from the fix pass:

```
 M app/(patron)/[room]/tv/page.tsx
 M components/tv/config.ts
 M work/roadmap.md
 M work/youtube-quota-form.md
?? work/reports/review/TICKET-64-review.md   (this report)
?? work/tickets/TICKET-58-run-app-stale-clone-path.md
```

4 files changed, +53/−44. Product-source diff is byte-for-byte what I approved in round 1: still only the two files, still comment-only (`app/(patron)/[room]/tv/page.tsx` +4/−2 equivalent, `components/tv/config.ts` likewise). The fix pass touched only the two doc files, as claimed.

## Safety invariant re-derived — PASS

- BEFORE `git grep -c "cantai" origin/main -- app lib components next.config.ts __tests__` → sum **39**
- AFTER `grep -rn "cantai" app lib components next.config.ts __tests__ | wc -l` → **39**

**39 / 39, identical.** No live identifier disturbed by the fix pass.

## R-1 — FIXED, all six spots

`grep -n "currently sit open\|awaiting the TL's merge\|PR #39, open\|awaiting merge\|deliver-not-merge pile" work/roadmap.md` now returns only line 148, and that line no longer names a drained pile:

| Spot | Now reads |
|---|---|
| L31 heading | "Recently delivered **and merged** (2026-08-05)" |
| L33 body | "…were all delivered gate-green as a file-disjoint, mergeable-in-any-order batch, and **all four were merged 2026-08-05**." + points at BOARD.md for what is currently open |
| L39 YT bullet | "The Upstash search cache (**TICKET-55, merged**)…" |
| L95 wave-4 row 24 | "search cache → TICKET-55 (**merged, PR #39**)" |
| L142 open question | "The Upstash search cache (**TICKET-55, merged**)…" |
| L148 merge cadence | generalised to "whatever sits in the deliver-not-merge pile **at any given time** (check `work/status/BOARD.md` for the live list)" — survives as a standing TL question without asserting a stale pile |

No present-tense falsehood about PR state remains. (Line 125's leading `| 39 |` is a wave-7 *proposed ticket number*, not PR #39 — correctly left alone.)

## R-2 — FIXED, and the new framing is itself accurate

The ticket file now separates the historical quote from the verified fact, and I checked both halves.

**The quote is genuine.** `git log -1 --format=%B 37a4035` really does say:

> No product source touched: `cantai` occurrence count over non-work/ non-`.claude` paths is 60 before and 60 after — every deliberate localStorage key, host cookie, HMAC salt, legacy-host redirect and the negative metadata assertion is untouched.

So attributing 60/60 to the PR's own commit message, over that broader path scope, is a truthful quotation rather than a laundered invention. It is explicitly hedged ("this report did not re-derive that exact scope/number and does not vouch for it beyond quoting it"), and the same hedge is now mirrored in the gate-chain bullet at line 32. Correct.

**The independently-verified half checks out**, including the SHAs: `git rev-parse --short 37a4035^` → **`c7951c7`**, exactly as the file states, and the 39-before / 39-after figures over the hazard-scope file set are the ones I derived myself.

### Observation O-1 (informational, NOT blocking)

Out of thoroughness I tested the PR's own claimed scope rather than only quoting it:

```
git grep -c "cantai" 37a4035  -- . ':!work' ':!.claude'  → sum 58
git grep -c "cantai" c7951c7  -- . ':!work' ':!.claude'  → sum 58
```

The PR's historical "60" reproduces as **58** today under the most natural reading of "non-work/non-`.claude` paths" — a mild overcount in the original commit message, probably a slightly different exclusion set or a matches-vs-lines difference. **This changes nothing about the verdict:** the invariant the number exists to assert (before == after, no bulk rename) holds under *every* scope tested — 39/39 on the hazard set, 58/58 on the PR's broader set — and the ticket file already declines to vouch for the 60. Recording it only so a future reader who re-derives 58 knows it was seen and judged immaterial. No edit required.

## Tests re-run — PASS

`npx jest`:

```
Test Suites: 43 passed, 43 total
Tests:       613 passed, 613 total
Time:        4.438 s
```

613/613, unchanged from round 1 (expected — product source is byte-identical).

## Final verdict

**APPROVE.** Both round-1 findings are genuinely fixed, the fixes introduced no new inaccuracies and no scope creep, the `cantai` live-identifier invariant is intact at 39/39, and the suite is green. The round-1 "claims I could not independently verify" list above still stands as the honest limit of this review — the ticket file now states its own equivalent caveat in-line, which is the right resolution for a reconstructed historical record.
