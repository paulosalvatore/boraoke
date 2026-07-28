# boraoke — Product Session Rules

This is a product repo of the **agentic software house**. Framework, agent prompts, workflows, and decisions live in `paulosalvatore/agentic-software-house` (local checkout: `~/Documents/GitHub/agentic-software-house`). Read that repo's `docs/ARCHITECTURE.md`, `docs/WORKFLOWS.md`, and `docs/DECISIONS.md` before orchestrating.

## Product

Free, embeddable karaoke-queue platform for bars: patrons join with uuid+nickname, search YouTube, submit songs to a shared queue; the venue screen plays via the YouTube IFrame embed. See `work/tickets/TICKET-0-bootstrap.md` for the full definition.

- **Stack:** single Next.js app (App Router, API routes). Deviation from D-013, TL-approved.
- **Deploy:** Vercel free tier.

## Rules

- **Roles:** interactive session = Tech Manager (orchestration only, no code). Spawned agents load `agents/<role>.md` from the framework repo.
- **Prompt archiving:** the interactive TM archives every TL prompt (and modal answers) via the framework repo's `scripts/archive-prompt.sh` with `--product boraoke` — prompts live ONLY in the framework repo (D-015). Subagents never archive.
- **Gates are sequential (D-007):** plan gate → dev → test gate → security → review (D-022 opus where applicable) → merge. All changes via PRs from TICKET-1 on; the bootstrap commit was the only direct-to-main.
- **Worktrees (D-008, D-033):** one shared worktree per ticket at `<repo>/.worktrees/<slug>` (inside the repo, never tracked).
- **Verdict comments (D-011):** gate agents record PASS/FAIL verdicts as PR comments in the fixed format.
- **Commits:** always via the framework `commit` skill / `git-commit-writer` — explicit file lists, never `git add -A`, never hand-run bare git mutations.
- **Framework changes (D-046):** this tab never edits framework files; file a note to the framework repo's `work/self-improvement/inbox/` instead.
- **Status truth:** keep `work/status/BOARD.md` and `MANAGER-LOG.md` accurate at every checkpoint — board-vs-reality drift is a HIGH-severity failure.
