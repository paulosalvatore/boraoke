# Boraoke — Roadmap Reconciliation (PO sweep)

- **Author:** Product Owner (boraoke)
- **Date:** 2026-07-15
- **Method:** full sweep of the framework prompt archive (`prompts/` + unflushed `prompts/_staging/`), the boraoke code/routes, `work/status/BOARD.md`, `work/roadmap.md`, `work/planning/*`, and `work/evidence/`.
- **Purpose:** reconcile every Tech-Lead ask against what shipped, name what fell through, and propose a P0/P1/P2 roadmap. Additive — supersedes nothing; the roadmap v2 phases (`work/roadmap.md`) remain the narrative, this is the honest re-prioritization on top of them.

## The one-paragraph story

The karaoke **core is done and hard**. Every founding-spec feature — YouTube embed, shared queue, patron submission, table numbers, sing/listen modes, all three rotation modes, TV fullscreen, host controls, i18n, moderation, session recovery — shipped and merged (tickets 0–53, 35 PRs, pile fully drained as of 2026-07-15). What **fell through is the entire platform-growth arc**: the wave 4b/5/6 backlog groomed on 2026-07-07 (anonymous identity, Google OAuth, admin analytics, dark/light theming, venue generalization, bot prevention) was never started. All development effort after 2026-07-07 went into *hardening the core* (search UX, TV watchdog, advance-auth, moderation, rate-limit atomicity — tickets 40–53), not into *growing the platform*. The core is now arguably over-hardened relative to a product that still has no accounts, no analytics, and a hard ~99-searches/day quota ceiling.

## (A) What the TL asked for — recovered, concretely

Genesis spec (`prompts/2026-07-05-session-003/001`) + the big batch (`.../011`) + follow-on prompts (014–022) + session-004 (07-11). All confirmed present in the archive; **no dropped asks hide in `_staging`** (the one real staged boraoke prompt was already flushed).

