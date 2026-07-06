# cantai — Manager Log

## 2026-07-05 — Bootstrap

- W9 definition agreed with TL (session 2026-07-05-session-003, prompts 001–002 in framework repo): slug `cantai`, single Next.js app (D-013 deviation, TL-approved), Vercel free tier deploy (TL-approved).
- Repo `paulosalvatore/cantai` created (private) and template pushed — the one sanctioned direct-to-main commit.
- Branch protection skipped (GitHub Free + private repo, known 403).
- Next: needs-user round (W7 — Vercel account, YouTube API key if needed), then TICKET-1 walking skeleton.

## 2026-07-05 — Fleet fan-out (TL directive, session-003 prompt 003)

- TL directive: parallelize fronts, fully-autonomous POC, Designer on fable, Devs on opus/fable going forward.
- Running in parallel: TICKET-1 walking skeleton/prototype core (Dev, sonnet — launched pre-directive, kept to avoid waste; D-022 opus review still gates it), TICKET-3 rotation/fairness engine lib (Dev, opus, packages/rotation-engine, new-files-only), TICKET-4 design language + mockups (Designer, fable), TICKET-5 roadmap + rotation/feedback/monetization specs (PO, fable).
- Collision control: TICKET-1 owns app code + CI; TICKET-3 new package dir only; TICKET-4/5 markdown/HTML/PNG only. One worktree per ticket (.worktrees/ticket-N).
- Model policy for cantai from now on: Dev = opus (fable for judgment-heavy/creative), Designer/PO = fable, gates stay cheap (sonnet/haiku).

## 2026-07-05 — First merges + Vercel unblocked (prompt 004)

- PR #1 (TICKET-5 roadmap/specs) MERGED after Reviewer REQUEST-CHANGES→fix→APPROVE cycle (B1 graceRequeue schema, B2 nowPlaying semantics); opus-skip recorded (docs-only). Event-log add/add conflict resolved by union (haiku git-ops agent).
- PR #2 (TICKET-4 design) TL-RATIFIED ("Very good UI proposal"); TL follow-up filed as TICKET-18 (TV mode bigger type + fullscreen). Merge in flight (same event-log conflict class, same haiku agent).
- PR #3 (TICKET-3 engine) sonnet APPROVE (reviewer independently re-ran 40/40 tests); D-022 opus merge-counting pass dispatched. App Tester + Security waived N/A-by-content (zero-dep pure lib) — waiver recorded here.
- PR #4 (TICKET-1 app) delivered (25 unit + 1 e2e + build green); App Tester gate running.
- TICKET-2 UNBLOCKED: TL connected the Vercel project (vercel.com/paulosalvatores-projects/cantai) and said go — deploy verification runs after PR #4 merges (Vercel GitHub integration auto-builds main).
- Recurring friction: work/events/2026-07.jsonl add/add conflicts on every parallel PR — union resolution works; class-level fix candidate filed mentally for framework (merge=union gitattributes for *.jsonl) — to be filed via inbox.

## 2026-07-05 — PMF directive (prompt 005)

- TL: "Full horse to develop full features to release product to market fit." Recorded as the operating mode: aggressive parallel feature waves toward PMF, autonomous gate chains, TM merges (D-043).
- PO (fable) dispatched to convert backlog #6-#12 + TICKET-18 into buildable parallel tickets with file-ownership boundaries and wave grouping (branch ticket/19-pmf-wave-tickets), so the dev wave launches the moment PR #4 merges.
- Wave-1 dev fan-out (opus devs) planned immediately post-PR#4-merge; TICKET-2 (Vercel verify) runs on the merge itself.
- Standing needs-user: YouTube Data API key (blocks TICKET-8 search only).

## 2026-07-05 — PR #4 MERGED: first public deploy + wave 1 launched

- PR #4 merged after the full chain: App Tester PASS → Security PASS-WITH-NOTES (4 MEDIUMs fixed) → sonnet APPROVE (CI node-22 blocker fixed) → opus REQUEST-CHANGES (caught RED Vercel deploy: missing framework preset; fixed via vercel.json; honesty wording on per-lambda queue divergence) → opus APPROVE with a bounded CI exception (GitHub billing broken account-wide, [needs-user]; suite triple-verified on merge SHA; condition: verify first green CI on main post-billing-fix).
- Vercel preview verified GREEN pre-merge; production deploy of main auto-building; TICKET-2 verification agent dispatched (live URL + e2e + README record).
- Wave 1 launched in parallel worktrees: TICKET-6 persistence (opus), TICKET-8 search (opus), TICKET-18 TV fullscreen (fable, design-system-bound).
- API weather note: repeated agent stalls/drops this stretch; all recovered from disk state, one reviewer replaced with a fresh agent.

## 2026-07-06 — PMF FEATURE SET COMPLETE

- PR #14 (TICKET-10 rotation modes) merged — 14/14 PRs of the kickoff scope live at https://cantai-snowy.vercel.app: multi-room+QR, host controls, rotation modes (full/2-per-table/1-per-person + listen interleave + grace), search (degraded until key), feedback widget, telemetry (instrumented, CI-green), TV fullscreen, persistence (memory until Upstash), design system, roadmap/specs, rotation engine.
- Gate-chain stats for the session: every code PR ran App Tester + Security + sonnet + opus; opus caught 5 substantive pre-merge issues across the session (peek≠play starvation, red Vercel deploy, CI node mismatch, room-creation flood, relay O(N)); security FAILed one PR outright (creation flood) and forced fix rounds on 5 others. No rubber stamps.
- Filed HIGH follow-up: atomic store RMW (lost-submit window + host-op races). Other follow-ups on board.
- All worktrees cleaned (ticket-10 last); repo at main + none.
- Standing needs-user: 🔴 Upstash provisioning (durability), 🟡 HOST_TOKEN env, 🟡 YouTube key + quota increase, GitHub billing (only if repo goes private again).
