# cantai — Manager Log

## 2026-07-11 — Heartbeat fire #2 (autonomous, unattended)

- **Advanced:** TICKET-46 (MED) — **kiosk-TV screen-token self-heal** (F1 follow-up from PR #26 opus). A long-lived venue TV outlives its ≤48h HMAC screen-token; under `ADVANCE_AUTH=enforce` the queue silently wedges (advance 401s, client swallowed it). Fix: (Layer 1 proactive) TV page passes `screenTokenMintedAt` — only a timestamp, no secret — and a client effect does a full `window.location.reload()` when token age >20h AND player idle (re-checked every 60s, never mid-song); (Layer 2 reactive) `advance()` now checks response status and on 401 does a `sessionStorage`-debounced (≥5min) reload so a bad config never hot-loops. Pure DOM-free decision helper `components/tv/self-heal.ts` + 17 unit tests. **This removes the "hard-reload every venue TV after the enforce flip" step from the runbook.**
- **Selection rationale:** highest-priority safe, non-claimed item. Skipped the CLAIMED `ticket-44` moderation worktree (PR #25 CI-WAIT) and ALL moderation-adjacent follow-ups (toggle-OFF orphans, pending-store TTL, over-echo trims) to avoid racing that code; skipped `ticket-24a` (PR #27, prior heartbeat, still open) and the stale DONE worktrees `ticket-33`/`ticket-33b`; skipped TL-blocked items (Vercel rate-limit, YouTube quota, OAuth console, EN/ES OG cards). The HIGH "atomic store RMW" follow-up was recognized as STALE (already delivered by TICKET-21/PR #16) and not picked.
- **Gate chain:** worktree `.worktrees/ticket-46` off origin/main → Dev (**479/479** unit = 462 baseline +17, build+typecheck+lint green, commit `e24d558`) → App Tester **PASS** (held fresh /tv ~169s across multiple 60s ticks → **zero spurious reloads**, the #1 risk; idle→playing→advance→idle intact; 0 new console errors; evidence committed) → Cyber folded into Reviewer (client-side token handling, no new server surface) → Reviewer opus D-022 **APPROVE**, security-clean (no secret leak, storm-safe, log-mode neutral, mid-playback safe).
- **Decision: DELIVER, not auto-merge.** boraoke.com is a live client site with Vercel auto-deploy on `main` — any merge = client-facing prod deploy, which the unattended heartbeat never triggers. PR **#28** left OPEN for the TL to merge. Behavior-neutral under the current prod default (`ADVANCE_AUTH=log`), so merging is low-risk when the TL is ready.
- **Two non-blocking Reviewer nits filed as follow-ups** (do NOT gate merge): (1) Layer 1 lacks an explicit debounce — a kiosk clock >20h *ahead* of the server could idle-reload every 60s (needs ~a day of skew that would already break TLS; idle-gated); cheap fix: clamp `tokenAgeMs >= 0`. (2) reactive `sessionStorage` marker not cleared on successful advance (benign).
- **Worktree:** `.worktrees/ticket-46` kept until PR #28 merges (then worktree-cleanup).

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

## 2026-07-08 — COMPACT CHECKPOINT (session 2026-07-05-session-003, pre-restart)

**Resume protocol for the next TM context: run tm-resume; this entry + BOARD.md are the source of truth.**

State at checkpoint:
- Product: boraoke (ex-cantai). GitHub repo paulosalvatore/boraoke (PUBLIC); LOCAL CHECKOUT STILL /Users/paulosalvatore/Documents/GitHub/cantai (folder rename pending — do it only when NO worktrees/agents active, then `vercel link` again and update framework board note).
- Live: https://boraoke.com (DNS+SSL live, 308 canonical from cantai-snowy.vercel.app). All prod env vars set (Upstash, YouTube key, Google OAuth pair, NEXTAUTH_SECRET/URL→boraoke.com, HOST_TOKEN).
- Merged: 18 PRs (#1–#18 arc: full PMF set + P0 fixes + atomic RMW + roadmap v2 + design v2).
- IN FLIGHT at checkpoint: (a) git-ops agent merging PR #19 (brand, pt-BR-waived) then PR #20 (code rebrand, fully gated incl. R1) + live verification; (b) asset agent generating EN/ES OG cards → new PR ticket/33c-og-locales. If these completed, expect: boraoke branding live, og-image-pt-BR resolving, a small 33c PR awaiting trivial merge.
- NEXT UP after rebrand lands (all specs on main): wave 4 = TICKET-24 hardening batch + TICKET-25 telemetry completions/deflake (parallel, disjoint); then TICKET-26 anon identity registry → 27 Turnstile → 28 Google-login host accounts; design build waves per work/design/design-handoff-v2.md (29 theming → 30 i18n → 31 admin v2 → 32 venue types). Roadmap: work/roadmap.md (v2). Wave rules/ownership in the roadmap + design handoff.
- TL pending: YouTube quota form (text at work/youtube-quota-form.md, opened for TL); Google OAuth console add boraoke.com origins+redirect; framework inbox has asset-gen port-override + merge=union notes.
- House specifics that bite: event-log jsonl conflicts on EVERY parallel PR (union-resolve; merge=union gitattributes still pending as TICKET-24 item); gh -R paulosalvatore/boraoke; CI won't run on CONFLICTING PRs; debug-Chrome for assets on 9222 (profile ~/chrome-debug-assets, gemini engine, gpt unusable); memory-store resets per-route-compile in next dev (warmUp before seeding in e2e).

## 2026-07-09 — COMPACT CHECKPOINT #2 (pre-restart)

TL directed compact+restart. Full state for tm-resume:

**Session outcome:** the entire live-usage wave + follow-on pair is done. Merged today: PR #23 (TICKET-30 i18n — TRILINGUAL LIVE, verified en/es/pt-BR on boraoke.com), PR #26 (TICKET-45 skip-auth — LIVE in ADVANCE_AUTH=log mode). 24 product PRs merged total.

**THE ONE OPEN THREAD — PR #25 (TICKET-44 moderation), resume here:**
- Fully approved (App Tester 9/9, Security 4×LOW dispositioned, sonnet+opus APPROVE "Friday-night shippable"). Merge was HELD at CI gate.
- CI-red was root-caused (deterministic, ticket-caused): unwarmed /api/host/pending first-compile resets the next-dev memory-store singleton mid-spec → host-controls.spec wipe. Class fix: shared warmModerationRoutes() in e2e/helpers.ts. Local on fix tip 962f94b: build green, 487/487 unit, 46/46 cold e2e.
- BLOCKED ONLY by the GitHub Actions incident (githubstatus.com component "Actions" degraded; no runs materialize on push since 04:36Z). NOT billing — repo is PUBLIC (dev's [needs-user] on PR #25 corrected by TM comment).
- RESUME PROTOCOL: (1) check githubstatus Actions component; (2) when operational, kick CI (close/reopen PR #25 or empty push to ticket/44-moderation); (3) confirm build-and-test SUCCESS on 962f94b; (4) git-ops merge round (jsonl UNION already absorbed in 1f582de — likely no new conflict; expect ~487 unit); (5) clean .worktrees/ticket-44, board TICKET-44 → DONE.

**Environmental:** Vercel hobby deploy rate limit hit (~24h from 2026-07-09 early UTC) — merges deploy late; both pending features behavior-neutral by default (moderation OFF, advance-auth log).

**Post-merge queue (board Follow-ups, priority order):** (1) MED toggle-OFF pending orphans (auto-reject on toggle-OFF); (2) MED pending-store TTL + MGET batch (poll cost ~4,400 cmds/min at 20 pending); (3) MED F1 kiosk-TV token self-heal (enforce-flip runbook requires TV reloads until fixed); (4) LOW F2 unplayable-skip rate exemption; (5) LOW over-echo trims; (6) HIGH contrast smoke assertion (older); (7) ADVANCE_AUTH enforce flip per runbook (observation window on Vercel logs → flip env → redeploy → hard-reload venue TVs).

**TL items outstanding:** aistudio.google.com login in debug-Chrome (EN/ES OG cards, TICKET-33c agent parked); Google OAuth console: add boraoke.com origins/redirects; YouTube quota form (text: work/youtube-quota-form.md).

**Prompt archive:** session 2026-07-05-session-003 curated through 022; 9de2524a staging flushed (8 real prompts verified archived, 10 task-notification hook-noise deleted, inbox note filed).

## 2026-07-11 — Heartbeat fire (autonomous, unattended)

- **Advanced:** TICKET-24a (LOW) — the two PR #14 sonnet NITs on the board: (NIT-1) corrected the stale `lib/rotation.ts` module JSDoc that still claimed the re-lay uses the frozen `reorder` op (it uses bulk `rewrite`/merge-on-write since TICKET-21); (NIT-2) guarded the discarded `store.addEntry` boolean on the `/api/host/skip` grace-requeue path — a `false` (queue full after removeEntry) was silently dropping the singer; now fires a `host_action` telemetry signal + returns `{ok:false, requeued:false, reason:"queue-full"}` at 200 (fail-open convention). Tests added in `__tests__/host-api.test.ts`.
- **Selection rationale:** skipped the CLAIMED in-flight `ticket-44` moderation worktree (PR #25 CI-WAIT) and ALL moderation-adjacent follow-ups (toggle-OFF orphans, pending-store TTL, over-echo trims, F2 unplayable) to avoid racing that code; skipped TL-blocked items (Vercel rate-limit, YouTube quota, OAuth console, EN/ES OG cards). Picked a small, safe, non-gated, clearly-idle item touching none of the claimed code. Stale worktrees `ticket-33`/`ticket-33b` (DONE tickets) left untouched — not mine.
- **Gate chain:** worktree `.worktrees/ticket-24a` off origin/main → Dev (462/462 unit, build+typecheck+lint green, commit 09ee04a) → App Tester N/A (backend-only, no UI) → Cyber folded into Reviewer (host-token-guarded branch, no new surface) → Reviewer opus D-022 **APPROVE**, security-clean, 24/24, scope-disciplined.
- **Decision: DELIVER, not auto-merge.** boraoke.com is a live client site with Vercel auto-deploy on `main` — any merge = client-facing prod deploy, which the unattended heartbeat never triggers. PR **#27** left OPEN for the TL to merge. Board "Needs user" updated with PR link + the exact merge-consequence note.
- **Worktree:** `.worktrees/ticket-24a` kept until PR #27 merges (then worktree-cleanup).
