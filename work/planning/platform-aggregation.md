# Spec — Platform aggregation (menu, payments, and the paid-extras rail)

- **Product:** cantai (name-agnostic)
- **Author:** Product Owner (TICKET-22)
- **Date:** 2026-07-07
- **Status:** proposed — directional spec for wave 7+ (TICKET-34..37 candidates); the first-paid-feature pick and the fairness design need TL confirmation
- **TL directive (verbatim intent, binding):** aggregate other products into the platform — menu ordering, PAY to queue songs (paid priority or pay-per-song), other features that might be good.

## The platform thesis

The expensive thing — getting every guest in the room onto our page via QR, tied to an identity, looking at a screen we control — is **already built and already free**. Every aggregated feature is a new SKU on an existing rail. The strategy question is only sequencing: which SKU first, on which payment rail, without breaking the fairness promise that makes the free product spread.

## Reconciling "pay to queue" with the fairness promise (load-bearing)

The TICKET-5 monetization spec rejected "pay to jump the queue" as destroying the core promise. The TL has now explicitly asked for paid queue priority — the TL's call stands, and the constraint "never paywall fairness" survives via **bounded priority**:

- **Free flow untouched:** queueing a song stays free, always. Paid boost is an extra on top, never a toll.
- **Bounded, not absolute:** the rotation engine (TICKET-3's brain — this is why we built it pure) admits at most **1 boosted song per rotation round** (configurable). Boosts compete with each other for that slot, never displace free entries — a free singer's worst case is waiting one extra song per round, bounded and predictable, regardless of how much money is in the room.
- **Venue-opt-in:** boosts exist only where the host enables them (default ON for party/corporate types, OFF for bars until the host flips it — a party host monetizing their own guests is celebration; a bar doing it silently could feel like a shakedown).
- **Transparent on the TV:** boosted entries are visibly badged ("⭐ Destaque"). Paid influence that's visible is theater and fun; paid influence that's hidden is corruption of the queue.
- **Anti-abuse:** per-identity boost velocity caps (rides TICKET-27 infrastructure); refunds auto-issued if a boosted song gets host-skipped before playing.

If real-night telemetry shows boosts degrading free-singer sentiment (feedback widget + skip rates are the sensors), the bound tightens or the feature retreats to party-type only. This is written into the acceptance criteria as a kill-switch flag, not left as a promise.

## Candidate scoring

Scale 1–5; build cost inverted (5 = cheapest). Strategic fit = does it strengthen the core loop and the venue-type strategy or dilute it?

| Candidate | Revenue potential | Build cost (5=cheap) | Strategic fit | Notes |
|---|---|---|---|---|
| **Pay-to-boost (paid priority, bounded)** | 4 — impulse buy at peak emotion, high margin, every room every night | 4 — rotation engine + identity + one Pix checkout; no inventory, no fulfillment | 5 — monetizes the queue itself; showcases the fairness engine as a feature | **Pick as first** |
| Song dedications (paid TV message with a song) | 4 — weddings/birthdays will pay well per unit | 4 — TV overlay + moderation queue on the admin page; shares 95% of boost's rail | 5 — makes the TV more emotional, not more commercial; party-type killer feature | **Fast follow (36)** — ship weeks after boost |
| Pay-per-song (every submission costs) | 2 — venue-niche (paid-karaoke houses) | 5 — trivial once rail exists | 2 — a toll on the core loop; acceptable ONLY as venue-opt-in mode for venues that already charge per song, never a default | Ship later as a venue setting, not a product push |
| Tips for singers / to the house | 2 — low take-rate, unpredictable | 3 — needs payout-to-third-party handling (singer side is messy: who receives?) | 3 — fun, social; house-tip variant is simpler | Later; house-tip jar variant may ride the dedication rail |
| Menu ordering | 5 — largest long-term prize (% of F&B GMV dwarfs song extras) | 1 — menu CMS, order flow, fulfillment integration (kitchen/printer/POS), disputes, support burden | 4 — deepens bar/venue lock-in; but a bad ordering experience poisons the whole product | **Pilot later (37)** — one venue, order-to-WhatsApp/printer, no POS integration |
| Photo wall (guests' photos on TV between songs) | 1 direct (free/engagement; pro-plan candidate) | 3 — upload + moderation is real work (abuse surface) | 4 — brilliant for parties/weddings; increases QR scans | Free engagement feature later; moderation tooling prerequisite |
| Venue-sold sponsor slots on TV | 2 now, 3 at scale | 3 | 3 — venue controls it (per early-access-monetization.md, beats network ads) | Pro-plan feature, Phase 5 |

## Recommendation: first paid feature

**Pay-to-boost ("Destaque"), launched on the party/event venue type first, then venue-opt-in everywhere.**

Why it wins:

1. **Cheapest path to first real revenue.** No inventory, no fulfillment, no third-party payout, no support tail — the three hard parts (queue engine, identity, screen) already exist; only the checkout is new.
2. **Bought at the moment of maximum willingness:** "our song, tonight, now" is a classic impulse purchase; price points R$5–15 need no deliberation.
3. **Strategic proof, not just revenue:** it validates the entire payments rail (34) that menu ordering and dedications reuse, with the smallest possible blast radius.
4. **Fairness-compatible by design** (bounded priority above) — the one candidate the TL named that we can ship without touching the free promise, given the bounding.
5. Landing on party/event type first (per `venue-generalization.md`) means the first payers are hosts' guests at private celebrations — the most forgiving, highest-joy context to debug a payment flow in.

Menu ordering is the bigger long-term business but the worst first move: its build cost and operational surface (fulfillment, refunds, angry-hungry-customer support) would consume multiple waves before the first real; it becomes a deliberate pilot (37) after the payment rail is proven by boosts.

## Payment rail: Pix via Mercado Pago

**Recommendation: Mercado Pago, Pix-first (dynamic QR + copia-e-cola), card as fallback later.**

- **Pix is the only rail that matches the moment:** instant confirmation (seconds — the boost must apply while the song is still upcoming), works for every Brazilian with a bank app, no card-entry friction on a phone in a dark room, negligible chargeback surface.
- **Mercado Pago because the house already knows it** (desapega): existing integration experience, sandbox familiarity, known webhook semantics — that experience is worth more than a marginal fee difference at our volume. MP's Pix fees are competitive at small scale; revisit rails only if volume makes fee shopping material.
- **Money flow v1 (keep it dead simple):** payments land in the product's MP account; venue revenue-share for boosts (propose 50/50, TL to set) is **ledgered per venue and settled manually** during early access — building automated split/marketplace payouts (MP marketplace mode) before revenue exists is over-engineering. Automate settlement when monthly volume makes manual settlement annoying — that's a good problem.
- **Compliance note for the record:** taking money requires a CNPJ/MEI decision, MP account setup, simple fiscal posture, and refund policy — a needs-user (TL) round before TICKET-34 arms. Buyer PII stays inside MP; our side stores only payment ids against anonymous uuids.

## Ticket shapes (wave 7+, groomed later — directional now)

| # | Ticket | Scope sketch |
|---|---|---|
| 34 | Payments foundation (MP + Pix) | `lib/payments/` (MP client, checkout create, webhook verify, payment states, per-venue ledger), sandbox e2e, zero product UI beyond a test surface. Depends: 26 (identity), 27 (abuse), TL business setup. |
| 35 | Pay-to-boost v1 | Boost purchase flow on patron page, bounded-priority slot in rotation engine, TV badge, host toggle + price setting, refund-on-skip, kill-switch flag, boost telemetry. Depends: 34. |
| 36 | Song dedications | Message + optional name attached to an entry, TV overlay at play time, host moderation queue (pre-approval default ON), rides the 34 rail. Depends: 34, 31 (admin surface). |
| 37 | Menu ordering pilot | Single pilot venue: menu CMS (admin), browse + order + Pix pay (patron), order feed to venue (start: WhatsApp/printer webhook — no POS integration), explicit pilot exit criteria before generalizing. Depends: 34, 31. |

## Acceptance criteria (for the eventual TICKET-35 — the ones that guard the promise)

1. With boosts disabled (default for bar-type), product behavior is byte-identical to today.
2. With boosts enabled, no rotation round ever plays more than the configured max of boosted entries, regardless of purchase volume (engine-level test, not UI-level).
3. A free entry's position never worsens by more than the bound per round (property-based test over random boost sequences).
4. Boosted entries are visibly badged on patron + TV views; price and "what boost does" are stated before payment.
5. Payment confirms via MP webhook (never client-asserted); unconfirmed payments never boost; host-skip of an unplayed boosted song auto-refunds.
6. A kill-switch env/flag disables new boost purchases instantly without deploy.
7. Boost events land in telemetry (purchases, price, venue type, refunds) — the data that decides everything after.

## Explicitly rejected / deferred

- Network/programmatic ads in any form (re-affirmed from `early-access-monetization.md`).
- Unbounded pay-to-skip-the-line (violates the fairness bound — the whole design above exists to avoid this).
- Marketplace/split payouts, POS integrations, singer-side tip payouts in v1 (operational surface before revenue justifies it).
