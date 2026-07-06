# cantai — Board

_Last updated: 2026-07-06 (12 PRs merged — MULTI-ROOM LIVE; PR #12 final rebase)_

## Needs user (TL)

- 🟢 RESOLVED-FOR-NOW: GitHub Actions billing — TL made the repo PUBLIC (prompt 007, 2026-07-06); CI runs free and is GREEN (PR #10 merged on a real green build-and-test run; PR #4 exception condition satisfied). If the repo goes private again, fix account billing first. 🔴 Account billing itself still broken (affects other private repos).
- 🔴 **URGENT (upgraded by PR #11 opus pass): Upstash Redis provisioning** on the Vercel project (Marketplace → Storage → add UPSTASH_REDIS_REST_URL/TOKEN env). Until then, LIVE user feedback AND queues silently evaporate per-lambda — the feedback widget promises "um robô lê cada um" but memory-driver feedback is lost. One dashboard action makes queues + feedback durable, zero code changes.
- 🟡 YouTube Data API v3 key → Vercel env — unblocks TICKET-8 live search. ⚠️ QUOTA REALITY (opus PR #8 finding, binding condition): default quota = 10,000 units/day and each search costs ~101 units → ~99 searches/day TOTAL across ALL venues; one modest bar night ≈ 80% of it. Before provisioning the key: file a YouTube quota-increase request (or accept day-one degraded fallback), and consider the filed follow-up (move search cache + rate limits onto Upstash so caching actually reduces burn).

## Follow-ups (filed by gates, unscheduled)

- **BINDING before the feedback-intake ticket (#12/framework intake): Intake-contract condition (PR #11 opus, HIGH)** — feedback ids are stamped at POST but index-commit lands later; id-order ≠ commit-order under concurrent writes, so a naive `since = max(id)` cursor can silently lose entries forever. Intake MUST use lagging watermark + id-dedupe (or the index made commit-ordered) — never the naive loop.
- Host login throttle → edge/Upstash-backed (per-lambda in-memory now; PR #10 M-1 note).

- Upstash-backed search cache + rate buckets (PR #8 opus rec — biggest quota lever; also makes rate limit cross-instance).
- Advance-guard for the double-advance race (ENDED vs skip; pre-existing, LOW).
- **Deflake TV e2e on CI (MED, from retroactive CI audit 2026-07-06)** — ticket/8 branch snapshot failed 2× on DIFFERENT tv.spec assertions (hero text timeout, then a seeded nickname not visible) while the same merged code passed 3+ main-state runs. Root-cause class: next-dev route compilation resets the memory-store singleton mid-e2e (TICKET-7 dev reproduced; its warmUp() workaround isn't in tv.spec) + 5s waits on slow runners. Fix: shared memory-driver e2e helper (warmUp + seed-after-compile) + bounded longer waits on /tv assertions.
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
| TICKET-7 | Host controls (wave 2) | DONE | PR #10 merged: full chain + FIRST real CI-green gate (190/190 local, Actions pass). Public-repo security recheck clean. Needs HOST_TOKEN env to go live |
| TICKET-9 | Rooms + QR + table (wave 2) | DONE | PR #13 merged: full chain incl. Security FAIL→fix→PASS (creation flood), opus deploy-moment analysis clean. Root URL is now a landing page; legacy queue at /default |
| TICKET-12 | Telemetry (wave 2) | FINAL REBASE | PR #12: sonnet APPROVE (+binding C1 single-source song_played); instrumentation landing post-#13; opus pass after |
| TICKET-11 | Feedback widget (wave 2) | DONE | PR #11 merged (151/151 on merged tree). Intake-contract condition + Upstash URGENT recorded |
| TICKET-3 | Rotation/fairness engine lib | DONE | PR #3 merged: sonnet+opus APPROVE; opus caught real peek≠play starvation bug pre-merge; 47/47 tests |
| TICKET-4 | Design language + mockups | DONE | PR #2 merged, TL-ratified |
| TICKET-5 | Roadmap + specs (modes/feedback/monetization) | DONE | PR #1 merged (Reviewer APPROVE after B1/B2 fixes; opus-skip recorded, docs-only) |
| TICKET-19 | PMF wave ticket batch | DONE | PR #5 merged (Reviewer APPROVE after B1 wave-dependency fix; opus-skip, docs-only). Tickets 6-12+18 armed in waves |
| TICKET-2 | Deploy verification | DONE | PR #6 merged. LIVE: https://cantai-snowy.vercel.app (cantai.vercel.app was name-squatted). All prod e2e checks PASS |
| TICKET-8 | YouTube search (wave 1) | DONE | PR #8 merged (123/123 on merged tree). Live search activates on key + quota plan |
| TICKET-18 | TV fullscreen + bigger type (wave 1) | DONE | PR #9 merged (opus all-night-reliability audit clean) |
