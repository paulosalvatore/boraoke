# cantai — Product Roadmap

- **Owner:** Product Owner (TICKET-5)
- **Last groomed:** 2026-07-05
- **Status:** proposed — priorities are the Tech Lead's to confirm (PO proposes, never imposes)

## North star

Any bar can run a great karaoke night with **zero setup and zero cost to start**: patrons scan a QR, pick a song, and the venue screen just plays — fairly, in the right order, with no host babysitting the queue. cantai wins by being the **lowest-friction** venue music/karaoke system, and it improves itself faster than competitors because user feedback flows straight into an automated build loop (our agent fleet). Growth engine: every free venue screen is a live demo ("powered by cantai") in front of a room full of potential patrons and venue owners.

Primary early market: Brazilian bars (the name is Portuguese — "cantai" = "sing!"), so pt-BR-first UI with en as the second locale.

## Guiding principles

- Prototype → MVP → PMF → 1.0 (house iteration model, TICKET-0): ship the smallest usable venue+patron flow before polish.
- Free early access with EVERYTHING available (TL directive, verbatim intent). Monetization decisions come later, informed by telemetry we start collecting now — see `work/planning/early-access-monetization.md`.
- The feedback loop is a first-class product feature AND a house differentiator, not an afterthought — see `work/planning/feedback-loop.md`.
- YouTube ToS compliance is non-negotiable: IFrame Player API embeds only, no downloading/stripping, visible player.

## Phases

### Phase 0 — Prototype (in flight)

Goal: one venue can run one real karaoke session end-to-end on a public URL.

| Ticket | What | Why | Status |
|---|---|---|---|
| TICKET-1 | Walking skeleton: join → paste YouTube link → queue → /tv autoplay, in-memory store | Proves the core loop | in flight |
| TICKET-2 | Vercel deploy pipeline | Public URL = testable with real people | in flight (blocked on TL creds) |
| TICKET-3 | Rotation/fairness engine lib | The fairness brain, built pure so it's testable in isolation | in flight |
| TICKET-4 | Design system | Bar-friendly look before UI multiplies | in flight |
| TICKET-5 | This roadmap + specs | Product brain: what/why sequenced before build fan-out | this PR |

Exit criteria: live URL; a phone can queue a song; the TV plays it; the whole flow survives a 10-song session.

### Phase 1 — MVP (next)

Goal: a real bar can run a real Friday night unattended-ish, and we hear about everything that goes wrong.

Ordered initiatives (see Groomed backlog below for ticket-level detail):

1. **Durable persistence** — in-memory dies per serverless instance on Vercel; nothing else is trustworthy until state survives. Sizing: S-M.
2. **Host controls** — skip, remove, reorder, pause; a venue cannot run a night without a kill switch for a 10-minute song or a no-show. Sizing: M.
3. **In-app YouTube search** — paste-a-link is patron friction #1; search-and-tap is the expected UX. Sizing: M (Data API key server-side, per TICKET-0 constraint).
4. **QR join + table capture** — the physical onboarding moment; table number feeds the 2-per-table mode. Sizing: S.
5. **Rotation modes wired to UI** — surface the TICKET-3 engine as venue settings (full karaoke / 2-per-table / one-per-person) + sing vs listen/dance on submit. Spec: `work/planning/rotation-modes-fair-queue.md`. Sizing: M.
6. **Feedback widget + storage** — zero-friction in-app capture, uuid+nickname attached. Spec: `work/planning/feedback-loop.md`. Sizing: S-M.
7. **Feedback-intake agent loop (house side)** — periodic agent mines feedback into triaged proposals; this is the progressive-development differentiator. Sizing: M (mostly framework/skill work).
8. **Telemetry baseline** — anonymous product events (sessions, songs, modes, retention) so the later monetization call is data-driven, not vibes. Spec: `work/planning/early-access-monetization.md` §Telemetry. Sizing: S.

Exit criteria: ≥1 real venue runs ≥2 real nights; feedback arrives, gets triaged by the agent loop, and at least one user-reported item ships.

### Phase 2 — PMF (grow and listen)

Goal: venues come back weekly on their own; we learn which pro features they'd pay for.

