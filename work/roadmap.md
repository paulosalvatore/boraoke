# cantai — Product Roadmap v2 (platform vision)

- **Owner:** Product Owner (TICKET-22; supersedes the TICKET-5 roadmap)
- **Last groomed:** 2026-07-07
- **Status:** proposed — priorities are the Tech Lead's to confirm (PO proposes, never imposes)
- **Naming note:** the TL greenlit the rename to **Boraoke** (boraoke.com bought 2026-07-07; DNS pending TL; assets in generation). Specs stay name-agnostic ("cantai" below means "the product") because the live product runs under the old name until TICKET-33 executes the rebrand in its solo merge window.

## North star (v2)

Anyone hosting a gathering — a bar, a birthday party, a wedding, a condo salão de festas, a company offsite — can run a great interactive music night with **zero setup and zero cost to start**: guests scan a QR, pick a song, and the venue screen just plays, fairly. cantai grows from a karaoke queue into the **interaction layer for the venue's screen and the guest's phone** — song queue first, then menu ordering, paid boosts, dedications, and whatever the room wants next — monetized additively (hosts and guests can pay for extras) while the core loop stays free and fair forever.

Primary early market remains Brazil (pt-BR-first), with multi-language support opening the product beyond it.

## Guiding principles (v2)

- **The TL's free-early-access promise holds.** Everything that exists today stays free. Paid features are additive extras layered on top — never a paywall in front of existing functionality, and **never a paywall on fairness** (paid priority is bounded by the rotation engine so the free queue never starves; see `work/planning/platform-aggregation.md`).
- **Anon-first identity.** Every visitor is a server-registered anonymous user from first touch; signing up retroactively claims everything they did anonymously. Nobody is ever forced to log in to sing. See `work/planning/accounts-and-identity.md`.
- **Venue-type generalization over venue-type forks.** One product, per-type presets (copy, theming, modes, feature flags) — not N verticalized apps. See `work/planning/venue-generalization.md`.
- **Prototype → MVP → PMF → 1.0** house iteration model continues; each platform extension ships as its own thin vertical slice.
- **YouTube ToS compliance stays non-negotiable:** IFrame Player API embeds only, visible player.
- Prior strategy specs remain in force where not superseded: `work/planning/early-access-monetization.md` (freemium venue posture; v2 adds guest-side additive payments, which that spec's "no patron-side monetization" analysis did not anticipate — the fairness-preserving design in `platform-aggregation.md` is the reconciliation), `work/planning/feedback-loop.md`, `work/planning/rotation-modes-fair-queue.md`.

## Where we are (honest snapshot, 2026-07-07)

### LIVE (PMF feature set, 14 PRs merged)

Multi-room + QR join + table capture, host controls, all three rotation modes wired to UI, in-app YouTube search (pending API key), feedback widget, telemetry baseline, TV fullscreen mode, durable store LIVE on Upstash (provisioned + verified 2026-07-07), deployed at https://cantai-snowy.vercel.app.

### IN FLIGHT (v2 wave 0, launched 2026-07-07)

| Ticket | What | Status |
|---|---|---|
| TICKET-20 | P0 UX fixes: room-404 honesty, join-code input bug, YT-embed report, clean slugs, admin→customer links + render/link test suite | Dev (opus), in progress |
| TICKET-21 | Atomic store RMW (HIGH from PR #14 opus): WATCH/Lua CAS on QueueStore + concurrency regression test | Dev (opus), in progress, `lib/store/**` only |
| TICKET-22 | This roadmap v2 | PO (fable), this PR |
| TICKET-23 | Design v2: full UX audit, theming dark/light direction, i18n direction, admin analytics UX | Designer (fable), in progress |
| (research) | Naming + domain availability | RESOLVED — TL bought boraoke.com and greenlit the rename (executes as TICKET-33) |

### BLOCKED ON TL (needs-user, carried from the board)

- 🟢 RESOLVED: **Upstash Redis provisioned 2026-07-07** (live in prod, verified) — queues and feedback are durable; TICKET-26's hard dependency is satisfied; wave 4 arms on TICKET-20 + TICKET-21 merge only.
- 🟡 **YouTube Data API key + quota plan** — unblocks live search; quota-increase request or degraded-fallback acceptance per the PR #8 opus condition.
- 🟡 **Boraoke DNS** — domain bought, DNS pending TL (blocks the TICKET-33 cutover, nothing else).

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

Preconditions: wave 4 arms only after TICKET-20 and TICKET-21 merge (they own `app/**` UX surfaces and `lib/store/**` respectively). TICKET-23's design spec should land before TICKET-29/30 start (soft dependency — flagged per-ticket).

### Wave 4 — hardening + identity foundation

| # | Ticket (proposed) | What / why | Owns (files) | Depends on |
|---|---|---|---|---|
| 24 | Hardening batch (board follow-ups) | Pays the recorded debt in one mechanical pass: strip patronUuid from public GET /api/queue (hashed own-row marker), advance-guard for the ENDED-vs-skip double-advance, setQueue if-changed diff on /tv, rotation.ts JSDoc + grace-path check, host-login throttle → Upstash, search cache + rate buckets → Upstash (the biggest YT-quota lever). | `lib/store/**` (post-21), `lib/rotation.ts`, `app/api/queue/**`, `app/api/search/**`, `app/tv/**` | TICKET-21 merged (Upstash ✅ live since 2026-07-07) |
| 25 | Telemetry completions + e2e deflake | The #16 follow-ups (patron_joined client beacon, noshow emitter) so retention data is complete before accounts launch, plus the MED CI-flake fix (shared memory-driver e2e helper: warmUp + seed-after-compile, bounded /tv waits). | `lib/telemetry/**`, `e2e/**` | none (parallel-safe with 24) |
| 26 | Anonymous identity registry | The anon-first foundation: server-issued uuid identity record for every visitor from first touch, rooms stamped with creatorUuid, activity keyed server-side — so signup can later claim it all retroactively. TL directive: "register anonymous users from the start". | `lib/identity/**`, `app/api/identity/**`, middleware, room-creation write path (coordinate one-file seam with 24's queue projection — merge 24 first) | Upstash ✅ (hard dep — satisfied 2026-07-07); merge 24 first (shared seam) |
| 27 | Bot prevention + abuse controls | CAPTCHA-class protection (recommend Cloudflare Turnstile: free, invisible-first, LGPD-friendlier than reCAPTCHA — TL said "reCAPTCHA" as intent, not vendor; TL confirms vendor) on room creation, join, feedback POST; per-uuid velocity caps. | `lib/abuse/**`, guard call-sites in `app/api/rooms|feedback/**`, join UI widget slot | none; touches api/rooms after 26 stamps creatorUuid — merge 26 before 27 |

### Wave 5 — accounts + experience

| # | Ticket (proposed) | What / why | Owns (files) | Depends on |
|---|---|---|---|---|
| 28 | Host accounts: Google OAuth + retroactive claim | Sign-in (Auth.js + the existing Google client), account ↔ anon-uuid linking, retroactive claim of rooms/stats created under that uuid, legacy pre-26 rooms claimable via host-token proof, account page skeleton, LGPD groundwork (privacy page, deletion path). | `lib/auth/**`, `app/api/auth/**`, `app/account/**`, `app/(legal)/privacy` | 26 (identity registry), 27 (signup endpoints need bot guards) |
| 29 | Theming: dark/light + personality | Theme provider + token-based dark/light modes, venue personality presets (foundation for per-type theming in 32), the TICKET-23 design direction made real. Design-token consolidation (tv CSS module) folds in here. | `styles/**`, theme provider, CSS modules (visual layer only — no string changes) | TICKET-23 spec (soft) |
| 30 | i18n: multi-language framework | String extraction to locale files, pt-BR + en + es at launch, framework ready for "all main languages" (fr/de/it/ja follow as translation-only PRs), locale switcher + browser detection. | `locales/**`, string-extraction touches across components (text layer only) | TICKET-23 spec (soft). ⚠️ 29 and 30 both touch every component file on different lines — same-wave OK but **merge 29 first, 30 rebases** (string extraction is the more mechanical rebase) |

### Wave 6 — admin power + venue generalization + rebrand

| # | Ticket (proposed) | What / why | Owns (files) | Depends on |
|---|---|---|---|---|
| 31 | Admin dashboard v2 | The rich management surface the TL asked for: host adds songs directly, full queue management upgrades, stats/history views (all karaoke days, songs played, live-now), prominent links/QRs to guest and TV screens. | `app/admin/**` (new dashboard routes), `app/api/admin/**`, reads `lib/telemetry` | 28 (stats ownership), 25 (complete telemetry) |
| 32 | Venue types v1 | Venue-type selection at room creation (bar / party-event / condo / corporate), per-type copy packs, theme presets, rotation-mode defaults, feature-flag matrix. | `lib/venue-types/**`, room-creation flow, copy/locale additions (translation files shared with 30 — additive keys only) | 29 + 30 (theming + i18n are the delivery vehicles), spec in `venue-generalization.md` |
| 33 | Rename/rebrand execution — **EXECUTE: rebrand to Boraoke** | Domain bought (boraoke.com), rename greenlit by the TL; assets in generation. New name across product, boraoke.com cutover with redirects from cantai-snowy, QR continuity for existing rooms, full copy sweep. | repo-wide copy/config sweep — **solo ticket, no wave-mates during its merge window** | DNS pending TL (cutover step only); brand assets delivered |

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

- Upstash ✅ provisioned 2026-07-07 — 24 and 26 fully unblocked; 26 → 28 → 31.
- 27 → 28 (signup surfaces need bot guards live first).
- TICKET-23 design spec → 29, 30 (soft); 29 + 30 → 32.
- 25 → 31 (stats need complete telemetry).
- Naming decision ✅ (Boraoke) → 33 executes; only the DNS/cutover step waits on the TL; 33 still runs solo.
- Nothing in waves 4–6 blocks on payments; the platform-aggregation wave (34+) is cleanly detachable if the TL resequences.

## Open questions (for the Tech Lead)

- **Bot-prevention vendor:** Turnstile (recommended) vs reCAPTCHA — see TICKET-27 rationale.
- **Language set for i18n launch:** proposal is pt-BR/en/es first, others as follow-up translation PRs — confirm or extend.
- **Venue-type shortlist:** proposal is party/event + condo + corporate as the first three beyond bars (schools/churches deferred — content-moderation prerequisite); see `venue-generalization.md`.
- **First paid feature + rail:** pay-to-boost via Pix/Mercado Pago recommended — see `platform-aggregation.md` for the scoring; the fairness-bounding design needs TL sign-off since it touches the product's soul.
- **Payments business setup (blocks TICKET-34 arming):** receiving money needs TL decisions — CNPJ vs MEI, which Mercado Pago account receives, fiscal/refund posture, and the venue revenue-share % (proposed 50/50). One needs-user round before the payments wave.
- **Rename timing:** name decided (Boraoke) — TICKET-33 can pull forward from wave 6 to any solo merge window once brand assets land; DNS remains on the TL for the cutover step.
