# cantai — Manager Log

## 2026-07-05 — Bootstrap

- W9 definition agreed with TL (session 2026-07-05-session-003, prompts 001–002 in framework repo): slug `cantai`, single Next.js app (D-013 deviation, TL-approved), Vercel free tier deploy (TL-approved).
- Repo `paulosalvatore/cantai` created (private) and template pushed — the one sanctioned direct-to-main commit.
- Branch protection skipped (GitHub Free + private repo, known 403).
- Next: needs-user round (W7 — Vercel account, YouTube API key if needed), then TICKET-1 walking skeleton.

## 2026-07-05 — Fleet fan-out (TL directive, session-003 prompt 003)

- TL directive: parallelize fronts, fully-autonomous POC, Designer on fable, Devs on opus/fable going forward.
- Running in parallel: TICKET-1 walking skeleton/prototype core (Dev, sonnet — launched pre-directive, kept to avoid waste; D-022 opus review still gates it), TICKET-3 rotation/fairness engine lib (Dev, opus, packages/rotation-engine, new-files-only), TICKET-4 design language + mockups (Designer, fable), TICKET-5 roadmap + rotation/feedback/monetization specs (PO, fable).
- Collision control: TICKET-1 owns app code + CI; TICKET-3 new package dir only; TICKET-4/5 markdown/HTML/PNG only. One worktree per ticket (.worktrees/ticket-N).
- Model policy for cantai from now on: Dev = opus (fable for judgment-heavy/creative), Designer/PO = fable, gates stay cheap (sonnet/haiku).

## 2026-07-05 — First merges + Vercel unblocked (prompt 004)

- PR #1 (TICKET-5 roadmap/specs) MERGED after Reviewer REQUEST-CHANGES→fix→APPROVE cycle (B1 graceRequeue schema, B2 nowPlaying semantics); opus-skip recorded (docs-only). Event-log add/add conflict resolved by union (haiku git-ops agent).
- PR #2 (TICKET-4 design) TL-RATIFIED ("Very good UI proposal"); TL follow-up filed as TICKET-18 (TV mode bigger type + fullscreen). Merge in flight (same event-log conflict class, same haiku agent).
- PR #3 (TICKET-3 engine) sonnet APPROVE (reviewer independently re-ran 40/40 tests); D-022 opus merge-counting pass dispatched. App Tester + Security waived N/A-by-content (zero-dep pure lib) — waiver recorded here.
- PR #4 (TICKET-1 app) delivered (25 unit + 1 e2e + build green); App Tester gate running.
- TICKET-2 UNBLOCKED: TL connected the Vercel project (vercel.com/paulosalvatores-projects/cantai) and said go — deploy verification runs after PR #4 merges (Vercel GitHub integration auto-builds main).
- Recurring friction: work/events/2026-07.jsonl add/add conflicts on every parallel PR — union resolution works; class-level fix candidate filed mentally for framework (merge=union gitattributes for *.jsonl) — to be filed via inbox.
