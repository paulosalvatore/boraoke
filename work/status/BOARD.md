# cantai — Board

_Last updated: 2026-07-06 (TICKET-6 merged; wave 2 launched)_

## Needs user (TL)

- 🔴 GitHub Actions BILLING broken on paulosalvatore account — CI dies in 2s on every PR ("payments failed / spending limit"). GitHub → Settings → Billing & plans. Binding condition from PR #4 merge exception: first post-merge CI run on main must be verified green after fix.
- 🟡 Upstash Redis provisioning on the Vercel project (Marketplace → Storage) — unblocks TICKET-6 live path (dev proceeds with memory driver).
- 🟡 YouTube Data API v3 key → Vercel env — unblocks TICKET-8 live search (dev proceeds with degraded mode).

## Notes

- Branch protection on `main`: SKIPPED — GitHub Free + private repo (403); gates are process-enforced (D-011).

## Tickets

| Ticket | Title | Status | Notes |
|---|---|---|---|
| TICKET-0 | Bootstrap | DONE | Repo created 2026-07-05; definition in work/tickets/TICKET-0-bootstrap.md |
| TICKET-1 | Walking skeleton / prototype core | DONE | PR #4 merged: full gate chain (App Tester PASS, Security MEDIUMs fixed, sonnet+opus APPROVE); CI billing exception recorded |
| TICKET-6 | Durable persistence (wave 1) | DONE | PR #7 merged: full chain (Security+hardening, sonnet+opus APPROVE; opus verified real @upstash/redis semantics). Upstash activates on TL provisioning |
| TICKET-7 | Host controls (wave 2) | IN PROGRESS | Dev (opus), .worktrees/ticket-7, port 3007 |
| TICKET-11 | Feedback widget (wave 2) | IN PROGRESS | Dev (opus), .worktrees/ticket-11, port 3011; sole owner app/layout.tsx |
| TICKET-3 | Rotation/fairness engine lib | DONE | PR #3 merged: sonnet+opus APPROVE; opus caught real peek≠play starvation bug pre-merge; 47/47 tests |
| TICKET-4 | Design language + mockups | DONE | PR #2 merged, TL-ratified |
| TICKET-5 | Roadmap + specs (modes/feedback/monetization) | DONE | PR #1 merged (Reviewer APPROVE after B1/B2 fixes; opus-skip recorded, docs-only) |
| TICKET-19 | PMF wave ticket batch | DONE | PR #5 merged (Reviewer APPROVE after B1 wave-dependency fix; opus-skip, docs-only). Tickets 6-12+18 armed in waves |
| TICKET-2 | Deploy verification | DONE | PR #6 merged. LIVE: https://cantai-snowy.vercel.app (cantai.vercel.app was name-squatted). All prod e2e checks PASS |
| TICKET-8 | YouTube search (wave 1) | IN GATES | PR #8: App Tester PASS; security MEDIUMs (rate-limiter) fix round |
| TICKET-18 | TV fullscreen + bigger type (wave 1) | IN GATES | PR #9: App Tester PASS; sonnet review running (security waived N/A, no new inputs) |
