# cantai — Board

_Last updated: 2026-07-08 (REBRAND SHIPPED — boraoke.com fully live; TL live-usage wave running: 40/41/43 + 30-rebases-last)_

## Needs user (TL)

- 🟢 RESOLVED 2026-07-08: boraoke.com DNS live (TL). NEXTAUTH_URL switched to https://boraoke.com (TM).
- 🟡 **TL: one choice on PR #19** — ⌘Q Chrome (1 min) so EN/ES OG cards generate, OR waive to ship pt-BR-only now with cards as follow-up. Also: add boraoke.com to Google OAuth origins/redirects (console) + YouTube quota form (text delivered).

- 🟢 RESOLVED-FOR-NOW: GitHub Actions billing — TL made the repo PUBLIC (prompt 007, 2026-07-06); CI runs free and is GREEN (PR #10 merged on a real green build-and-test run; PR #4 exception condition satisfied). If the repo goes private again, fix account billing first. 🔴 Account billing itself still broken (affects other private repos).
- 🟢 RESOLVED 2026-07-07: Upstash provisioned via CLI (TM), aliased env names, redeployed, live-verified durable. YouTube key + Google OAuth + NextAuth + HOST_TOKEN all set in Vercel prod (TM via CLI).
- 🟢 key SET in prod (2026-07-07). Still open: quota-increase request (~99 searches/day default). Original note: YouTube Data API v3 key → Vercel env — unblocks TICKET-8 live search. ⚠️ QUOTA REALITY (opus PR #8 finding, binding condition): default quota = 10,000 units/day and each search costs ~101 units → ~99 searches/day TOTAL across ALL venues; one modest bar night ≈ 80% of it. Before provisioning the key: file a YouTube quota-increase request (or accept day-one degraded fallback), and consider the filed follow-up (move search cache + rate limits onto Upstash so caching actually reduces burn).

## Follow-ups (filed by gates, unscheduled)

- **[HIGH] Atomic store RMW (PR #14 opus)** — WATCH/Lua CAS on QueueStore rewrite/removeEntry/reorder + concurrency regression test. Closes the lost-submit window (~0.1-0.3/busy night in bursts, patron-visible+permanent) AND the pre-existing host-op races in one change. First candidate for the next dev slot.
- **[LOW] Strip patronUuid from public GET /api/queue projection** (griefing lockout via per-uuid limiter) — weigh against patron-page own-row highlighting (may need a hashed marker instead).
- **[LOW] rotation.ts:13 stale JSDoc; grace-path addEntry-return check** (PR #14 sonnet NITs).

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
| TICKET-12 | Telemetry (wave 2) | DONE | PR #12 merged: full chain, C1 verified single-source, fail-open airtight by construction, CI green on merged tip (292/292). #16 follow-ups: patron_joined client beacon, noshow emitter |
| TICKET-20 | P0 UX fixes + render/link test suite | DONE | PR #17 merged (348/348, CI green). Opus TL-trust ruling: suite would MISS contrast-class bugs → HIGH follow-up F/A (computed-style contrast assertion) filed for wave 4 |
| TICKET-21 | Atomic store RMW (HIGH) | DONE | PR #16 merged: Lua merge-on-write, opus verified against REAL Upstash (byte-fidelity + races). Lost-submit window closed |
| TICKET-22 | Roadmap v2 (platform vision) | DONE | PR #15 merged (Reviewer APPROVE + patches; opus-skip docs-only) |
| TICKET-23 | Design v2 | DONE | PR #18 merged, TL-ratified ("approved, go ahead and build"); 8-wave build order armed |
| TICKET-33a | Brand asset kit | DONE | PR #19 merged (pt-BR, TL-waived en/es); og-image-pt-BR live (200) |
| TICKET-33c | EN/ES OG cards | PARKED | Asset agent ready; needs TL login to aistudio.google.com in debug-Chrome window |
| TICKET-40 | Search UX (select-jump + karaoke keyword) | IN PROGRESS | Dev (opus), .worktrees/ticket-40 |
| TICKET-41 | TV watchdog + embeddable search + advance auth | IN PROGRESS | Dev (opus), .worktrees/ticket-41; folded TL skip-hole fix (screen-token design) |
| TICKET-43 | Session recovery (local room memory) | IN PROGRESS | Dev (opus), .worktrees/ticket-43; wave-28 sync seam |
| TICKET-44 | Optional moderation mode | QUEUED (next wave) | TL 2026-07-08: venue-optional song approval before queue entry ("wrong oriented stuff" guard); touches queue POST + admin + patron — launches after 40/41 merge. Related: roadmap content-filter prerequisite for schools/churches venue types |
| TICKET-30 | i18n pt-BR/en/es + switcher | IN PROGRESS | Dev (opus), .worktrees/ticket-30; REBASES LAST after 40/41/43 |
| TICKET-33 | Code rebrand + publish metadata | DONE | PR #20 merged; boraoke.com live-verified (title, OG 200, 308 redirect w/ path+query) |
| (research) | Naming + domain availability | IN PROGRESS | fable agent — cantai.com taken; shortlist w/ whois checks |
| TICKET-10 | Rotation modes UI (wave 3) | DONE | PR #14 merged: full chain (App Tester ordering proofs, Security fix round + re-audit, sonnet+opus APPROVE; lost-submit race quantified + HIGH atomic-RMW follow-up filed). KICKOFF SCOPE COMPLETE |
| TICKET-11 | Feedback widget (wave 2) | DONE | PR #11 merged (151/151 on merged tree). Intake-contract condition + Upstash URGENT recorded |
| TICKET-3 | Rotation/fairness engine lib | DONE | PR #3 merged: sonnet+opus APPROVE; opus caught real peek≠play starvation bug pre-merge; 47/47 tests |
| TICKET-4 | Design language + mockups | DONE | PR #2 merged, TL-ratified |
| TICKET-5 | Roadmap + specs (modes/feedback/monetization) | DONE | PR #1 merged (Reviewer APPROVE after B1/B2 fixes; opus-skip recorded, docs-only) |
| TICKET-19 | PMF wave ticket batch | DONE | PR #5 merged (Reviewer APPROVE after B1 wave-dependency fix; opus-skip, docs-only). Tickets 6-12+18 armed in waves |
| TICKET-2 | Deploy verification | DONE | PR #6 merged. LIVE: https://cantai-snowy.vercel.app (cantai.vercel.app was name-squatted). All prod e2e checks PASS |
| TICKET-8 | YouTube search (wave 1) | DONE | PR #8 merged (123/123 on merged tree). Live search activates on key + quota plan |
| TICKET-18 | TV fullscreen + bigger type (wave 1) | DONE | PR #9 merged (opus all-night-reliability audit clean) |
