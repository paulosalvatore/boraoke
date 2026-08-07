# boraoke — Product Roadmap v2 (platform vision)

- **Owner:** Product Owner (TICKET-22; supersedes the TICKET-5 roadmap)
- **Last groomed:** 2026-07-07 (structure); brought current against the board/log on 2026-08-05 (TICKET-64); accuracy pass 2026-08-07 (deploy-gating premise superseded, PR count refreshed, growth-arc decision tally corrected — see MANAGER-LOG.md)
- **Status:** proposed — priorities are the Tech Lead's to confirm (PO proposes, never imposes)
- **Naming note:** the rename to **Boraoke** is DONE and has been live for weeks. `boraoke.com` was bought 2026-07-07, the code rebrand shipped as **TICKET-33 (PR #20, merged 2026-07-08)**, and DNS has been live since 2026-07-08 (re-verified `https://boraoke.com/` → HTTP 200 as of this edit). Below, "the product" means Boraoke throughout — no naming ambiguity remains. The only place the retired `cantai` name legitimately survives is a short, deliberate list of live production identifiers (localStorage keys, an HMAC salt, the `cantai-snowy.vercel.app` legacy-host redirect, and one negative test assertion) — see `work/status/BOARD.md`'s hazard note. Renaming those would drop live patron identity, so they are out of scope for any docs cleanup.

## North star (v2)

Anyone hosting a gathering — a bar, a birthday party, a wedding, a condo salão de festas, a company offsite — can run a great interactive music night with **zero setup and zero cost to start**: guests scan a QR, pick a song, and the venue screen just plays, fairly. Boraoke grows from a karaoke queue into the **interaction layer for the venue's screen and the guest's phone** — song queue first, then menu ordering, paid boosts, dedications, and whatever the room wants next — monetized additively (hosts and guests can pay for extras) while the core loop stays free and fair forever.

Primary early market remains Brazil (pt-BR-first), with multi-language support opening the product beyond it.

## Guiding principles (v2)

- **The TL's free-early-access promise holds.** Everything that exists today stays free. Paid features are additive extras layered on top — never a paywall in front of existing functionality, and **never a paywall on fairness** (paid priority is bounded by the rotation engine so the free queue never starves; see `work/planning/platform-aggregation.md`).
- **Anon-first identity.** Every visitor is a server-registered anonymous user from first touch; signing up retroactively claims everything they did anonymously. Nobody is ever forced to log in to sing. See `work/planning/accounts-and-identity.md`.
- **Venue-type generalization over venue-type forks.** One product, per-type presets (copy, theming, modes, feature flags) — not N verticalized apps. See `work/planning/venue-generalization.md`.
- **Prototype → MVP → PMF → 1.0** house iteration model continues; each platform extension ships as its own thin vertical slice.
- **YouTube ToS compliance stays non-negotiable:** IFrame Player API embeds only, visible player.
- Prior strategy specs remain in force where not superseded: `work/planning/early-access-monetization.md` (freemium venue posture; v2 adds guest-side additive payments, which that spec's "no patron-side monetization" analysis did not anticipate — the fairness-preserving design in `platform-aggregation.md` is the reconciliation), `work/planning/feedback-loop.md`, `work/planning/rotation-modes-fair-queue.md`.

## Where we are (honest snapshot, brought current 2026-08-05 against `work/status/BOARD.md`, `MANAGER-LOG.md` and `git log`)

### LIVE at https://boraoke.com (48 PRs merged as of 2026-08-07 — check `gh pr list --state merged | wc -l` for the current count; this figure rots, don't trust it beyond its as-of date)

Multi-room + QR join + table capture, host controls, all three rotation modes, in-app YouTube search (key provisioned, quota-increase request still not filed — see Open questions), feedback widget, telemetry baseline, TV fullscreen mode, durable store LIVE on Upstash (provisioned + verified 2026-07-07), the code rebrand to **Boraoke** (TICKET-33/33a, PRs #19–#20, merged 2026-07-08), anonymous identity registry Layer 1 (TICKET-26, PR #37, merged 2026-07-20), read-only admin analytics (TICKET-31, PR #38, merged 2026-07-20), and the operational hardening batch below.

All four wave-0 items are DONE, not "in flight": **TICKET-20** (P0 UX fixes, PR #17), **TICKET-21** (atomic store RMW, PR #16), **TICKET-22** (this roadmap v2, PR #15) and **TICKET-23** (design v2, PR #18) all merged 2026-07-07/08. The naming research is likewise resolved and executed, not pending (see the naming note above).

### Recently delivered and merged (2026-08-05)

**Deploy-gating rule (superseded 2026-08-07, corrected here — do not restate the old "fully-GATED" premise elsewhere in this doc).** boraoke is **pre-launch / non-live** for deploy-gating purposes — no payments, no real venue accounts, free early access per the README — so the earlier blanket "every merge is a live-client deploy, an unattended fire never merges without the TL" rule no longer holds. Current rule, stated once here: **gate-green backend/test/docs-only work auto-merges and auto-deploys** without per-PR TL sign-off (the TM merges it directly, same as any other gated product under D-043); **the TL still gates anything patron-facing** (UI/UX-visible changes) before merge. This is the 2026-08-06 merge-cadence decision (see `work/status/BOARD.md` Needs-user) reconciled with the 2026-08-07 pre-launch/non-live correction — together they are the one standing deploy rule for this product; check `work/status/BOARD.md` for anything more current, since it turns over faster than this roadmap. **PR #39** (TICKET-55, Upstash-backed YouTube search cache — the biggest quota lever), **PR #40** (TICKET-56, atomic Lua EVAL for `rejectAllPending`), **PR #41** (TICKET-57(a), archive boraoke prompts under the registered slug), and **PR #42** (TICKET-58, repoint the `run-app` skill at the canonical clone) were all delivered gate-green as a file-disjoint, mergeable-in-any-order batch, and **all four were merged 2026-08-05.** See `work/status/BOARD.md` for whatever is currently open — that list turns over fast and the board, not this roadmap, is the place to check before acting on it.

### BLOCKED ON TL (needs-user, carried from the board — see BOARD.md for the current, larger list)

- 🟢 RESOLVED: **Upstash Redis provisioned 2026-07-07** (live in prod, verified) — queues, feedback and the pending-moderation store are all durable.
- 🟢 RESOLVED: **Boraoke DNS** — domain bought 2026-07-07, DNS cutover executed, live since 2026-07-08 (`https://boraoke.com/` → HTTP 200).
- 🟡 **YouTube Data API quota-increase request** — key is provisioned in prod; the quota-increase form is drafted (`work/youtube-quota-form.md`) but has not been submitted, so the ~99-searches/day default ceiling still applies. The Upstash search cache (TICKET-55, merged) reduces quota burn but is a mitigation, not a substitute for filing the form.
- 🟡 **The remaining growth-arc decisions, corrected 2026-08-07 against `work/status/BOARD.md`'s "4 of the original 8 are now CLOSED" tally: YouTube quota (file or accept degraded), payments business setup, first paid feature sign-off, venue-type shortlist.** (Bot-prevention vendor = Turnstile, decided 2026-08-06; i18n language set = shipped, TICKET-30 live; merge cadence = decided 2026-08-06 — all three now closed, see above.) See `work/status/BOARD.md` for the current, up-to-date list; it changes more often than this roadmap does.

## Phases (v2)

Phases are the narrative; the Groomed backlog below is the buildable ticket-level order. Wave 0 is in flight; waves 4–6 are groomed and ready to arm; wave 7+ is directional.

### Phase 1 — Karaoke-core hardening (wave 4)

Goal: the live product survives a real crowded night with hostile or clumsy traffic, and the known debt is paid before the platform grows on top of it.

Why first: every v2 pillar (identity, payments, menus) multiplies traffic and stakes; races, quota burn, and bot exposure get more expensive to fix later. This phase also folds in the honest debt: the PR #14 hardening batch, the #16 telemetry completions, and the LOW/MED board items.

Includes the identity **foundation** (anonymous registration, TICKET-26) because the TL directive is "register anonymous users from the start" — every day without it is unclaimable history.

### Phase 2 — Accounts & identity (wave 5)

Goal: hosts can sign up (Google OAuth), retroactively claim every room and stat they created anonymously, and see their history (karaoke days, songs played, what's happening now). Guests stay anonymous unless they choose otherwise.

Also carries the experience layer the TL asked for — personality/customization, dark/light mode, multi-language — because accounts and theming/i18n together are the prerequisites for venue generalization (a wedding host needs the product to look and speak like a wedding, and needs an account to own the event).

Spec: `work/planning/accounts-and-identity.md`.

### Phase 3 — Venue-type generalization (wave 6)

Goal: the product stops assuming "bar". A host picks a venue type (party/event, condo/community, corporate — the three highest-leverage beyond bars) and gets the right copy, theme preset, rotation defaults, and feature flags. The admin dashboard grows into the rich management surface the TL asked for (host adds songs, stats, links to guest screens).

Spec: `work/planning/venue-generalization.md`.

### Phase 4 — Platform aggregation (wave 7+)

Goal: the QR the guest already scanned becomes the venue's interaction rail: menu ordering, pay-to-boost songs, tips, dedications. Payments land on **Pix via Mercado Pago** (house has MP experience from desapega).

First paid feature recommendation: **pay-to-boost ("Destaque") — a fairness-bounded paid priority slot, venue-opt-in, Pix one-tap**. Full scoring and the fairness-preserving design: `work/planning/platform-aggregation.md`.

### Phase 5 — Monetization activation (1.0)

Goal: flip on revenue without breaking the promise. Two rails, activated in this order:

1. **Guest-side additive payments** (pay-to-boost, dedications, tips) — venue-opt-in, live as soon as Phase 4 ships them; these are extras, so they don't violate free-early-access.
2. **Venue-side pro plan** (branding removal, multi-room, advanced analytics, revenue-share configuration) — per `early-access-monetization.md`, flipped only when PMF-phase telemetry supports pricing; founding-venue grandfathering honored.

Ops hardening lands here too: ToS/privacy pages (started in Phase 2 with LGPD groundwork), abuse controls at scale, uptime posture.

## Groomed backlog — next 3 waves (TICKET-19 wave discipline)

Rules carried from TICKET-19: one worktree per ticket, explicit file-ownership boundaries so wave-mates never collide, dependency edges explicit, waves merge in order within themselves when boundaries touch.

Preconditions: wave 4 arms only after TICKET-20 and TICKET-21 merge — **both merged 2026-07-07/08.** TICKET-23's design spec should land before TICKET-29/30 start (soft dependency — flagged per-ticket) — **TICKET-23 merged 2026-07-08.**

**Status update (2026-08-05):** this section's numbering was the PO's *proposed* ticket numbers at grooming time (2026-07-07); actual delivery mostly used those same numbers where the row shipped as first-groomed, but the fleet has since delivered a long tail of additional, differently-numbered tickets (TICKET-40 through TICKET-58) not previewed here — this roadmap is the vision/sequencing document, `work/status/BOARD.md`'s Tickets table is the authoritative per-ticket status. Per-row status below, verified against `git log`/`gh pr list` for TICKET-64:

### Wave 4 — hardening + identity foundation

| # | Ticket (proposed) | What / why | Owns (files) | Status |
|---|---|---|---|---|
| 24 | Hardening batch (board follow-ups) | Pays the recorded debt in one mechanical pass: strip patronUuid from public GET /api/queue (hashed own-row marker), advance-guard for the ENDED-vs-skip double-advance, setQueue if-changed diff on /tv, rotation.ts JSDoc + grace-path check, host-login throttle → Upstash, search cache + rate buckets → Upstash (the biggest YT-quota lever). | `lib/store/**` (post-21), `lib/rotation.ts`, `app/api/queue/**`, `app/api/search/**`, `app/tv/**` | **PARTIALLY DELIVERED, piecemeal, under different ticket numbers**: host-login throttle → TICKET-48 (merged, PR #30); search cache → TICKET-55 (merged, PR #39); rate buckets stay deferred as TICKET-55's own FU-2b. The patronUuid-strip / advance-guard / setQueue-diff items remain ungroomed as standalone tickets. |
| 25 | Telemetry completions + e2e deflake | The #16 follow-ups (patron_joined client beacon, noshow emitter) so retention data is complete before accounts launch, plus the MED CI-flake fix (shared memory-driver e2e helper: warmUp + seed-after-compile, bounded /tv waits). | `lib/telemetry/**`, `e2e/**` | **NOT STARTED** — still on the board as an ungroomed P2 item. |
| 26 | Anonymous identity registry | The anon-first foundation: server-issued uuid identity record for every visitor from first touch, rooms stamped with creatorUuid, activity keyed server-side — so signup can later claim it all retroactively. TL directive: "register anonymous users from the start". | `lib/identity/**`, `app/api/identity/**`, middleware, room-creation write path | **MERGED — TICKET-26, PR #37, 2026-07-20** (Layer 1). Deployed. |
| 27 | Bot prevention + abuse controls | CAPTCHA-class protection (recommend Cloudflare Turnstile: free, invisible-first, LGPD-friendlier than reCAPTCHA — TL said "reCAPTCHA" as intent, not vendor; TL confirms vendor) on room creation, join, feedback POST; per-uuid velocity caps. | `lib/abuse/**`, guard call-sites in `app/api/rooms|feedback/**`, join UI widget slot | **NOT STARTED — blocked on TL vendor decision** (Turnstile vs reCAPTCHA), per `work/status/BOARD.md`. Next P1 item in the growth arc. |

### Wave 5 — accounts + experience

| # | Ticket (proposed) | What / why | Owns (files) | Status |
|---|---|---|---|---|
| 28 | Host accounts: Google OAuth + retroactive claim | Sign-in (Auth.js + the existing Google client), account ↔ anon-uuid linking, retroactive claim of rooms/stats created under that uuid, legacy pre-26 rooms claimable via host-token proof, account page skeleton, LGPD groundwork (privacy page, deletion path). | `lib/auth/**`, `app/api/auth/**`, `app/account/**`, `app/(legal)/privacy` | **NOT STARTED** — blocked on 27 (bot guards on signup surfaces). |
| 29 | Theming: dark/light + personality | Theme provider + token-based dark/light modes, venue personality presets (foundation for per-type theming in 32), the TICKET-23 design direction made real. Design-token consolidation (tv CSS module) folds in here. | `styles/**`, theme provider, CSS modules (visual layer only — no string changes) | **NOT STARTED** — still an open P2 item on the board. |
| 30 | i18n: multi-language framework | String extraction to locale files, pt-BR + en + es at launch, framework ready for "all main languages" (fr/de/it/ja follow as translation-only PRs), locale switcher + browser detection. | `locales/**`, string-extraction touches across components (text layer only) | **MERGED — TICKET-30, PR #23, 2026-07-09.** Delivered well ahead of this proposed wave-5 slot (it unblocked search-UX and other wave-4/6 work early). |

### Wave 6 — admin power + venue generalization + rebrand

| # | Ticket (proposed) | What / why | Owns (files) | Status |
|---|---|---|---|---|
| 31 | Admin dashboard v2 | The rich management surface the TL asked for: host adds songs directly, full queue management upgrades, stats/history views (all karaoke days, songs played, live-now), prominent links/QRs to guest and TV screens. | `app/admin/**` (new dashboard routes), `app/api/admin/**`, reads `lib/telemetry` | **MERGED — TICKET-31, PR #38, 2026-07-20** (read-only analytics scope). Deployed. |
| 32 | Venue types v1 | Venue-type selection at room creation (bar / party-event / condo / corporate), per-type copy packs, theme presets, rotation-mode defaults, feature-flag matrix. | `lib/venue-types/**`, room-creation flow, copy/locale additions (translation files shared with 30 — additive keys only) | **NOT STARTED** — blocked on the venue-type shortlist TL decision. |
| 33 | Rename/rebrand execution | Domain bought (boraoke.com), rename greenlit by the TL; new name across product, boraoke.com cutover with redirects from the legacy `cantai-snowy` host, QR continuity for existing rooms, full copy sweep. | repo-wide copy/config sweep — ran as a solo ticket, no wave-mates during its merge window | **EXECUTED AND LIVE — TICKET-33 (PR #20) + TICKET-33a brand assets (PR #19), both merged 2026-07-08.** DNS cutover complete, live since 2026-07-08 (`https://boraoke.com/` verified HTTP 200). The legacy `cantai-snowy.vercel.app` host still 308-redirects here per design — see the hazard note at the top of this file; that redirect config is deliberate and out of scope for any docs cleanup. |

### Wave 7+ (directional — groom after wave 5 ships, before arming)

| # | Candidate | One-line |
|---|---|---|
| 34 | Payments foundation: Mercado Pago + Pix | MP integration lib, Pix checkout (QR + copia-e-cola), webhook confirmation, venue payout model — the rail everything paid rides on. |
| 35 | Pay-to-boost v1 ("Destaque") | The recommended first paid feature: fairness-bounded paid priority, venue-opt-in, venue revenue share. |
| 36 | Song dedications | Paid message on the TV with a song ("parabéns, Ana!") — wedding/party killer feature, near-zero marginal build after 34. |
| 37 | Menu ordering pilot | Guest orders from the same QR; start with a single pilot venue, order-to-WhatsApp/printer before any POS dream. |
| 38 | Realtime upgrade evaluation | Carried from v1 backlog (#17): polling/SSE → ws only if telemetry shows session sizes hurting. |
| 39 | Close-the-loop notifications + public changelog | Carried from v1 backlog (#15): "your suggestion shipped", keyed to uuid; depends on the framework-side feedback-intake loop (D-046) and its BINDING intake-contract condition (lagging watermark + id-dedupe, PR #11 opus). |

Retired from the v1 backlog: #14 "venue accounts + rooms model" is superseded by TICKET-26/28 (the anon-first model is a different and better shape); #16 "venue analytics view" is absorbed into TICKET-31 (admin dashboard v2 IS the analytics view).

### Dependency edges (summary)

- Upstash ✅ provisioned 2026-07-07 — 24 and 26 fully unblocked; 26 (✅ merged) → 28 → 31 (✅ merged, ahead of 28).
- 27 → 28 (signup surfaces need bot guards live first) — 27 still not started, so 28 stays blocked.
- TICKET-23 design spec (✅ merged 2026-07-08) → 29, 30; 30 ✅ merged (i18n shipped without waiting on 29); 29 + 30 → 32 (32 still blocked on 29 and the venue-type decision).
- 25 → 31 — 31 shipped (✅ merged) without waiting on 25; the stats it exposes are what exists today, not blocked by 25's telemetry completions.
- Naming decision ✅ (Boraoke) → 33 ✅ **executed** — DNS cutover done, live since 2026-07-08.
- Nothing in waves 4–6 blocks on payments; the platform-aggregation wave (34+) is cleanly detachable if the TL resequences. Payments (34+) remain not started.

## Open questions (for the Tech Lead)

_(Still open as of 2026-08-07 — cross-check `work/status/BOARD.md`'s "remaining growth-arc decisions" line before acting; that file is updated more frequently than this roadmap.)_

- **YouTube quota:** file the drafted increase request (`work/youtube-quota-form.md`) or accept the ~99-searches/day default ceiling permanently? The Upstash search cache (TICKET-55, merged) reduces burn but doesn't remove the ceiling.
- **Bot-prevention vendor:** Turnstile (recommended) vs reCAPTCHA — see TICKET-27 rationale. Blocks TICKET-27, which blocks 28.
- **Language set for i18n launch:** i18n itself shipped (TICKET-30, pt-BR/en/es) — this question is now narrower: extend to further languages (fr/de/it/ja) as follow-up translation PRs, or hold at three?
- **Venue-type shortlist:** proposal is party/event + condo + corporate as the first three beyond bars (schools/churches deferred — content-moderation prerequisite); see `venue-generalization.md`.
- **First paid feature + rail:** pay-to-boost via Pix/Mercado Pago recommended — see `platform-aggregation.md` for the scoring; the fairness-bounding design needs TL sign-off since it touches the product's soul.
- **Payments business setup (blocks TICKET-34 arming):** receiving money needs TL decisions — CNPJ vs MEI, which Mercado Pago account receives, fiscal/refund posture, and the venue revenue-share % (proposed 50/50). One needs-user round before the payments wave.
- ~~**Merge cadence:** every `main` merge auto-deploys live boraoke.com, so an unattended fire never merges — batch-merge cadence for whatever sits in the deliver-not-merge pile at any given time (check `work/status/BOARD.md` for the live list) is a standing TL decision.~~ ✅ **DECIDED 2026-08-06** (see the deploy-gating rule at the top of "Where we are" above): gate-green backend/test/docs-only auto-merges; patron-facing stays TL-gated. No longer open.
- **Rename timing:** name decided (Boraoke) — TICKET-33 can pull forward from wave 6 to any solo merge window once brand assets land; DNS remains on the TL for the cutover step.
