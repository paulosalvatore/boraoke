# Spec — Feedback loop (in-app widget + house-side automated intake)

- **Product:** cantai
- **Author:** Product Owner (TICKET-5)
- **Date:** 2026-07-05
- **Status:** proposed spec — buildable; intended consumers: backlog #11 (widget + store), #12 (agent loop), #15 (close the loop)
- **Priority rationale:** the TL named this a core intent ("a loop where the house automatically collects, triages, and acts on user feedback for progressive development"). It is both a product feature and the house's structural differentiator: cantai should visibly improve week over week because its users talk to an agent fleet, not a void.

## User story

As a **patron or host**, when something delights or annoys me I can say so in under 5 seconds without leaving the page, signing up, or typing anything mandatory — and later I actually find out my feedback changed the product.

As the **house**, every piece of feedback is automatically collected, clustered, and triaged into proposed tickets on a schedule, with humans gating what ships — no feedback ever rots unread in a table.

## Part A — In-app feedback widget (product side)

### Placement & trigger

- A small floating button (design per TICKET-4 system) on the **patron pages** and the **host view**. NOT on `/tv` (it's a non-interactive venue screen; TV problems get reported from phones).
- Contextual micro-prompts at high-signal moments (max 1 per session, dismissible, never blocking): after a patron's first song finishes playing → "how was it?"; after a host ends a session → "how was tonight?".

### Interaction (zero-friction is the acceptance bar)

- Tap → a sheet with: **1-tap sentiment** (😍 🙂 😕 😡), **optional** short free text, **optional** category chips (song search, queue/fairness, TV player, other). Submit enabled after sentiment alone — everything else optional.
- No email field, no login, no captcha. Rate limit: 5 submissions per uuid per hour (server-side).
- Confirmation states the promise: "Thanks — a human-supervised robot reads every one of these. Watch the changelog."

### Auto-attached context (no user effort)

Each submission carries: `uuid`, `nickname`, `venueId/sessionId`, `page/route`, active `mode`, `role` (patron/host), `appVersion` (git sha), `locale`, `userAgent` (coarse), `createdAt` (server time). No precise location, no PII beyond the self-chosen nickname (LGPD-friendly by construction).

### API & storage

- `POST /api/feedback` → validate + rate-limit → durable store (same persistence layer as backlog #6; feedback must NEVER be in-memory — losing feedback is losing the product's fuel).
- Record: `{ id, sentiment, text?, category?, context{...}, status: "new" | "triaged" | "planned" | "shipped" | "dismissed", triageRef? }`. `status` is what powers closing the loop.
- Read path for the house: `GET /api/feedback?since=<watermark>` guarded by a server-side admin token (house-only; never shipped to clients).

## Part B — House-side automated loop (the differentiator)

The pipeline, human-gated at exactly one point (ticket approval), agent-run everywhere else:

```
collect (widget) → store → mine (feedback-intake agent, periodic) → triage report + proposals
  → TM turns approved proposals into tickets → normal gate chain ships them
  → ship marks feedback "shipped" → close the loop (changelog + uuid notification)
```

### The feedback-intake agent (new house skill: `feedback-intake`)

- **Cadence:** periodic and cheap — on-demand at TM resume plus a scheduled run (daily during early access; weekly later). Runs on the cheap tier (sonnet/haiku per D-012); it's mining and clustering, not strategy.
- **Watermark:** reads `work/feedback/.watermark` (last processed feedback id/timestamp), fetches only newer items via the admin read path. Idempotent: re-runs never double-report.
- **Processing per run:**
  1. Fetch new items; discard spam/noise (empty rage-taps, gibberish) with a recorded count.
  2. **Cluster** semantically similar items (e.g. 7 variants of "search doesn't find sertanejo songs" = 1 cluster) with volume + sentiment mix per cluster.
  3. **Classify** each cluster: `bug` / `feature-request` / `ux-friction` / `praise` / `noise`, with severity (bugs) or demand-signal (features: how many distinct uuids/venues).
  4. Write a run report to `work/feedback/reports/<YYYY-MM-DD>-intake.md`: clusters, counts, verbatim representative quotes, trend vs previous run.
  5. Emit **ticket proposals** for actionable clusters into `work/feedback/proposals/<slug>.md` (problem, evidence quotes, affected volume, suggested acceptance criteria) — proposals, not tickets: the TM/PO/TL gate what becomes a ticket, keeping D-009's human gate intact.
  6. Mark processed items `triaged` (with `triageRef` = cluster/proposal id) via an admin write path, and advance the watermark.
- **Escalation rule:** any cluster that looks like a live-outage bug (many negative reports on the same venue/night) is flagged `URGENT` at the top of the report so the TM sees it at next resume rather than at the weekly grooming.
- **PO's standing role:** at each grooming pass, the PO folds accepted proposals into `work/roadmap.md` ordering — feedback volume becomes a first-class prioritization input alongside TL direction.

### Closing the loop with users (backlog #15, spec'd here for coherence)

- **Public changelog page** (`/changelog`): human-readable "what shipped this week", auto-drafted from merged feedback-linked tickets, TM-published.
- **Personal notification:** because identity is a device uuid, closing the loop is in-app: when a feedback item's linked ticket ships, the item's status flips to `shipped`, and the next time that uuid opens cantai it sees a small toast/inbox dot — "You asked for better search — it shipped ✅". This converts anonymous patrons into repeat users and repeat feedback-givers.
- Feedback items with status `dismissed` do NOT notify (no "we rejected your idea" toasts); the changelog carries the honest global record.

## Why this design (recorded rationale, autonomous run)

- **Proposals-not-tickets** keeps the agent loop fully automatic while preserving the house's human gate exactly where judgment lives (what to build), per D-009.
- **Watermark + idempotent runs** makes the agent safe to fire from cron, TM resume, or by hand without double-counting — matches the house's stop/resume operating style.
- **uuid-keyed in-app close-the-loop** is the only loop-closing channel we CAN have (no emails by design), and it doubles as a retention feature.
- **Feedback store is product-side (API), reports are house-side (work/feedback/)**: raw user data stays in the product's store; the repo only ever holds aggregated/representative excerpts — keeps the git record lean and the PII surface minimal.

## Acceptance criteria

1. A patron can submit sentiment-only feedback in ≤2 taps from any patron page; free text and category are optional; submission succeeds without any account.
2. Every stored feedback record carries the full auto-context (uuid, nickname, venue/session, route, mode, version) without the user entering any of it.
3. Feedback persists across deploys/restarts (durable store) and is retrievable by the admin read path with a `since` watermark; the admin token is never exposed client-side.
4. Rate limiting rejects the 6th submission per uuid per hour with friendly copy.
5. A `feedback-intake` run over a seeded set of ~20 mixed feedback items produces: one dated report with clusters + counts + quotes, ≥1 proposal file for the dominant actionable cluster, all processed items flipped to `triaged`, and an advanced watermark; a second immediate run produces no duplicates.
6. When a ticket linked to feedback items merges, those items flip to `shipped`, and the owning uuid sees an in-app notification on next visit; `/changelog` lists the shipped item.
7. The `/tv` route renders no feedback widget.

## Out of scope (v1)

- Email/WhatsApp loop-closing (no contact data by design), public feedback voting board (candidate later — would strengthen demand signals), screenshot attachment, sentiment analytics dashboard (folds into venue analytics, backlog #16).

## Dependencies & sequencing

Widget (#11) depends on durable persistence (#6). Agent loop (#12) depends on #11 plus a small framework-side skill (`feedback-intake`) — that skill is framework work and goes through the framework TM per D-046, not through this product repo. Close-the-loop (#15) depends on #12.
