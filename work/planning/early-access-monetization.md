# Spec — Early access + monetization path

- **Product:** cantai
- **Author:** Product Owner (TICKET-5)
- **Date:** 2026-07-05
- **Status:** proposed — strategy spec with a concrete recommendation; the monetization flip itself is a Tech-Lead decision when the time comes
- **TL directive (verbatim intent, binding):** free early access with EVERYTHING available so everyone can use it; later a paid professional plan and/or ads or gated pro features.

## Early-access posture (now → PMF)

- **Everything free, everything on.** No feature flags hiding "future pro" functionality during early access — pro candidates ship free so we can measure real demand instead of guessing.
- **The only asks:** the free tier displays a small tasteful **"powered by cantai" + join QR** on the TV view (it's simultaneously our growth loop and, later, the most natural thing a paid plan removes/rebrands), and the product collects **anonymous telemetry** (below).
- **Founding-venue promise:** venues active during early access get a permanent founding deal at flip time (deep discount or extended free pro). This is how "everything free now" and "paid later" coexist without a rug-pull — trust is the moat for a product that lives on the venue's TV.

## Candidate pro features (measure now, gate later)

| Candidate | Who pays | Demand signal to watch (telemetry) |
|---|---|---|
| Multi-room / multi-screen per venue | Larger venues, chains | Venues creating >1 concurrent session; same venue re-keying sessions |
| Custom branding (logo/colors on TV, remove "powered by cantai") | Image-conscious venues | Unprompted feedback asking for it; venue size distribution |
| Venue analytics (songs/night, peak hours, top songs, patron counts) | Owners/managers | Usage of the free analytics view we ship in PMF phase (#16) |
| Priority/host queue tools (pin, boost, VIP, paid song-skip) | High-volume karaoke bars | Host-control usage intensity; feedback about queue pressure |
| Ad-free (only if we ever run ads — see recommendation) | — | — |
| Song-history export / event reports | Event organizers | Repeat multi-night venues |
| Reusable branded QR + custom venue URL | All venues | QR regeneration frequency |

Core stays free forever: shared queue, YouTube playback, all three rotation modes, feedback widget. Fairness is the product's soul — never paywall it (a "pay to jump the queue" patron feature would monetize by destroying the core promise; explicitly rejected).

> **Supersession note (TICKET-22, 2026-07-07):** the blanket pay-to-queue rejection above is superseded by the TL's v2 directive via the fairness-bounded paid-priority design in `platform-aggregation.md` §"Reconciling 'pay to queue' with the fairness promise" — free queue never displaced, bounded to max 1 boosted song per rotation round, venue-opt-in, TV-badged.

## Ads vs paid — tradeoff analysis and recommendation

### Ads (patron-side or TV-side)

- (+) Monetizes free venues at scale without asking bars for money; no billing ops.
- (−) **TV ads cheapen the venue's own space** — the bar's screen is their ambiance; injected ads make cantai feel like a liability, and venue churn kills the whole funnel.
- (−) Patron-phone ads degrade the 5-second "queue a song" flow — friction is the one thing we promised not to have.
- (−) CPMs for a niche pt-BR bar audience are low; meaningful revenue needs volume we won't have for a long time; YouTube's embed already carries its own ads sometimes, and stacking ours on top worsens the night.
- (−) Ad SDKs raise the privacy bar (LGPD) that our anonymous-uuid design currently keeps low.

### Paid venue plan (B2B freemium)

- (+) Bars are businesses with budgets; karaoke systems and music licensing are things they already pay for — willingness-to-pay exists (reference points: professional karaoke systems and per-night KJ hosts cost far more than a plausible R$50–100/month SaaS).
- (+) Low volume × high value fits our early scale; billing to venues (tens→hundreds) not patrons (thousands).
- (+) Aligned incentives: we sell tools that make the venue's night better, not attention sold out the side.
- (−) Requires billing/accounts/support ops; conversion depends on nailing which features owners actually value — exactly what early-access telemetry + the feedback loop exist to learn.

### Recommendation (PO call, TL to confirm at flip time)

**Freemium venue subscription; no ads on patrons or TV, ever.** The free tier keeps the full core (queue, playback, modes, feedback) plus "powered by cantai" branding; the pro plan sells venue-side power: branding removal, multi-room, analytics, priority host tools. Patron side stays 100% free and ad-free permanently — patrons are the growth engine and the content (they're literally the show). Sequence: decide pricing only after PMF-phase telemetry (below) answers demand; likely single pro tier first (~R$49–99/mo hypothesis to validate), annual founding-venue deal for early-access houses. "Ads" survive only as a never-preferred fallback if venue conversion catastrophically fails — and even then, TV-side sponsor slots controlled BY the venue (venue sells their own ad slots between songs — a pro feature!) beat network ads.

## Telemetry we need NOW (backlog #13 — the load-bearing part)

The monetization decision is only as good as the data collected during early access. Ship these as anonymous product events from MVP onward (same durable store family; no PII; uuid/venueId are anonymous keys):

1. **Venue lifecycle:** venue/session created, session duration, sessions per venue per week (**retention — the #1 signal**), concurrent sessions per venue (multi-room demand).
2. **Patron engagement:** patrons per session, songs queued/played/skipped per session, sing vs listen ratio, mode used, submissions per patron.
3. **Host behavior:** host-control usage counts by type (skip/reorder/remove/pause) — proxies priority-tools demand.
4. **Friction markers:** search-with-no-submit rates (search quality), submit rejections by cap, no-show skip rate.
5. **Feedback correlation:** feedback volume/sentiment per venue joined against usage (which venue profiles love/struggle).
6. **Weekly rollup:** a tiny scheduled job (or the feedback-intake agent's sibling pass) writes `work/telemetry/rollups/<YYYY-Www>.md` — human-readable weekly numbers so the TL/PO watch trendlines from the repo without a BI stack.

Decision gates these enable: flip timing (venue retention curve flattening = PMF), pro-tier contents (which candidates show organic demand), pricing conversations (usage intensity per venue). Retrofitting any of this later loses the early-access window forever — hence "now".

## Acceptance criteria (for the eventual telemetry ticket)

1. Every listed event lands in the durable store with venueId/sessionId/uuid (anonymous), timestamp, appVersion; zero PII fields exist in the schema.
2. Events fail open: telemetry outage never blocks or slows a queue/playback action.
3. A weekly rollup document is generated from ≥1 week of seeded events with per-venue retention, engagement, and host-usage tables.
4. `/tv` free tier renders the "powered by cantai" + QR footer; a config flag exists (default on) so the future pro plan can disable it without a rebuild.
5. A `docs/` or README note states the telemetry-and-privacy posture in plain language (anonymous, no ads, LGPD-friendly) — trust is part of the product.

## Out of scope

Billing integration, pricing final call, accounts/auth for venues (PMF-phase, backlog #14), any ad network integration (rejected above).
