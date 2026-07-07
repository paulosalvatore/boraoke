# TICKET-22 — Roadmap v2 (platform vision)

- **Date:** 2026-07-07
- **Product:** cantai (rename in flight — all v2 artifacts are name-agnostic)
- **Role:** Product Owner (spawned subagent, fable-tier planning pass)
- **Branch:** `ticket/22-roadmap-v2` (worktree `.worktrees/ticket-22`)
- **Status:** in review (draft PR)

## Goal

Turn the TL's post-launch v2 direction (venues beyond bars; aggregate menu ordering + pay-to-queue; anon-first identity with retroactive claim; bot prevention; theming/dark-light/i18n; rich admin queue management; rename incoming) into a phased platform roadmap, three new strategy specs, and a groomed 3-wave backlog with file boundaries and dependency edges.

## Deliverables

- `work/roadmap.md` — full v2 rewrite: platform north star, five phases (karaoke-core hardening → accounts/identity → venue generalization → platform aggregation → monetization activation), honest live/in-flight/blocked snapshot (TICKET-20/21/23 + naming research in flight; Upstash + YT key on TL), groomed waves 4–6 (TICKET-24..33) + directional wave 7+ (34..39), dependency-edge summary, TL open questions.
- `work/planning/accounts-and-identity.md` — anon-first identity model: server-registered anonymous uuid from first touch (TICKET-26), Google OAuth via Auth.js + retroactive claim-by-link (TICKET-28), multi-device merge, pre-auth room migration via host-token proof, LGPD posture (minimization, self-service deletion, privacy page ships with sign-in), six recorded key decisions (I-1..I-6).
- `work/planning/venue-generalization.md` — venue type = preset bundle over existing knobs (copy pack, theme preset, rotation defaults, feature flags, group-label semantics), scored portfolio, picks: **party/event, condo, corporate** (schools/churches deferred on content-filter prerequisite), TICKET-32 v1 scope + acceptance criteria.
- `work/planning/platform-aggregation.md` — candidate scoring (boost, dedications, pay-per-song, tips, menu, photo wall, sponsor slots), the fairness-bounded paid-priority design reconciling pay-to-queue with the free-fairness promise, first-paid-feature recommendation (**pay-to-boost "Destaque"**, party-type first), payment rail (**Pix via Mercado Pago**, manual venue settlement v1), wave-7+ ticket shapes (34–37).
- `work/tickets/TICKET-22-roadmap-v2.md` — this record.

## Key calls made (PO proposes — TL confirms; rationale in the specs)

1. Identity foundation (anonymous registration) pulled forward into the hardening wave — "register anonymous users from the start" means every day without it is unclaimable history.
2. Pay-to-queue is reconciled with the fairness promise via **bounded priority** (max 1 boosted song per rotation round, venue-opt-in, TV-badged, kill-switch) — supersedes TICKET-5's blanket rejection per the TL's explicit v2 directive.
3. First paid feature: pay-to-boost, not menu ordering — cheapest rail-proving revenue with zero fulfillment surface; menu becomes a deliberate single-venue pilot after the rail is proven.
4. Payment rail: Pix via Mercado Pago (house MP experience from desapega); venue revenue-share ledgered + settled manually in v1, marketplace payouts deferred.
5. Venue types ship as preset bundles (copy/theme/defaults/flags), never forks; bar default keeps existing rooms byte-identical.
6. Bot prevention recommends Cloudflare Turnstile over reCAPTCHA (free, invisible-first, LGPD-friendlier) — TL said "reCAPTCHA" as intent, vendor flagged as an open question.
7. v1 backlog honesty: #14 (venue accounts) superseded by the anon-first model; #16 (analytics view) absorbed into admin dashboard v2; #15/#17 carried into wave 7+; PR #14 hardening batch + #16 telemetry completions + board LOW/MEDs placed first in wave 4.

## Constraints honored

- Free-early-access promise: paid features strictly additive; fairness never paywalled (engine-level bound is an acceptance criterion, not a promise).
- Name-agnostic throughout; rebrand isolated as solo TICKET-33 gated on the naming research + TL pick.
- Markdown-only PR — no app code touched (TICKET-20/21 own code in flight).
- One-line-paragraph markdown authoring; commits via the sanctioned commit script; no prompts/ writes.
