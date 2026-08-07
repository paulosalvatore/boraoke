# TICKET-58 — Repoint the `run-app` skill at the canonical boraoke clone

Type: framework/tooling hygiene · Docs-only · Priority: MED
Filed by: opus reviewer on PR #41 (TICKET-57), as a follow-up wrongly classified there as "(b) cosmetic"
Branch: `ticket/58-run-app-stale-clone-path` (worktree `.worktrees/ticket-58`)

## Problem

`.claude/skills/run-app/SKILL.md` told agents to `cd ~/Documents/GitHub/cantai` — the abandoned pre-rename duplicate clone that heartbeat #26 had already flagged as stale. By the time this ticket was picked up (heartbeat fire #33), that duplicate was **28 commits behind `origin/main`** (the board's last recorded figure was 16 — the hazard had grown, not evaporated). This was an **active instruction, not a historical record**: an agent following it silently ran an outdated checkout and produced results that looked valid while being based on stale code. TICKET-57 filed this follow-up but mis-classified it as cosmetic naming debt; the PR #41 reviewer corrected the classification and filed it as its own ticket.

## What changed

- `.claude/skills/run-app/SKILL.md` — both `cd` paths repointed from `~/Documents/GitHub/cantai` to `~/Documents/GitHub/boraoke`.
- The worktree section, previously hardcoded to the long-merged `TICKET-1` example (`cantai/.worktrees/ticket-1`), was generalised to the D-033 `<repo>/.worktrees/<slug>` placeholder so a future ticket number can't let the same staleness recur.
- 1 file, +5/-3.

## Explicitly OUT of scope (guardrail honored)

- No `cantai*` product-code identifier touched. These are deliberate: live `localStorage` keys, the `cantai-snowy.vercel.app` legacy-host redirect, and the negative metadata assertion — renaming any of them would drop live patron identity. The PR's own commit message claimed the `cantai` occurrence count over non-`work/`, non-`.claude` paths was 60 before and 60 after (this report did not re-derive that exact scope/number and does not vouch for it beyond quoting it). What this TICKET-64 report DID independently verify, at PR #42's merge commit (`37a4035`) and its parent (`c7951c7`), over the TICKET-64 hazard-scope file set (`app/ lib/ components/ next.config.ts __tests__/`): **39 before and 39 after** — unchanged, no drift, no bulk rename.
- The root-cause fix — retiring/relocating the actual stale `~/Documents/GitHub/cantai` duplicate clone (which also still holds the only local `.env`/`.env.local`) — stays a TL/GATED action, not this ticket's scope. This ticket only stops the fleet's own tooling from pointing at it.

## Test / build results

- `npm test` — **skipped, not faked**: no `node_modules` in the fresh worktree at delivery time; docs-only change with zero runtime consumers (a `SKILL.md` is not imported/compiled by anything). Reviewer judged this acceptable given the change shape, and PR #42's CI (`build-and-test`) covered the branch independently.
- CI on PR #42: `build-and-test` pass, `Vercel` pass, `Vercel Preview Comments` pass.

## Gate chain

- Dev: 1 file, +5/-3, docs-only.
- App Tester: **N/A** (docs-only, no UI, no runtime code).
- Cyber: **N/A** (no auth/data/input surface).
- Reviewer (at the time of PR #42, per `work/status/MANAGER-LOG.md`): **opus D-022 APPROVE-WITH-FOLLOWUPS** — all 7 claims independently re-derived at the time, including the 28-behind count and the safety invariant (60/60 `cantai` occurrences claimed over the PR's own non-work/non-.claude path scope — see the caveat above, this TICKET-64 report did not re-derive that exact number — byte-identical hazard set, 29 hazard lines intact).

## Process note (recorded, not hidden)

Mid-delivery, `commit-and-push.sh` failed with "offline or non-fast-forward" while pushing this branch. Root cause (reviewer-confirmed, and the larger finding of this fire): the worktree's upstream had been auto-set to `refs/heads/main` by `git worktree add -b <branch> origin/main` (the D-033 creation pattern) — pushing this branch's commits would otherwise have landed directly on `origin/main`, bypassing the PR and the gate chain, and auto-deploying live boraoke.com. It was NOT actually offline (`git ls-remote --exit-code origin HEAD` succeeded). Contained via `git-commit-writer` running `git push -u origin ticket/58-run-app-stale-clone-path` to create the branch's own remote ref and repair the upstream; `origin/main` verified unchanged before and after, nothing leaked. The class-level fix (refuse-to-push guard / `--no-track` at worktree creation) was filed separately under `work/self-improvement/inbox/` per CLAUDE.md §6 — not fixed from this product ticket.

## Delivery

**DELIVERED / MERGED — PR #42**, `TICKET-58: repoint run-app skill at the canonical boraoke clone (was the stale 28-behind duplicate)`, merged 2026-08-05.
https://github.com/paulosalvatore/boraoke/pull/42

No ticket file was filed at delivery time (heartbeat fire #33), which the PR #42 reviewer flagged as D-002 record drift. This file reconstructs that record from `work/status/BOARD.md` and `work/status/MANAGER-LOG.md` (TICKET-64).
