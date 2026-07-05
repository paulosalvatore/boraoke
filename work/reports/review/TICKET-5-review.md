# Review Report — TICKET-5

- **Reviewer:** Reviewer agent (sonnet pass; opus skip recorded — trivial docs-only PR, no code, no architecture trade-offs requiring judgment tier)
- **PR:** #1 — TICKET-5: roadmap + rotation/feedback/monetization specs
- **Branch:** `ticket/5-roadmap`
- **Date:** 2026-07-05
- **Verdict:** APPROVE (re-review — B1/B2 resolved; initial pass was REQUEST-CHANGES, see history below)

## Re-review (2026-07-05, delta `197ff57..6f197bf`)

Delta confined to `work/planning/rotation-modes-fair-queue.md` (+ event log). Verified each requested item against the updated spec:

- **B1 RESOLVED:** `graceRequeue?: boolean` added to the entry schema with explicit store-set/clear semantics (set on grace re-queue, cleared on transition to `playing` — single-use by construction). Ordering step 3 consumes it: grace entries picked first within the group's round quota (overriding `submittedAt`), and among equal-credit groups the grace-holding group sorts first. No-shows section cross-references step 3; AC6 updated to test the flag lifecycle; purity preserved (grant/clear are store transitions, not engine behavior). Internally consistent with the rest of the spec.
- **B2 RESOLVED:** `nowPlaying` specified — the entry currently in `playing` status or `null`; `order()` excludes it from the output and counts it as one consumed quota slot for its group; step 2's credit computation explicitly incorporates it. Coherent, no double-scheduling ambiguity remains.
- **N1 addressed:** step 1 partition labels now per-mode explicit.
- **N2 addressed:** one-per-person mode states table is optional and ignored for fairness.
- **N3 addressed:** AC2 reworded to "tables taking turns round-by-round in credit-ascending order".

No scope creep in the delta; markdown quality maintained. **APPROVE.**

## Initial pass (superseded): REQUEST-CHANGES (2 blocking items)

## What was checked

1. **Scope**: diff is docs-only (`work/roadmap.md`, `work/planning/*.md`, `work/tickets/TICKET-5-roadmap.md`, auto-committed event log). No app code, no CI files touched. ✓
2. **TICKET-0 vision alignment**: every product element from TICKET-0 (YouTube IFrame, uuid+nickname, table numbers, sing/listen, three rotation modes, free early access → paid later, feedback loop) is accurately reflected in the roadmap and specs. ✓
3. **Rotation spec as TICKET-3 contract**: reviewed for coherence of the ordering algorithm, mode definitions, sing/listen interleaving, edge cases, and acceptance criteria. Two blocking gaps found (see below).
4. **Feedback loop spec — D-046**: the spec explicitly delegates `feedback-intake` to the framework TM per D-046 ("that skill is framework work and goes through the framework TM per D-046, not through this product repo"). ✓
5. **Monetization spec — free-early-access promise**: "Everything free, everything on" posture is the governing directive; core features (queue, modes, feedback) declared free forever; founding-venue deal documented; no feature flags hiding future-pro functionality. ✓
6. **Markdown quality**: single-line paragraphs, tables well-formed, headers well-structured, renders cleanly. ✓
7. **CI**: no required CI checks configured on this repo yet — not blocking for a docs-only prototype-phase PR. N/A.
8. **App Tester gate**: N/A-by-content (docs-only, no app behavior changed). ✓
9. **Security gate**: N/A-by-content (no secrets, no code, no unsafe patterns in the docs). ✓

## Blocking items

### B1 — Grace re-queue has no representation in the entry schema or `order()` contract

The no-shows section specifies that a skipped-absent singer gets "one grace re-queue — their next submission... re-enters at the front of their group's next-round slot." The ordering function is a pure function `order(entries, mode, nowPlaying) → orderedList`, but the entry schema `{ id, videoId, title, uuid, nickname, tableNumber?, kind, submittedAt, status }` has no field that encodes grace priority (e.g., `graceRequeue?: boolean`). Without it, the `order()` function cannot implement AC6 deterministically — TICKET-3 would have to invent the mechanism ad-hoc, with no spec to test against.

**Required fix:** Add a `graceRequeue?: boolean` (or equivalent `priority` field) to the entry schema definition, and add a sentence in the ordering algorithm explaining how the `order()` function uses it to place the entry at the front of its group's next-round slot.

### B2 — `nowPlaying` parameter role is unspecified in the algorithm

The function signature is `order(entries, mode, nowPlaying) → orderedList`, but the 4-step algorithm never references `nowPlaying`. Its role is undefined in the spec. The TICKET-3 implementor must guess (probably "the currently-playing entry, to exclude from ordering"), but for a spec explicitly framed as "the TICKET-3 lib contract," this is an implementation ambiguity.

**Required fix:** Add one sentence in the algorithm description explaining what `nowPlaying` is and what the function does with it (e.g., "exclude from the output if not null," or "use to compute credit for entries that transition to playing mid-run").

## Non-blocking nits

- **N1:** Step 1 parenthetical `(uuid / table / uuid)` is confusing — first and third are both uuid but for different modes. Suggest: `(full-karaoke: by uuid / 2-per-table: by table / one-per-person: by uuid)`.
- **N2:** One-per-person mode: table is stated as required for 2-per-table, optional for full-karaoke, but its status in one-per-person mode is never stated. Inferable (irrelevant to fairness grouping), but adding "table is optional/ignored" explicitly would remove ambiguity for TICKET-9 (QR join + table capture).
- **N3:** AC2 says "alternating by round order" — slightly ambiguous; "tables take turns round-by-round in credit-ascending order" would be clearer.

## Evidence relied on

- Local diff: `git diff <base>..<origin/ticket/5-roadmap>` (git-local-first, zero API calls)
- TICKET-0 product definition: `work/tickets/TICKET-0-bootstrap.md` on main
- PR description: `gh pr view 1`
- All four new docs read in full

## Gate summary

| Gate | Result | Note |
|---|---|---|
| App Tester | N/A | Docs-only, no app behavior |
| Security | N/A | Docs-only, no code/secrets |
| CI | N/A | No required checks configured yet |
| Reviewer (this) | APPROVE | Re-review: B1/B2 resolved in `6f197bf`; nits addressed |
