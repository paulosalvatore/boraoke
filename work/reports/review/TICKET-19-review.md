# Reviewer Report — TICKET-19 (PMF wave ticket batch)

- **PR:** #5 `ticket/19-pmf-wave-tickets`
- **Reviewer:** Reviewer agent (Sonnet first-pass; docs-only — opus judgment pass not required per D-022 TM skip authority; recorded here)
- **Date:** 2026-07-05
- **Verdict:** REQUEST-CHANGES (1 blocking item; 2 nits)

---

## Preconditions

| Gate | Status | Note |
|---|---|---|
| App Tester | N/A-by-content | Docs-only change; no app behavior; correctly declared in TICKET-19 body |
| Cyber Security | N/A-by-content | Docs-only ticket spec files; no code, secrets, or runtime surface changed; TM declared N/A |
| CI | Green | Vercel deploy check: Ready; no required code CI runs (docs-only) |
| Dev report | N/A | PO-authored batch; TICKET-19 file is the record |

---

## What was reviewed

Diff read locally against `origin/ticket/19-pmf-wave-tickets` (git-local-first, S1 compliant):

```bash
BASE=$(git merge-base origin/main origin/ticket/19-pmf-wave-tickets)
git diff "$BASE"..origin/ticket/19-pmf-wave-tickets --stat
```

11 files changed, 451 insertions (+23 deletions from roadmap refresh).

**Files reviewed:**
- `work/tickets/TICKET-{6,7,8,9,10,11,12,18}-*.md` — 8 ticket files
- `work/tickets/TICKET-19-pmf-wave-tickets.md` — wave plan + rationale
- `work/roadmap.md` — status refresh + backlog annotation

