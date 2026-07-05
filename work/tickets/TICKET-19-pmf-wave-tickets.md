# TICKET-19 — PMF wave: buildable ticket batch

- **Date:** 2026-07-05 · **Product:** cantai · **Role:** Product Owner (spawned subagent)
- **Branch:** `ticket/19-pmf-wave-tickets` (worktree `.worktrees/ticket-19`)
- **TL directive (verbatim intent):** "Full horse to develop full features to release product to market fit."
- **Status:** in review (draft PR)

## Goal

Turn the merged roadmap backlog (#6–#12) plus the TL's TV follow-up (#18) into buildable, parallel-safe ticket files so a dev wave launches the moment the app skeleton (PR #4) merges. Each ticket carries goal, scope in/out, acceptance criteria, FILE-OWNERSHIP boundaries, dependencies, and wave assignment.

## Wave plan (parallel-dev grouping)

| Wave | Tickets | Gate to launch | Why grouped |
|---|---|---|---|
| 1 | TICKET-6 (persistence), TICKET-8 (YouTube search), TICKET-18 (TV fullscreen) | PR #4 merged | Zero cross-deps and disjoint file ownership: #6 owns `lib/store*` + queue APIs, #8 owns search + `app/page.tsx`, #18 owns `app/tv/**` |
| 2 | TICKET-7 (host controls), TICKET-9 (rooms/QR), TICKET-11 (feedback widget), TICKET-12 (telemetry) | TICKET-6 merged (all four); #9 additionally waits for #7 (`lib/host-auth.ts` must exist) and #8 (route restructure ordering); #12's `app/api/host/**` instrumentation waits for #7 | All consume #6's durable store/interface; ownership stays disjoint (#7 `app/admin`+`api/host`, #9 route restructure + rooms, #11 widget+layout, #12 telemetry libs). #12 rebases last (one-line instrumentation in shared routes) |
| 3 | TICKET-10 (rotation modes UI + spec↔lib alignment) | TICKET-7 + TICKET-9 merged; PR #3 merged | Capstone: edits the admin page (#7), room record (#9), queue read paths, and `packages/rotation-engine` — cannot run parallel with its inputs |

Dependency edges: 6 → {7, 9, 11, 12}; 7 → 9 (`lib/host-auth.ts`); 8 → 9; 7 → 12 (host-route instrumentation only); {3-lib, 7, 9} → 10; 18 → (7's small `/tv` pause-state read lands post-18).

## Calls made in this batch (rationale recorded per ticket)

1. **Store: Upstash Redis via Vercel Marketplace** (not Postgres/Neon) — queue-shaped hot state, serverless-safe HTTP SDK, free tier fits; Postgres deferred to venue accounts (#14). Interface frozen in #6 (incl. #7's ops, #9's room scoping, `graceRequeue`) so no wave-2 ticket edits `lib/store.ts`.
2. **Host auth: env admin token now, per-room host codes at #9** — one helper (`lib/host-auth.ts`) so the swap is a lookup change, not a call-site change.
3. **PR #3 spec↔lib alignment folded into TICKET-10** with an explicit delta table (A1–A6), policy per the merged spec, architecture per the lib.
4. **Monetization-spec AC4 ("powered by cantai" footer + flag) assigned to TICKET-18** — TV-surface concern, that ticket owns the file.
5. **Shared-file protocol:** exactly one sanctioned code overlap in the batch — #12's one-line `track()` calls in routes owned by #6/#7/#8, additive-only, lands last.
6. **`.env.example` appends merge sequentially:** #6 owns the file; #7, #8, and #11 each append one line. Appends are trivial-conflict edits — whoever merges later rebases and re-appends; never reformat or reorder existing lines.

## Needs-user (W7 flags)

- **TICKET-8:** YouTube Data API v3 key (Google Cloud console) → Vercel env + local `.env`. Buildable without it (mocks + degraded paste-link mode); blocks live verification only.
- **TICKET-6:** provision Upstash Redis on the connected Vercel project + env vars — TL creds or TM with dashboard access.

## Deliverables in this PR

`work/tickets/TICKET-{6,7,8,9,10,11,12,18}-*.md` (8 buildable tickets), this file, `work/roadmap.md` status refresh (TICKETs 0–5 done/in-gates; backlog rows annotated with filed-ticket status).

## Gates note

Docs-only change: App Tester N/A-by-content (TM to record); Security/Reviewer gates apply to the documents.
