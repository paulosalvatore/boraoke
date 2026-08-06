# TICKET-64 — Dev Report — De-stale living docs + POWERED_BY_FOOTER comment accuracy + missing TICKET-58 record

**Status:** Implemented, self-verified, opus-reviewed (APPROVE after one REQUEST-CHANGES round, both findings fixed and re-verified). Docs-and-comments-only ticket; no product behavior changed.

## What changed

1. **New `work/tickets/TICKET-58-run-app-stale-clone-path.md`** — reconstructed the ticket record for already-merged PR #42 (TICKET-58, repoint the `run-app` skill at the canonical boraoke clone), matching the structure of neighboring ticket files. Sourced from `work/status/BOARD.md`, `work/status/MANAGER-LOG.md` (lines around #16, #443–453, #452, #468) and the actual PR #42 commit history. Marked DELIVERED/MERGED (PR #42).
2. **`components/tv/config.ts` and `app/(patron)/[room]/tv/page.tsx`** — corrected the `POWERED_BY_FOOTER` doc-comments. The old wording ("read at request time, no rebuild needed") was true of the code path but misleading on Vercel, where changing an env var's *value* still requires a redeploy to take effect. Comment text only — zero code/behavior change in either file.
3. **`work/roadmap.md`** — brought current against `work/status/BOARD.md`, `MANAGER-LOG.md` and `git log`/`gh pr list`: title corrected from "cantai" to "boraoke — Product Roadmap v2"; naming section corrected (rebrand executed as TICKET-33/PR#20, merged 2026-07-08; DNS live since 2026-07-08, `boraoke.com` re-verified HTTP 200); TICKET-20/21/22/23 corrected from "in progress" to their actual merged PRs (#17/#16/#15/#18, all 2026-07-07/08); the "Where we are" section rewritten with current LIVE feature set and a status column added to the wave 4/5/6 tables reflecting actual delivery (TICKET-26 merged PR #37, TICKET-31 merged PR #38, TICKET-30 i18n merged PR #23 — ahead of its proposed wave-5 slot); dependency edges and open questions updated to match.
4. **`work/youtube-quota-form.md`** — added a status header (drafted, not yet submitted; key provisioned in prod since 2026-07-07) and a note that "Cantai Karaoke Credentials" is the literal external Google Cloud project name and is out of scope for renaming. The paste-ready form body is untouched.

## Explicitly OUT of scope / untouched (the hazard)

Per the ticket's hazard list, no `cantai*` product-source identifier was touched: live `localStorage` keys, the `cantai-snowy.vercel.app` legacy-host 308 redirect in `next.config.ts`, the negative assertion in `__tests__/metadata.test.ts`, and the frozen HMAC salt `"cantai-hostcode-v1"` in `lib/rooms.ts` are all byte-identical to `origin/main`. No historical record (`work/status/MANAGER-LOG.md`, past ticket files) was "corrected" — those stay exactly as written.

## Verification

**`cantai` occurrence count, product source (`app lib components next.config.ts __tests__`):**

- BEFORE (`origin/main`), via `git grep -c "cantai" origin/main -- app lib components next.config.ts __tests__` summed: **39**
- AFTER (working tree), via `grep -rn "cantai" app lib components next.config.ts __tests__ | wc -l`: **39**

**39 before, 39 after — identical.** No regression; verified independently by the opus Reviewer in both review rounds.

**`npm test` (`npx jest`):**

```
Test Suites: 43 passed, 43 total
Tests:       613 passed, 613 total
Snapshots:   0 total
Time:        4.636 s
Ran all test suites.
```

**`npx tsc --noEmit`:** produces the same pre-existing errors on this branch as on a clean `origin/main` checkout (`__tests__/youtube.test.ts` missing jest globals in the tsc-only pass, `e2e/advance-auth.spec.ts` a Playwright `request.fetch` typing issue) — confirmed identical via `git stash` / `git stash pop` before and after this branch's edits. Zero new tsc errors introduced by the comment-only changes.

## Reviewer gate

**opus D-022, clean context.** Round 1: **REQUEST-CHANGES** — two findings:
- **R-1**: `work/roadmap.md` described PRs #39–#42 as open/awaiting-merge; `gh pr list` showed all four merged 2026-08-05, and the branch itself already contains those merge commits (merge-base with `origin/main` is PR #40's own merge commit). Fixed at all 6 flagged spots.
- **R-2**: The reconstructed TICKET-58 ticket file stated a fabricated "60/60 cantai occurrences, reviewer independently re-derived" claim; the reviewer's own re-derivation at PR #42's merge commit and parent came to 39/39 for the stated file scope. Fixed by separating the PR's own historical commit-message quote (60/60, different/broader path scope, not re-verified) from the independently-verified 39/39 figure over the TICKET-64 hazard-scope file set.

Round 2 (post-fix): **APPROVE.** The reviewer re-derived the 39/39 count from scratch, re-confirmed containment (only the 4 allowed files + 1 new file touched), re-ran `npx jest` (613/613), and confirmed both findings were resolved without overclaiming in the fix. Full report: `work/reports/review/TICKET-64-review.md`.

## Out of scope / left for others

- The root-cause `~/Documents/GitHub/cantai` stale clone cleanup (holds the only local `.env`) — TL/GATED action, tracked on the board, not touched here.
- Merging this PR — Tech Manager's call, per this product's fully-GATED (every `main` merge auto-deploys live boraoke.com) carve-out.
