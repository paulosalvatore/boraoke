# Reviewer Report — TICKET-22 (roadmap v2, platform vision)

- **Reviewer:** Reviewer agent (sonnet pass + opus judgment layer — single-pass approved per docs-only trivial-diff rule; D-022 opus-skip recorded here)
- **PR:** #15 — `ticket/22-roadmap-v2`
- **Date:** 2026-07-07
- **Verdict:** APPROVE (with noted items)

## D-022 note

This is a docs-only PR authored by the PO (no code, no logic paths, no security surface). Per D-022, the TM may record an opus-skip for trivial diffs. This reviewer judges the diff non-trivial in *content* (it sets platform direction for 3+ months of work) but non-trivial review is achievable on sonnet for a spec/strategy corpus — the findings below reflect a full consistency and soundness check, not a mechanical scan.

## Preconditions

- CI: **green** — `build-and-test` pass (2m8s), Vercel deploy pass, Vercel Preview Comments pass. All three checks terminal-green at review time. S1 satisfied.
- App Tester gate: N/A-by-content (docs-only; no UI code shipped).
- Cyber Security gate: N/A-by-content (docs-only; no new endpoints, no secrets, no auth logic).
- PO work report: present at `work/reports/product/TICKET-22.md`, matches the delivered file list.

## What was reviewed

Full diff read locally from worktree against `origin/ticket/22-roadmap-v2` (git-local-first, S2 compliant). Files reviewed:

- `work/roadmap.md` (183 → 366 lines, full v2 rewrite)
- `work/planning/accounts-and-identity.md` (new, 98 lines)
- `work/planning/venue-generalization.md` (new, 62 lines)
- `work/planning/platform-aggregation.md` (new, 86 lines)
- `work/tickets/TICKET-22-roadmap-v2.md` (new)
- `work/reports/product/TICKET-22.md` (new)
- `work/events/2026-07.jsonl` (4-line append, event log only)

Existing merged specs cross-checked: `early-access-monetization.md` (TICKET-5), `feedback-loop.md` (TICKET-5), `rotation-modes-fair-queue.md` (TICKET-5).

## Review findings

### (1) Internal consistency — pay-to-boost vs TICKET-5 "never paywall fairness"

**Finding: coherent and explicit — no blocking contradiction.**

TICKET-5's `early-access-monetization.md` contains: "a 'pay to jump the queue' patron feature would monetize by destroying the core promise; explicitly rejected."

The v2 `platform-aggregation.md` directly names this tension, cites the TL's explicit v2 directive, and resolves it via **bounded priority** — at most 1 boosted slot per rotation round, venue-opt-in, TV-badged, kill-switch flag. The roadmap's guiding principles also state the reconciliation inline.

The design is architecturally sound: the rotation engine's round-trip fairness property is preserved because a free singer's worst case is one extra song per round, bounded regardless of payment volume. The acceptance criteria in `platform-aggregation.md` (items 2 and 3) are engine-level property tests, not UI assertions — this is the right kind of guarantee.

The supersession is explicit and coherent. **However** (see item MEDIUM-1 below): `early-access-monetization.md` itself is not annotated, so a reader of that doc in isolation still sees "explicitly rejected" with no pointer to the v2 reconciliation.

### (2) Wave 4–6 dependency graph soundness

**Finding: graph is internally acyclic and file-ownership boundaries are clean. One stale dependency.**

Edges verified:
- Upstash (TL) → 24 (partial), 26 (hard) → 28 → 31: acyclic ✓
- 27 → 28 (bot guards before signup surfaces): acyclic ✓
- TICKET-23 → 29, 30 (soft): correctly flagged soft, merge order noted ✓
- 29 + 30 → 32 (theming + i18n are the delivery vehicles for per-type presets): acyclic ✓
- 25 → 31 (telemetry completions before analytics dashboard): acyclic ✓
- 33 solo with hard gate on naming decision: correct ✓

File-ownership boundaries are explicit per ticket; the TICKET-29/30 same-wave collision warning ("merge 29 first, 30 rebases") is correctly surfaced.

**Stale status — HIGH:** The "BLOCKED ON TL" section lists Upstash Redis provisioning as 🔴 URGENT. Per Tech Manager context, Upstash was provisioned today (2026-07-07, same date as this PR). The dependency edge summary still reads "Upstash provisioning (TL) → 24 (partial), 26 (hard)" as if pending. This is factually stale — wave 4 arms on TICKET-20 + TICKET-21 merge only; TICKET-26 is no longer hard-blocked on Upstash from the TL side. The roadmap's honest-snapshot section will mislead the TL. A follow-up patch on this branch or immediately after merge should update the "BLOCKED ON TL" section.

### (3) Identity model (I-1..I-6) — coherence with live architecture

**Finding: coherent. The claim-by-host-token-proof path works with hashed host codes.**