**Specs cross-checked against:**
- `work/planning/rotation-modes-fair-queue.md` (merged, spec-authoritative)
- `work/planning/feedback-loop.md` (merged)
- `work/planning/early-access-monetization.md` (merged)
- `packages/rotation-engine/README.md` + `src/types.ts` (PR #3 lib, on main)

---

## Review dimensions

### 1. File-ownership boundaries — wave-by-wave walk

**Wave 1 (TICKET-6, TICKET-8, TICKET-18):**

| File / surface | #6 | #8 | #18 |
|---|---|---|---|
| `lib/store.ts` / `lib/store/**` | OWNS | must-not-touch | must-not-touch |
| `app/api/queue/**` | OWNS | — | must-not-touch |
| `app/page.tsx` | must-not-touch | OWNS (sole) | must-not-touch |
| `app/api/search/**` | — | OWNS | — |
| `lib/youtube-search.ts` | — | OWNS | — |
| `app/tv/**` | must-not-touch | must-not-touch | OWNS |
| `app/globals.css` | — | — | additive TV section |
| `package.json` | OWNS (upstash) | not stated | — |
| `.env.example` | OWNS | append YOUTUBE_API_KEY | — |

**Wave-1 collision:** `.env.example` is owned by #6 AND touched (append) by #8 in the same parallel wave. A rebase conflict will occur when the second PR merges. Both tickets acknowledge the file; neither designates sequential ordering for it. *(NIT — see below.)*

All other wave-1 boundaries are clean and disjoint.

**Wave 2 (TICKET-7, TICKET-9, TICKET-11, TICKET-12):**

| File / surface | #7 | #9 | #11 | #12 |
|---|---|---|---|---|
| `app/admin/**` | OWNS | — | must-not-touch | — |
| `app/api/host/**` | OWNS | — | — | instruments (additive, last) |
| `lib/host-auth.ts` | CREATES | extends (lookup swap) | — | — |
| `app/(patron)/[room]/**` | — | OWNS (new) | — | — |
| `app/page.tsx` | — | OWNS (landing rewrite, post-#8) | — | — |
| `app/layout.tsx` | — | — | SOLE OWNER (widget injection) | — |
| `lib/feedback-store.ts` | — | — | OWNS | — |
| `lib/telemetry.ts` | — | — | — | OWNS |
| `lib/telemetry-store.ts` | — | — | — | OWNS |
| `package.json` | — | OWNS (qrcode) | — | — |
| `.env.example` | append HOST_TOKEN | — | append one line | — |

**Wave-2 BLOCKING collision: `lib/host-auth.ts`**

TICKET-7 *creates* `lib/host-auth.ts`. TICKET-9 *extends* the same file ("the lookup swap only"). TICKET-9's declared dependencies are: `TICKET-6, TICKET-8` — TICKET-7 is **not listed**. Both TICKET-7 and TICKET-9 are wave-2 tickets eligible to start at TICKET-6 merge. A dev assigned TICKET-9 can start (per the wave plan), reach the `lib/host-auth.ts` step, and find the file does not exist yet or is being written simultaneously by #7. The dependency graph is wrong.

Fix: add `TICKET-7 (lib/host-auth.ts must exist)` to TICKET-9's `Depends on` line.

Sub-issue in the wave plan: the wave-2 row in TICKET-19's wave plan table should note that #9 additionally waits for #7 (not only for #8), since #9 touches #7's file. Currently only the #8 dependency is called out in the wave plan row.

**Wave-2 `.env.example`:** same pattern as wave 1 — #7 (append HOST_TOKEN) and #11 (append one line) are both wave-2 peers with no stated sequential ordering. *(NIT.)*

**Wave 2 → Wave 3 (TICKET-10):**

TICKET-10 touches: `packages/rotation-engine/**` (post-merge alignment), `lib/rotation.ts` (new), mode-switcher on `app/(patron)/[room]/admin`, queue read paths, submission validation, tests, e2e. Dependencies: PR #3 + TICKET-7 (admin page) + TICKET-9 (room record, table identity) + TICKET-6 (graceRequeue field). All correctly declared. Boundaries are clean and non-overlapping with anything else in this batch (wave 3 is single-ticket). ✓

### 2. Dependency / wave ordering soundness

- Store interface (TICKET-6) covers TICKET-7's needs: `removeEntry`, `reorder`, `setPaused`/`isPaused` all listed in #6's scope-in. ✓
- `graceRequeue?: boolean` reserved in #6's entry shape for #10's consumption. ✓
- Room-scoped key schema established in #6 (`room:default:*`) so #9 passes `roomId` without touching `lib/store.ts`. ✓
- #8 blocks #9 (route restructure of patron page after search UI lands): correctly declared in both tickets and the wave plan. ✓
- #9 alone restructures routes (coordination note present). ✓
- #12 rebases last in wave 2 for one-line instrumentation; "if the owning ticket is still open, land after it merges" text covers the #7 dependency for `app/api/host/**` instrumentation — implicit but navigable. *(NIT — see below.)*
- Wave 3 gate (TICKET-7 + TICKET-9 merged + PR #3 merged): correct. ✓

### 3. Acceptance criteria — testability and spec consistency

**TICKET-6:** 6 ACs. All testable (AC1 multi-instance durable state; AC3 memory-driver CI path; AC4 interface ops unit-tested; AC5 room-scoped keys; AC6 single import point). Consistent with the skeleton's `lib/store.ts` design. ✓

**TICKET-7:** 7 ACs. All testable (login gate, confirm-to-delete, reorder convergence, pause state, skip mid-video, token not in client, mode placeholder). Spec-consistent with no missing host-control operations. ✓

**TICKET-8:** 6 ACs. All testable (search→submit, paste-URL fallback, no-key build, bundle check, debounce+rate-limit, quota degraded state). Graceful-degradation path covers the needs-user gap cleanly. ✓

**TICKET-9:** 6 ACs. All testable (room creation + one-time host code display, isolated rooms, table metadata on all views, QR scan, legacy path redirect, localStorage). ✓

**TICKET-10 — spec↔lib alignment table (A1–A6):**

Cross-checked against `packages/rotation-engine/README.md` and `src/types.ts`:

| # | Claim | Verified against lib |
|---|---|---|
| A1 | full-karaoke: lib FIFO → spec round-robin-by-uuid | README confirms: "First-in, first-out (FIFO)"; spec §1 says round-robin-by-uuid. Delta confirmed. ✓ |
| A2 | caps: lib 2/table, 1/person → spec 4/table, 2/person | README confirms: "at most 2 sing songs" (table), "one song waiting at a time" (person). Spec says 4/table, 2/person. Delta confirmed. ✓ |
| A3 | listen policy: lib maxConsecutiveListen=1 (default interleave) → spec sings-only-when-sing-queue-empty | README confirms default=1 interleave. Spec says listens only when sing queue empty. Resolution: set `maxConsecutiveListen: 0` (which the README confirms reproduces spec behavior); keep interleave as venue toggle. ✓ |
| A4 | no-show: lib keeps standing (no graceRequeue) → spec adds single-use graceRequeue + second-no-show credit charge | `SkipResult` and `HistoryRecord` in types.ts have no graceRequeue field; `skip` just produces HistoryRecord{outcome:"skipped"} with no grace logic. Delta confirmed. ✓ |
| A5 | duplicates: lib rejects same-uuid+videoId → spec allows-with-warning (different uuids OK) | README: "same person submitting the same video twice in the same mode... rejected (`duplicate`)". Spec: "allowed (two people may want the same song), but the submit UI warns." Resolution in A5 (reject only same uuid+videoId; warn on song-level dupes for others) correctly matches what the lib already enforces. ✓ |
| A6 | naming: lib `mode`/`table` vs spec `kind`/`tableNumber` vs app `mode`/`table` | Adapter boundary naming is a dev judgment call; deferring correctly. ✓ |

TICKET-10's 8 ACs reference the rotation spec's 8 ACs verbatim as the contract. All 8 counted and confirmed present in the spec. ✓

**TICKET-11:** ACs reference spec ACs 1–4, 7 (Part A). Spec ACs 5 and 6 (intake agent loop, close-the-loop) are explicitly Part B and correctly out of scope for #11. Admin-token-not-in-client-bytes + design system tokens are additive ACs. ✓

Confirmation copy: "Valeu! Um robô supervisionado por humanos lê cada um desses. Fica de olho no changelog." — ticket uses pt-BR-first (correct for the product), notes the English line is intent not copy. Spec-consistent. ✓

**TICKET-12:** ACs reference monetization spec ACs 1–3, 5. AC4 ("powered by cantai" footer) is correctly transferred to TICKET-18. Fail-open is explicitly testable (AC2 + unit test mandate). ✓

**TICKET-18:** 6 ACs. All testable with Playwright (1080p screenshot for AC1; fullscreen enter/exit for AC2; idle-state DOM for AC3; regression e2e for AC4; env-flag header absence for AC5; wakeLock mock for AC6). ✓

### 4. Needs-user items

Both needs-user items (TICKET-8: YouTube Data API key; TICKET-6: Upstash provisioning) are:
- Correctly flagged in TICKET-19's needs-user section. ✓
- Not hard-blocking the build (both have tested fallback/mock paths). ✓
- Only block live-verification, not dev start or CI. ✓

### 5. Roadmap numbering + consistency

- Old #12 (feedback-intake agent) correctly stripped of a cantai ticket number (D-046, framework-side). Renumbering note in the roadmap is clear. ✓
- Telemetry takes ticket #12 (formerly #13). ✓
- #18 appended correctly as a TL follow-up. ✓
- Dependency notes in roadmap updated: `#6 blocks #7, #9, #11, #12; #8 blocks #9; #10 depends on #3/#7/#9`. More precise than the old blanket "#6 blocks #7–#16". ✓
- Status refresh for TICKET-0–5: accurate (done / in-gates with PR numbers). ✓

### 6. Markdown quality

Consistent headers, scope in/out sections, file ownership tables, dependency/blocks metadata, and ACs across all 8 tickets. Cross-references to spec files are precise (section-level). Wave plan table is readable and correctly summarizes the dependency edges. Quality is high.

---

## Findings

### BLOCKING

**B1 — TICKET-9 missing TICKET-7 dependency**

`TICKET-9-qr-join-rooms.md` Depends-on line reads: "TICKET-6 (room-scoped keys), TICKET-8 (patron page final form before the route move)."

TICKET-9 explicitly owns `lib/host-auth.ts (the lookup swap only)` — editing the file *created* by TICKET-7. If a dev starts TICKET-9 at the wave-2 gate (TICKET-6 + TICKET-8 merged), `lib/host-auth.ts` may not exist yet, causing a build error or forcing parallel development of the same file.

Required fix: add `TICKET-7 (lib/host-auth.ts must exist)` to TICKET-9's `Depends on` line.

Also add a sub-ordering note to the wave-2 row of the TICKET-19 wave plan: "#9 additionally waits for #7 (lib/host-auth.ts)" alongside the existing "#9 additionally waits for #8."

---

### NITS (non-blocking — fix improves clarity but does not block merge)

**N1 — `.env.example` wave-1 and wave-2 sequential note missing**

Wave 1: TICKET-6 owns `.env.example`; TICKET-8 appends to it. Wave 2: TICKET-7 and TICKET-11 both append to it. Parallel feature branches will produce a trivially-resolvable rebase conflict on this file. The tickets don't warn dev that the second-to-merge must rebase.

Suggested addition to TICKET-8 and TICKET-11 ownership notes (one line each): "Merge ordering for `.env.example`: rebase on the preceding ticket's merge before opening PR."

**N2 — TICKET-12 implicit #7 instrumentation dependency**

TICKET-12 needs to instrument `app/api/host/**` (TICKET-7's files). Its "if the owning ticket is still open, land after it merges" language handles this, but TICKET-7 is not listed in the Depends-on or Soft-coordinates line. Adding "Soft-coordinates with TICKET-7 (must merge before `app/api/host/**` instrumentation)" to the shared-file protocol note would make the sub-ordering explicit for the dev.

---

## Summary

The batch is architecturally sound. The wave structure is well-reasoned, the spec-to-AC traceability is strong (especially the A1–A6 alignment table for TICKET-10), the needs-user flags are correctly scoped, and the file-ownership model is disjoint in every case except the one BLOCKING item. Fixing B1 (one-line dep addition in TICKET-9 + one sub-ordering note in TICKET-19) is required before this batch is safe to hand to devs — the dependency graph is the product of this PR and must be correct.

**Verdict: REQUEST-CHANGES — resolve B1; N1 and N2 are optional but recommended.**
