# TICKET-5 — Product roadmap + first specs

- **Date:** 2026-07-05
- **Product:** cantai
- **Role:** Product Owner (spawned subagent, opus-tier planning pass)
- **Branch:** `ticket/5-roadmap` (worktree `.worktrees/ticket-5`)
- **Status:** in review (draft PR)

## Goal

Give cantai a product brain before the build fans out: a sequenced prototype → MVP → PMF → 1.0 roadmap, three buildable feature specs (rotation/fairness, feedback loop, early-access/monetization), and a groomed ordered backlog for the tickets after TICKET-1..5.

## Deliverables

- `work/roadmap.md` — north star, phased roadmap, groomed ordered backlog (#6–#17) with dependencies, open questions for the TL.
- `work/planning/rotation-modes-fair-queue.md` — the three venue modes as one deterministic pure ordering function (contract for the TICKET-3 lib), sing vs listen/dance interaction, no-show/leaver/table-change edge cases, 8 acceptance criteria.
- `work/planning/feedback-loop.md` — zero-friction widget (uuid+nickname auto-attached) + the house-side `feedback-intake` agent pipeline (watermarked, idempotent, proposals-not-tickets, human-gated) + uuid-keyed close-the-loop.
- `work/planning/early-access-monetization.md` — everything-free posture, pro-feature candidates with demand signals, ads-vs-paid analysis with a firm recommendation (freemium venue plan, no ads), and the telemetry baseline to collect NOW.

## Key calls made (autonomous run — rationale recorded in the specs)

1. Fairness ordering is round-robin by group with per-round quotas, not FIFO — expressed as a pure function so TICKET-3 can test it in isolation.
2. Listen/dance entries are gap-fillers: never consume fairness turns, play FIFO when the sing queue is empty.
3. Feedback loop is human-gated at exactly one point (proposal → ticket); everything else is agent-automated with a watermark for idempotent scheduled runs.
4. Monetization recommendation: freemium venue subscription, patrons free and ad-free permanently; "powered by cantai" on the free TV view is the growth loop; founding-venue deal honors the free-early-access promise.
5. Backlog #6 (durable persistence) is the hard prerequisite for everything — Vercel serverless kills in-memory state.

## Constraints honored

- Markdown-only PR — no app code touched (parallel Dev owns TICKET-1/3 code).
- PO boundaries: proposals throughout; priorities are the TL's to confirm; no orchestration, no code.

## Gates note

Docs-only change: no app behavior to test — App Tester gate is N/A-by-content (TM to record), Security/Reviewer gates apply to the documents.