**Shipped (ask → ticket, DONE):**
- YouTube embed + shared queue + patron submission → TICKET-1/8/10
- Table numbers, sing vs listen/dance modes → TICKET-9/10
- Full-karaoke + rotation modes (2-per-table, one-per-person by uuid+nickname) → TICKET-3/10
- TV fullscreen (+ "increase the TV mode, fullscreen") → TICKET-18
- Clean room slugs (no extra chars unless taken) → TICKET-9/52
- "Já tem um código?" input bug + room-404 honesty → TICKET-20
- Search: jump-to-add-to-queue after select + "karaoke" keyword in sing mode → TICKET-40
- TV watchdog (player didn't run, had to hard-refresh) + embeddable-only → TICKET-41
- Skip only from TV + confirm session code → TICKET-45
- Session recoverable on localStorage without login → TICKET-43 (the *auto-sync-after-login* half is NOT done — needs accounts, TICKET-28)
- Language switcher + missing translations, "all main languages" → TICKET-30 (pt-BR/en/es; framework ready for more)
- Optional moderation ("make sure people don't add wrong-oriented stuff") → TICKET-44
- Rebrand cantai → Boraoke, buy/publish → TICKET-33/33a (boraoke.com live)

**Asked but NOT started (the fell-through list — see section C).**

## (B) Current state — honest read

Live at **https://boraoke.com** (Next.js 15 App Router, Vercel, Upstash Redis; every `main` merge auto-deploys prod). Trilingual pt-BR/en/es.

- **Works today:** multi-room + QR join + table capture; anonymous patron join (client uuid + nickname); sing/listen entry types; in-app YouTube search; all three rotation modes with round-robin fairness + atomic Lua writes; host controls (skip/remove/reorder/pause/mode/language/moderation toggle, per-room host-code auth); optional moderation with approve/reject; TV page with IFrame player, auto-advance, stall watchdog, fullscreen, QR, self-healing screen token; feedback widget; telemetry baseline; mobile verified at 390px. 542 unit tests + Playwright e2e.
- **Degraded modes / honest limits:**
  - **YouTube quota ceiling ~99 searches/day TOTAL across all venues** (10,000 units ÷ ~101/search). One busy bar night ≈ 80% of the daily budget. The quota-increase form text is written (`work/youtube-quota-form.md`) but **never submitted**. Degraded fallback = paste-a-YouTube-URL (first-class, works).
  - **Moderation pending store runs in-memory in prod** — the Upstash pending driver is written (TICKET-53) but **not provisioned**, so pending submissions are lost on lambda recycle in production.
  - **ADVANCE_AUTH is in log-only mode** — the enforce flip awaits an observation-window runbook; the screen token is scrapeable from the public TV page (accepted prototype trade-off).
- **Does NOT exist at all:** accounts / auth (Google OAuth planned), any server-side identity registry (patron uuid is client-only → every day is unclaimable history), payments, bot/CAPTCHA prevention, admin analytics/history, venue-type presets, dark/light theming, the automated feedback loop.
- **Ops fact:** boraoke can never auto-merge unattended — every merge is a live client-facing prod deploy — so heartbeats can only stack deliver-not-merge PRs or idle. **Merge throughput is the human bottleneck, not dev throughput.**

## (C) Reconciliation — ticketed vs FELL-THROUGH

**Already ticketed AND done:** everything in section A "Shipped" (tickets 0–53).

**FELL THROUGH — asked by the TL, groomed on 2026-07-07, never started:**

| Ask (verbatim-ish) | Ticket | Status | Why it matters |
|---|---|---|---|
| "register anonymous users from the start" | TICKET-26 anon identity registry | NOT STARTED | Foundational; every day without it is permanently unclaimable history. Roadmap itself flags the urgency. |
| "implement recaptch to prevent bots" | TICKET-27 bot prevention (Turnstile) | NOT STARTED | Public free product = bot magnet; gates safe account signup. |
| Google OAuth, "signup and everything registered", creds provided | TICKET-28 OAuth + retroactive claim | NOT STARTED | Creds were handed over; console origins for boraoke.com never added. Also unblocks the localStorage *auto-sync-after-login* half of TICKET-43. |
| "admin manage the queue with more control, adding musics, seeing stats", "all days of karaoke, musics played" | TICKET-31 admin dashboard v2 | NOT STARTED | Direct host-value ask, twice. |
| "doesn't necessarily need to be a bar" (weddings, parties, condos, corporate) | TICKET-32 venue generalization | NOT STARTED | Explicit market-expansion ask. |
| "more personality, customization, dark/light mode" | TICKET-29 theming | NOT STARTED | Asked twice (batch prompt 011). |
| "a loop to automatically collect and interact over user feedbacks for progressive development" | TICKET-39 (wave-7 directional) | NOT STARTED | A **founding-spec pillar** demoted to a one-line wave-7 candidate. Widget (11) + telemetry (12) shipped; the actual close-the-loop automation never did. |
| menu ordering, "people need to pay to put musics" | TICKET-34/35/37 | NOT STARTED | Directional; gated on business decisions. |

**FELL THROUGH — operational / debt, not a feature ask but a shipped-thing-is-incomplete gap:**

- **Upstash pending driver not provisioned in prod** → moderation pending is fragile (TICKET-53 built it; nobody flipped it on).
- **YouTube quota-increase form never submitted** → the whole product is capped at ~1 bar-night/day of search.
- **ADVANCE_AUTH stuck in log-only** → enforce-flip runbook never run.
- **TICKET-20 HIGH follow-up** (computed-style contrast assertion — the render/link/UX suite the TL asked for would MISS contrast-class bugs) → filed for wave 4, never done.
- **Upstash search cache** (board follow-up: "biggest quota lever") → never built; directly compounds the quota ceiling.
- **F110 `*.jsonl merge=union` `.gitattributes`** → the framework fix was never ported here; every future open PR re-hits the event-log false-conflict.
- **Stale "cantai" naming** in `CLAUDE.md`, `work/status/BOARD.md` title, and `work/roadmap.md` → cosmetic but confusing.

## (D) Proposed prioritized roadmap

PO proposes; the TL confirms. Ordered within each band by dependency + leverage.

### P0 — unblock scale + pay the launch-critical debt (do these before growing anything)

- **P0-1 — File the YouTube quota-increase request.** TL action (form text ready at `work/youtube-quota-form.md`). The ~99-searches/day ceiling caps the product at one bar-night. Without this OR permanent acceptance of degraded paste-URL mode, live search does not survive a real venue.
- **P0-2 — Upstash search cache + cross-instance rate buckets** (board's "biggest quota lever"; the deferred FU-2b dual-bucket work). Engineering complement to P0-1 — caching is the only lever that reduces burn under the current quota.
- **P0-3 — Provision the Upstash pending driver in prod.** Small config task; makes the already-shipped moderation feature actually durable in production.
- **P0-4 — Anonymous identity registry (TICKET-26).** The "register anonymous users from the start" foundation. Urgency is real and compounding: every day it waits, more history is permanently unclaimable, and it is the hard dependency under accounts + analytics.

### P1 — the founding growth arc (in dependency order)

- **P1-1 — Bot prevention / Turnstile (TICKET-27).** Asked ("recaptch"); protects room-create/join/feedback; must land before public signup.
- **P1-2 — Google OAuth + retroactive claim (TICKET-28).** Asked; creds in hand. Includes adding boraoke.com to the OAuth console origins and delivering the auto-sync-after-login half of session recovery.
- **P1-3 — Admin dashboard v2 / analytics (TICKET-31).** Asked twice; the host's reason to come back — "all karaoke days, songs played, live-now", add-songs, richer queue management.
- **P1-4 — Automated feedback loop (pull TICKET-39 forward).** Restore the founding pillar: mine feedback/telemetry → tickets → "your suggestion shipped" back to the uuid. Honors the BINDING intake-contract condition (lagging watermark + id-dedupe).
- **P1-5 — ADVANCE_AUTH enforce flip** (observation-window runbook) + **TICKET-20 contrast-assertion HIGH follow-up** — close the two open security/quality debts on already-shipped features.

### P2 — experience, platform, monetization (groom after P1 lands)

- **P2-1 — Theming dark/light + personality (TICKET-29).**
- **P2-2 — Venue generalization v1 (TICKET-32)** — party/event, condo, corporate presets.
- **P2-3 — Telemetry completions + e2e deflake (TICKET-25).**
- **P2-4 — Payments foundation (TICKET-34) → pay-to-boost (35) → dedications (36) → menu ordering (37)** — gated on the TL business decisions below.
- **P2-5 — Housekeeping:** rename "cantai"→"boraoke" in CLAUDE.md/board/roadmap; port the F110 `merge=union` `.gitattributes`; worktree cleanup of ~12 orphaned `.worktrees/*`.

### Structural recommendation

Boraoke has been in pure-hardening mode since 2026-07-07 while the growth backlog sat untouched. If the intent is to grow, **P0-4 + P1 should start now**; continuing to mint LOW-value hardening PRs only grows the deliver-not-merge pile against a human-merge bottleneck. If the intent is to hold at "great karaoke core," say so and pause the heartbeat — either is fine, but the current drift (hardening a core that's already hard, while founding growth asks age) should be a deliberate choice, not an accident.

## (E) Decisions the TL must make

1. **YouTube quota:** file the increase request now, or accept degraded paste-URL as the permanent day-one posture? (Blocks P0 scale.)
2. **Grow or hold?** Start the growth arc (P0-4 + P1) now, or deliberately hold at "great karaoke core" and pause the heartbeat? (The core has been hardening-only since 07-07 — is that intentional?)
3. **Bot vendor:** Turnstile (PO recommendation — free, invisible-first, LGPD-friendlier) vs reCAPTCHA (what you named as intent)?
4. **Payments business setup** (blocks all monetization): CNPJ vs MEI, which Mercado Pago account receives, fiscal/refund posture, venue revenue-share % (proposed 50/50).
5. **First paid feature + fairness-bounding sign-off:** pay-to-boost via Pix/MP recommended — the fairness-bounded priority design touches the product's soul and needs your explicit OK.
6. **Venue-type shortlist:** party/event + condo + corporate as the first three beyond bars — confirm or re-order.
7. **i18n launch set:** pt-BR/en/es confirmed, or add more languages now?
8. **Merge cadence:** since every merge = a live deploy, do you want a fixed batch-merge rhythm, or continue per-PR on-demand?
