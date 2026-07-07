# Spec — Venue-type generalization

- **Product:** cantai (name-agnostic)
- **Author:** Product Owner (TICKET-22)
- **Date:** 2026-07-07
- **Status:** proposed — feeds TICKET-32 (venue types v1, wave 6); consumes TICKET-23 (design v2) and TICKET-29/30 (theming, i18n)
- **TL directive (verbatim intent, binding):** karaoke is not necessarily a BAR — think other venues/contexts: parties, events, weddings, condos, schools, churches, corporate.

## Principle: one product, typed presets — not verticals

The core loop (QR → pick song → fair queue → screen plays) is identical everywhere; what differs per context is **copy, look, defaults, and which extras are on**. So a venue type is a **preset bundle over existing knobs**, not a fork: a copy pack (i18n keys), a theme preset (design tokens), rotation-mode + settings defaults, and a feature-flag set. New venue types then cost roughly a config file plus translations — that's the leverage.

The host picks a type at room creation (one extra tap, defaulting to the current behavior); everything else flows from it, and any preset value remains individually overridable in room settings (presets configure, never lock).

## What a venue type actually controls

| Dimension | Mechanism (existing/planned) | Examples of per-type variation |
|---|---|---|
| Copy/tone | i18n copy packs (TICKET-30 keys, per-type namespace) | "mesa" (table) → "equipe" (team) → "família"; playful bar tone vs warm wedding tone |
| Theming | Theme presets over TICKET-29 tokens | Neon-dark for bars, elegant light for weddings, bright for parties |
| Rotation defaults | Existing TICKET-3/10 modes + settings | Bar: 2-per-table; party: one-per-person; corporate: round-robin by team |
| Feature flags | Per-room flag set (TICKET-32 introduces the registry) | Dedications on for weddings; menu ordering only where there's a menu; paid boost off for private parties by default |
| Screen furniture | TV view variants | "Powered by" + join QR always; wedding adds couple's names/date slot; corporate adds company name slot |
| Join semantics | Table capture (TICKET-9) generalized to "group label" | Table number → team name → family name → nothing (open party) |
| Content posture | Search filter level (future flag) | Standard everywhere now; strict mode is the prerequisite for schools/churches (deferred) |

## The venue-type portfolio (scored)

Scoring: market size in BR × willingness-to-pay × product fit today × acquisition cost. Scale –/○/+/++.

| Type | Market size | Pays? | Fits today? | Acquisition | Verdict |
|---|---|---|---|---|---|
| Bar (baseline) | + | + (venue SaaS later) | ++ | ○ (venue sales) | Live — keep as default type |
| **Private parties & events (birthdays, weddings, churrascos)** | ++ (weddings alone: ~1M/yr in BR; birthdays uncountable) | ++ (people overspend on one-day events; dedications/boosts are natural) | ++ (works today with zero code) | ++ (self-serve: the host IS the buyer, finds us on their phone) | **Pick #1** |
| **Condos & community spaces (salão de festas)** | + (500k+ condos in BR; recurring monthly events) | + (condo fee budgets; renter of the salão is a party host → funnel overlap with #1) | ++ | + (one good condo night seeds every resident's next party — compounding loop) | **Pick #2** |
| **Corporate (happy hour, offsite, end-of-year)** | + | ++ (highest per-event budget; company card) | + (needs team semantics + sober theming) | ○ (HR/office managers; slower cycle but bigger tickets) | **Pick #3** |
| Schools | + | ○ (procurement friction) | – (needs strict content filtering + minors/LGPD posture) | – | Defer — revisit after content-filter flag exists |
| Churches | + | ○ | – (needs curated/gospel catalog mode + strict filter) | ○ (strong community spread) | Defer — same prerequisite as schools |

**Recommendation: ship party/event, condo, and corporate as the three types beyond bar in TICKET-32.** They need zero new core mechanics — only presets over what waves 4–5 already build — and they shift the product from venue-sales (slow) to self-serve host acquisition (fast). Schools/churches are real but gated on a content-moderation feature that deserves its own ticket; entering them half-safe risks the brand.

The strategic kicker: **party/event hosts are the monetization bridge.** A wedding buys dedications; a birthday buys boosts; nobody feels paywalled because it's their own party budget. That makes Pick #1 the landing zone for the first paid feature (see `platform-aggregation.md`).

## What TICKET-32 ships (v1 scope)

1. Venue-type registry (`lib/venue-types/`): bar, party (covers birthdays/weddings/private events under one type v1), condo, corporate — each a preset bundle (copy namespace, theme preset id, rotation defaults, flag set, group-label semantics).
2. Type selection at room creation (default: bar → current behavior unchanged; existing rooms keep behaving exactly as today).
3. Per-type copy packs in pt-BR/en/es (additive locale keys only — file-boundary contract with TICKET-30).
4. Per-type theme preset selection wired through the TICKET-29 provider.
5. Room settings expose the preset values for individual override.
6. Telemetry: `venue_type` dimension on room creation and rollups — this is the data that decides which vertical gets its own deep-dive next.

Out of scope v1: wedding sub-type with couple-name TV slot (fast follow if party-type telemetry shows wedding usage), content filtering, per-type onboarding landing pages (marketing-site scope, post-rename).

## Acceptance criteria (for TICKET-32)

1. Creating a room of each of the four types yields visibly different copy, theme, and defaults on patron + admin + TV pages, with the core queue flow byte-identical in behavior.
2. A "bar" room created after the change is indistinguishable from one created before it; pre-existing rooms are unaffected.
3. Adding a hypothetical fifth type requires only a registry entry + locale keys (proven by a test fixture type, not shipped UI).
4. Every preset value is overridable in room settings, and overrides persist.
5. `venue_type` appears in telemetry events and the weekly rollup.
