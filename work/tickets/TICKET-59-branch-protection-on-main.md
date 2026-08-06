# TICKET-59 — Enable branch protection on `main` (the safety net the board believed already existed)

**Status:** **WON'T-DO — decided 2026-08-06 (interactive TM session, Tech Lead present).** The TL chose to leave `main` unprotected, deliberately. See "Resolution" at the bottom.
**Filed:** 2026-07-29, heartbeat fire #33 (autonomous, unattended)
**Priority:** HIGH (safety) — this is the missing server-side backstop for a defect class that is live in this repo today
**Type:** Infra / repo settings. Zero product code, zero deploy.

## Why this exists

Heartbeat #32 (2026-07-28) found a class-level safety defect — ticket-worktree branches configured with `branch.<ticket-branch>.merge = refs/heads/main`, so the sanctioned `commit-and-push.sh` would push a ticket branch's commits **directly onto `origin/main`**, which on boraoke auto-deploys the live site and bypasses the entire gate chain. That push was rejected, and #32 recorded the reason as:

> "Branch protection rejected it; that rejection was the safety net working, not a glitch."

**That attribution is wrong, and this fire disproved it.** There is no branch protection on this repo:

- `gh api repos/paulosalvatore/boraoke/branches/main/protection` → **404 `"Branch not protected"`**
- `gh api repos/paulosalvatore/boraoke/rulesets` → **`[]`** (no rulesets either)

So nothing server-side rejected that push. What actually rejected it was a plain **non-fast-forward**: `ticket/57` is 2 commits ahead of `origin/main` but also **4 behind** it (`git rev-list --left-right --count origin/main...ticket/57-fix-cantai-product-slug` → `4 2`), and git refuses a non-fast-forward push by default.

## Why that distinction matters (it is not pedantry)

Branch protection would have rejected the push **because it targeted `main`**. A non-fast-forward rejection only fires **because the branch happened to be stale**. Those are not the same guarantee:

**A freshly-created worktree is exactly the case where the accidental protection disappears.** The D-033 pattern is `git worktree add -b <branch> origin/main` — which branches off the *current* tip and (per #32's root cause) auto-tracks that start-point. One commit later that branch is 1 ahead / **0 behind** `main`: a **clean fast-forward**. The push would have **succeeded**, landing ungated code on `main` and auto-deploying live boraoke.com.

In other words the hazard #32 believed was contained by a safety net was contained by **luck** — the luck of the four existing ticket branches all being stale (`ticket/55` 3 behind, `ticket/56` 4 behind, `ticket/57` 4 behind, `ticket/58` 2 behind). The next fresh worktree gets no such luck.

## The blocker for enabling it is also stale

`BOARD.md` "Notes" records: *"Branch protection on `main`: SKIPPED — GitHub Free + private repo (403); gates are process-enforced (D-011)."*

**The premise no longer holds — this repo is PUBLIC.** `gh api repos/paulosalvatore/boraoke --jq '{private,visibility}'` → `{"private": false, "visibility": "public"}`. GitHub has offered branch protection on **public** repos on the Free plan for years; the 403-on-private limitation the note cites simply does not apply. The API's own answer corroborates this: it returned **404 "Branch not protected"** (the endpoint is available, the branch merely has no protection configured), not the **403** the note predicts.

So the cost of enabling protection is now **zero dollars**, and the recorded reason for skipping it is obsolete.

## Proposed change (TL applies — GATED)

Minimum viable protection, matching how the gate chain already works in practice:

```sh
gh api -X PUT repos/paulosalvatore/boraoke/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": false, "contexts": ["build-and-test"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Rationale for each choice, so the TL can adjust deliberately rather than accept a blob:

- **`required_status_checks.contexts: ["build-and-test"]`** — makes the existing green check a *server-enforced* precondition instead of a convention. This alone kills the defect class: a direct branch-push to `main` carries no PR and no check context, so it is refused regardless of fast-forward-ness.
- **`enforce_admins: false`** — the TL stays able to merge/hotfix without fighting the rule. Set `true` only if the TL wants the rule to bind them too.
- **`required_pull_request_reviews: null`** — deliberately NOT requiring a human review approval, because the house gate chain (D-022 opus Reviewer) records approval as a verdict comment, not a GitHub review (D-011). Requiring GitHub reviews here would block the TL's own solo merges for no added safety.
- **`allow_force_pushes: false` / `allow_deletions: false`** — cheap, no downside.

**Not decided here (TL's call):** whether `enforce_admins` should be `true`, and whether to require a PR at all (`required_pull_request_reviews` with `required_approving_review_count: 0` would force the PR flow without forcing an approver). Both are workflow-preference questions, not safety questions.

## Related, filed separately for the TL — repo visibility

This repo is **public**. `CLAUDE.md` §4 of the framework records that this account's products use **private** repos, and this product's own board note assumed private. That mismatch is worth a deliberate decision.

**No secret is exposed** — verified this fire by an independent read-only probe: `.gitignore` covers `.env` / `.env.*` / `.env*.local` with `!.env.example`; the only `.env*` blob ever added in all of history is `.env.example` (commit `8e51e9b`); `git log --all -p -S` over `AIza`, `UPSTASH_REDIS_REST_TOKEN`, `NEXTAUTH_SECRET`, `sk_live` and `AKIA` found **zero** real values — only `process.env.*` references, board prose naming the variables, and one obviously-fake test fixture (`https://fake.upstash.io` / `"faketoken"` in `__tests__/rate-limit-counter.test.ts`). **Verdict: CLEAN.**

So this is a governance question ("did you mean this repo to be public?"), not an incident. If public is intentional, it is also what makes TICKET-59 free — worth noting the two findings point in opposite directions.

Minor stale field spotted alongside: the repo's `homepage` is still `https://cantai-snowy.vercel.app` (pre-rebrand). Cosmetic; fold into the naming housekeeping if convenient.

## Acceptance criteria

1. `gh api repos/paulosalvatore/boraoke/branches/main/protection` returns 200 with `required_status_checks.contexts` including `build-and-test`.
2. A direct push of a fast-forward commit from a ticket worktree onto `main` is **refused by the server**, not merely by fast-forward luck.
3. `BOARD.md`'s "Notes" line is corrected — the "GitHub Free + private repo (403)" rationale is retired, replaced by the actual configured state.
4. The TL has recorded a deliberate answer on repo visibility (public intentional, or flip to private).

## Resolution — 2026-08-06 (interactive TM session, Tech Lead present)

**Decided: leave `main` unprotected. TICKET-59 is closed WON'T-DO.**

The three claims above still hold and were re-confirmed this session: no protection (`branches/main/protection` → 404), no rulesets (`[]`), repo still public. The TL reviewed the proposed minimum-viable protection (require `build-and-test`, no required GitHub reviews, no force-push/deletion) and chose not to apply it.

**Accepted risk, recorded plainly rather than left implicit:** there is no server-side backstop on `main`. A freshly-created ticket worktree, being 0 commits behind at creation, can push a fast-forward commit straight onto `main` and auto-deploy live boraoke.com without going through any gate. The 2026-07-28 near-miss (heartbeat #32) was stopped by the branch in question happening to be stale (a non-fast-forward rejection), not by any protection that actually exists — that was luck, not a safety net, and this ticket's whole finding is that the luck will not always hold. The TL's call is to accept that risk rather than add the server-side check.

Acceptance criteria 1–2 above are deliberately NOT met and will not be pursued. Criterion 3 (BOARD.md Notes line correction) is done — see `work/status/BOARD.md` Notes section. Criterion 4 (repo-visibility governance question) remains open as a separate, smaller question — not blocking this closure.
