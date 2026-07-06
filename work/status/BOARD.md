# cantai — Board

_Last updated: 2026-07-06 (10 PRs merged; feedback widget LIVE; PR #10 in review)_

## Needs user (TL)

- 🔴 GitHub Actions BILLING broken on paulosalvatore account — CI dies in 2s on every PR ("payments failed / spending limit"). GitHub → Settings → Billing & plans. Binding condition from PR #4 merge exception: first post-merge CI run on main must be verified green after fix.
- 🔴 **URGENT (upgraded by PR #11 opus pass): Upstash Redis provisioning** on the Vercel project (Marketplace → Storage → add UPSTASH_REDIS_REST_URL/TOKEN env). Until then, LIVE user feedback AND queues silently evaporate per-lambda — the feedback widget promises "um robô lê cada um" but memory-driver feedback is lost. One dashboard action makes queues + feedback durable, zero code changes.
- 🟡 YouTube Data API v3 key → Vercel env — unblocks TICKET-8 live search. ⚠️ QUOTA REALITY (opus PR #8 finding, binding condition): default quota = 10,000 units/day and each search costs ~101 units → ~99 searches/day TOTAL across ALL venues; one modest bar night ≈ 80% of it. Before provisioning the key: file a YouTube quota-increase request (or accept day-one degraded fallback), and consider the filed follow-up (move search cache + rate limits onto Upstash so caching actually reduces burn).

## Follow-ups (filed by gates, unscheduled)

- **BINDING before the feedback-intake ticket (#12/framework intake): Intake-contract condition (PR #11 opus, HIGH)** — feedback ids are stamped at POST but index-commit lands later; id-order ≠ commit-order under concurrent writes, so a naive `since = max(id)` cursor can silently lose entries forever. Intake MUST use lagging watermark + id-dedupe (or the index made commit-ordered) — never the naive loop.
- Host login throttle → edge/Upstash-backed (per-lambda in-memory now; PR #10 M-1 note).

- Upstash-backed search cache + rate buckets (PR #8 opus rec — biggest quota lever; also makes rate limit cross-instance).
- Advance-guard for the double-advance race (ENDED vs skip; pre-existing, LOW).
- setQueue if-changed diff on /tv (render churn, LOW).
- POWERED_BY_FOOTER doc nit: env change needs redeploy on Vercel.
- Design-token consolidation (tv CSS module duplicates TICKET-4 tokens deliberately).

## Notes

- Branch protection on `main`: SKIPPED — GitHub Free + private repo (403); gates are process-enforced (D-011).

## Tickets

| Ticket | Title | Status | Notes |
|---|---|---|---|
| TICKET-0 | Bootstrap | DONE | Repo created 2026-07-05; definition in work/tickets/TICKET-0-bootstrap.md |
| TICKET-1 | Walking skeleton / prototype core | DONE | PR #4 merged: full gate chain (App Tester PASS, Security MEDIUMs fixed, sonnet+opus APPROVE); CI billing exception recorded |
| TICKET-6 | Durable persistence (wave 1) | DONE | PR #7 merged: full chain (Security+hardening, sonnet+opus APPROVE; opus verified real @upstash/redis semantics). Upstash activates on TL provisioning |
| TICKET-7 | Host controls (wave 2) | IN REVIEW | PR #10: App Tester PASS, Security folded (117/117); sonnet review running |
| TICKET-11 | Feedback widget (wave 2) | DONE | PR #11 merged (151/151 on merged tree). Intake-contract condition + Upstash URGENT recorded |
| TICKET-3 | Rotation/fairness engine lib | DONE | PR #3 merged: sonnet+opus APPROVE; opus caught real peek≠play starvation bug pre-merge; 47/47 tests |
| TICKET-4 | Design language + mockups | DONE | PR #2 merged, TL-ratified |
| TICKET-5 | Roadmap + specs (modes/feedback/monetization) | DONE | PR #1 merged (Reviewer APPROVE after B1/B2 fixes; opus-skip recorded, docs-only) |
| TICKET-19 | PMF wave ticket batch | DONE | PR #5 merged (Reviewer APPROVE after B1 wave-dependency fix; opus-skip, docs-only). Tickets 6-12+18 armed in waves |
| TICKET-2 | Deploy verification | DONE | PR #6 merged. LIVE: https://cantai-snowy.vercel.app (cantai.vercel.app was name-squatted). All prod e2e checks PASS |
| TICKET-8 | YouTube search (wave 1) | DONE | PR #8 merged (123/123 on merged tree). Live search activates on key + quota plan |
| TICKET-18 | TV fullscreen + bigger type (wave 1) | DONE | PR #9 merged (opus all-night-reliability audit clean) |
