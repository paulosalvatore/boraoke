---
ticket: TICKET-142
product: boraoke
status: filed
---

# TICKET-142 — Catalogue measurement harness v2 (gate for the epic)

**Filed:** 2026-10-15, by the boraoke Tech Manager, from `work/plans/EPIC-song-catalogue-plan.md` (section (e) and its "Independent verification (2026-10-15)" table). TL decisions 2026-10-15 (Global TM, prompt 022): epic approved, file 141-149 in the plan order after #90 and TICKET-140; patron-facing parts need a TL OK (via the Global TM) before merge.
**Priority:** MEDIUM
**Type:** Measurement / test tooling
**Size:** S
**Patron-facing:** no. Can run in parallel with 141.

## What

Extend `work/measurements/ticket-124/replay.ts`:

- (a) Grade **listen/dance** queries too. Today 14 of the 26 billed calls in the 124 replay are `not-sing-mode` and ungraded (a proxy: `tier.ts:117` sets it when the query lacks "karaoke").
- (b) Split each miss into **coverage vs ranking** (port `work/spikes/ticket-106/diagnose.mjs`).
- (c) Report hit@1/5/10 and billed/song **per tier and per kind**.

## Acceptance

- The baseline reproduces **89% hit@10 and 0.89 billed/song**.
- The prove-can-fail controls C1-C4 are kept.
- **Gate for all later catalogue tickets:** hit@10 may not drop below 89%, and the long-tail false-confident count may not exceed 3/18.

## References

- `work/measurements/ticket-124/RESULTS.txt`, `work/spikes/ticket-106/diagnose.mjs`, `lib/karaoke-index/tier.ts`.