1. **Venue accounts + rooms** — named venues, multiple rooms/sessions, reusable QR; the unit of retention (and of future billing) is the venue.
2. **Close-the-loop notifications + public changelog** — "your suggestion shipped" keyed to uuid; turns feedback into loyalty and more feedback.
3. **Venue analytics (free during early access)** — songs/night, peak hours, top songs; doubles as our own pro-feature validation.
4. **Realtime upgrade if proven needed** — move polling/SSE to websockets/hosted realtime only if session sizes demand it (TICKET-0 constraint).
5. **i18n hardening (pt-BR/en) + mobile polish** — the room is dark, the phones are cheap, the patrons are tipsy; UX must be forgiving.
6. **Embeddable venue page / OBS-friendly TV view** — meet venues where their screens already are.

Exit criteria: N venues with ≥4 weeks consecutive usage (N set by TL); telemetry answers the ads-vs-paid question with data.

### Phase 3 — 1.0 (monetize without breaking the promise)

Goal: flip on the pro plan without degrading the free tier that got us here.

1. **Pro plan + billing** — per the recommendation in `work/planning/early-access-monetization.md`: venue-side freemium subscription, no patron-side ads.
2. **Pro features** — custom branding / remove "powered by cantai", multi-room, advanced analytics, priority host tools; free tier keeps the full core (queue, modes, feedback).
3. **Grandfathering** — early-access venues get a founding-venue deal; the "everything free" promise is honored, not rug-pulled.
4. **Ops hardening** — ToS/privacy pages, LGPD posture (anonymous uuid design already helps), abuse controls, uptime.

## Groomed backlog (ordered, post TICKET-5)

Proposal to the Tech Manager/Tech Lead; TM turns these into `work/tickets/` through the normal gates.

| # | Ticket (proposed) | One-line rationale |
|---|---|---|
| 6 | Durable persistence for queue + sessions | Vercel serverless kills in-memory state between invocations; nothing real ships until state survives — hard prerequisite for every item below. |
| 7 | Host controls (skip / remove / reorder / pause, host token) | A venue can't run a night without a kill switch; also unblocks no-show handling in the rotation spec. |
| 8 | In-app YouTube search (server-side Data API key) | Paste-a-link is the #1 patron friction; search-and-tap is table stakes for tipsy users on phones. |
| 9 | QR join + table number capture | The physical onboarding moment; table identity feeds 2-per-table fairness. |
| 10 | Wire rotation modes + sing/listen-dance into UI (consumes TICKET-3 lib) | The fairness engine is the product's differentiating brain; spec in `work/planning/rotation-modes-fair-queue.md`. |
| 11 | Feedback widget + `/api/feedback` + durable feedback store | Zero-friction capture with uuid+nickname; the raw material for the whole feedback loop (depends on #6). |
| 12 | Feedback-intake agent loop (house side: mine → triage → proposals → close loop) | The progressive-development differentiator; turns feedback into tickets automatically, human-gated. |
| 13 | Telemetry baseline (anonymous product events + weekly rollup) | We must collect NOW the data that decides ads-vs-paid later; retrofitting loses the early-access window. |
| 14 | Venue accounts + rooms model | Retention and (later) billing attach to the venue, not the session; prerequisite for PMF-phase features. |
| 15 | Close-the-loop notifications + public changelog | "You asked, we shipped" converts feedback into loyalty; completes the loop TICKET-11/12 open. |
| 16 | Venue analytics view (free during early access) | Validates the top pro-feature candidate with real usage before we price it. |
| 17 | Realtime upgrade evaluation (polling/SSE → ws) | Only if telemetry shows session sizes hurting; deliberate deferral per TICKET-0. |

Dependency notes: #6 blocks #7–#16 in practice (durable state). #10 depends on TICKET-3 (lib) and #9 (table identity). #11 depends on #6; #12 depends on #11; #15 depends on #12. #8 needs the YouTube Data API key via the W7 needs-user round.

## Open questions (for the Tech Lead)

- Venue-count target (N) for the PMF exit criterion.
- Whether "powered by cantai" branding on the free TV view is acceptable from day one (recommended — it's the growth loop) or deferred.
- YouTube Data API key provisioning timing (needs-user round, blocks #8).
