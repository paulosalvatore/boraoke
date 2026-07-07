# PO Report — TICKET-22 (roadmap v2, platform vision)

- **Role:** Product Owner (fable)
- **Date:** 2026-07-07
- **Branch / worktree:** `ticket/22-roadmap-v2` / `.worktrees/ticket-22`
- **PR:** #15 (draft) — https://github.com/paulosalvatore/cantai/pull/15
- **Port:** n/a (docs-only ticket; no app served)
- **Status:** DONE — all six deliverables committed; PR awaiting Reviewer gate (docs-only: App Tester / Cyber skip candidates for the TM to record)

## Delivered

1. `work/roadmap.md` — v2 rewrite: platform north star, 5 phases, honest live/in-flight/blocked snapshot, groomed waves 4–6 (TICKET-24..33), directional wave 7+ (34..39), dependency edges, TL open questions.
2. `work/planning/accounts-and-identity.md` — anon-first identity model + LGPD posture, decisions I-1..I-6.
3. `work/planning/venue-generalization.md` — typed preset bundles; picks: party/event, condo, corporate.
4. `work/planning/platform-aggregation.md` — scoring; first paid feature = fairness-bounded pay-to-boost; rail = Pix via Mercado Pago.
5. Groomed 3-wave backlog with file-ownership boundaries (inside roadmap.md).
6. `work/tickets/TICKET-22-roadmap-v2.md` — ticket record.

## Needs TL confirmation (framed in roadmap "Open questions")

Bot-prevention vendor (Turnstile vs reCAPTCHA); i18n launch language set; venue-type shortlist; the fairness-bounded paid-priority design (supersedes TICKET-5's rejection per the TL's v2 directive); rename timing.

## Handoff notes for the TM

- Wave 4 arms only after TICKET-20 + TICKET-21 merge; TICKET-26 hard-depends on Upstash provisioning (already URGENT on the board).
- TICKET-34 (payments) needs a needs-user round before arming: MP account / CNPJ-MEI / fiscal posture decision.
- v1 backlog items #14/#16 retired/absorbed — noted explicitly in the roadmap so the board can be reconciled without archaeology.
