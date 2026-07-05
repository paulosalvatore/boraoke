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