The spec correctly describes the live baseline: client-minted `patronUuid` in localStorage, unregistered server-side ("an identifier, not an identity"). TICKET-26's server-issued uuid + httpOnly cookie + localStorage fallback is a clean upgrade with explicit continuity handling for existing patrons (alias/adopt path for legacy patronUuids).

On the host-token-proof claim path for pre-26 rooms: host codes are hashed server-side in the live architecture. The claim works because: (1) the client presents the plaintext token, (2) the server hashes it for comparison — same check the admin page already does. Knowledge of the plaintext proves ownership. No issue with the hashing.

Multi-device merge (uuid→account union, collision rule for uuid owned by another account) is specified and idempotent. The retroactive claim is a link write, not a data rewrite — O(1), reversible, correct.

I-4 (legacy pre-26 rooms claim via host-token proof, once) is the weakest link in practice: hosts who have already lost their token can't claim pre-26 rooms. The spec is honest about this: the 8-week sunset for unclaimed legacy rooms is the right cut-off. Room ownership surviving token loss (post-claim, account can re-issue) is correctly scoped to post-TICKET-28 rooms.

### (4) LGPD/privacy claims

**Finding: reasonable minimum viable posture; honest about what it is and isn't.**

Minimization, purpose limitation, legal basis (LGPD art. 7º V for accounts, legitimate interest for anonymous telemetry), self-service deletion, transparency page co-shipping with sign-in, cross-border disclosure (art. 33 for Upstash/Vercel US) — all addressed.

The "Full ToS/DPO formalization is Phase 5" framing is honest and appropriate. The key posture that the anonymous telemetry path (uuid-keyed, no PII join) is *not* changed by accounts is explicitly protected in I-5 — this is the load-bearing privacy guarantee.

### (5) TL-decision items clearly flagged

**Finding: five of six items are flagged; one missing.**

Flagged ✓:
- Bot-prevention vendor (Turnstile vs reCAPTCHA)
- Language set for i18n launch
- Venue-type shortlist
- Fairness-bounded paid-priority design (explicitly called "touches the product's soul")
- Rename timing

**Missing (MEDIUM-2):** The payment rail choice (Pix via Mercado Pago) and the upstream CNPJ/MEI / fiscal posture / MP account setup are genuine TL-decisions before wave 7 can arm. The PO report's handoff notes name this ("TICKET-34 needs a needs-user round"), but it doesn't appear in the roadmap's "Open questions" section — which is where the TL will look. Should be added.

### (6) Markdown quality

**Finding: clean. House rules followed.**

One line per paragraph throughout (no hard-wraps). Tables render correctly. Header hierarchy consistent. The roadmap's "naming note" in the header block is useful context. No dead links (all cross-references to `work/planning/` files exist in this PR). Event log append is correct format.

## Findings summary

| # | Severity | Finding | Action |
|---|---|---|---|
| H-1 | HIGH | Upstash provisioned today but roadmap still shows 🔴 BLOCKED ON TL; "BLOCKED ON TL" section and dependency edge summary are stale | Follow-up patch on this branch before or immediately after merge; TM notes when handing off to TL |
| M-1 | MEDIUM | `early-access-monetization.md` retains "explicitly rejected" for pay-to-queue with no pointer to the v2 reconciliation; a reader of that doc in isolation sees an unresolved contradiction | Add a one-line "→ superseded by platform-aggregation.md (bounded priority)" note in that spec; follow-up ticket or same-branch patch |
| M-2 | MEDIUM | Payment rail / CNPJ-MEI decision is a TL blocker for wave 7 but missing from roadmap's "Open questions" section | Add to open questions in roadmap.md; follow-up patch |
| N-1 | NIT | TICKET-22 self-referential row in the "IN FLIGHT" table will read oddly post-merge | Acceptable as-is; historical artifact of the snapshot |
| N-2 | NIT | `rotation-modes-fair-queue.md` mentions boost as "out of scope (pro-feature candidate)" without v2 pointer | Low priority; roadmap covers this |

## Verdict

**[reviewer] APPROVE** — The roadmap v2 is a well-executed PO deliverable. Internal consistency is sound; the pay-to-boost reconciliation with TICKET-5's fairness promise is explicit, architecturally coherent, and operationally reversible (kill-switch flag is an AC, not a prose promise). The dependency graph is acyclic with clean file-ownership boundaries. The identity model is coherent with the live architecture including the host-token-proof path. LGPD posture is reasonable and honest about its scope. All five key TL-decision items are flagged in the open questions section.

The HIGH finding (H-1, Upstash staleness) is noted prominently for the TM to surface to the TL; it doesn't invalidate the roadmap's correctness, only its status snapshot. The two MEDIUM items are follow-up patches.

CI is terminal-green. App Tester and Cyber Security gates are N/A-by-content (TM to record). The Tech Manager holds merge authority for this routine PO-authored, gate-cleared docs PR (D-043).
