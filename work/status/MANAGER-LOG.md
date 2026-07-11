# cantai — Manager Log

## 2026-07-11 — Heartbeat fire #8 (autonomous, unattended) — 🟡 IDLE (4th consecutive undeliverable fire)

- **Step 0 — Cold-resume:** rules reloaded from disk (CLAUDE.md §§1–4); shared framework HEAD on `main` (clean); boraoke checkout on `main`. Reviewed BOARD.md + MANAGER-LOG.md fires #1–#7 + open-PR state.
- **Step 1 — Select → nothing deliverable.** Verified directly (`git log origin/main`, `gh pr view 30`): the same **5 PRs (#30/#29/#28/#27/#25) are still OPEN**, and **no merge has landed since #26 (07-09)** — every commit on `main` since fire #5 is a heartbeat status commit. Every remaining backlog item is CLAIMED by an open PR, deploy-gated (any merge → live boraoke.com Vercel deploy, which an unattended heartbeat never triggers), or TL-blocked. The lone unclaimed dev item ("Deflake TV e2e on CI", MED) would mint a **6th** undeliverable deploy-gated PR onto a 5-deep pile awaiting the same human — adding WIP behind a blocked downstream worsens flow, not helps. Fires #5/#6/#7 already made this call; nothing changed.
- **Step 3 — Decision: IDLE, no merge, no new PR, no duplicate framework note** (the auto-backoff note was already filed in fire #7 and remains the framework-TM's to action). Per parallel-driver "when in doubt, idle" + TL cost-consciousness. Nothing here is auto-mergeable regardless.
- **Step 4 — Recorded:** additive fire-#8 entry here + BOARD.md header, committed/pushed to boraoke `main`. Durable launchd — no re-arm needed.

### Open items for you (TL) — unchanged, this is the whole bottleneck
The constraint is **human-merge + Vercel-deploy throughput, not dev throughput.** Recommendation (now made 4×): **batch-merge the 5 stacked PRs** (Vercel hobby rate-limit was ~24h from 07-09, long clear), **or pause the boraoke heartbeat** until the pile drains — hourly fires keep burning tokens on an undeliverable pile. See fire-#7 entry below for the full PR list + the filed framework auto-backoff note.

---

## 2026-07-11 — Heartbeat fire #7 (autonomous, unattended) — 🟡 IDLE (third consecutive undeliverable fire)

- **Step 0 — Cold-resume:** rules reloaded; shared framework HEAD on `main` (clean); boraoke checkout (`/Users/paulosalvatore/Documents/GitHub/cantai`) on `main`. Reviewed BOARD.md + MANAGER-LOG.md + fire #1–#6 logs + open-PR state.
- **Step 1 — Select → nothing deliverable.** Confirmed via `gh pr list`: the same **5 PRs (#30/#29/#28/#27/#25) are still open**, and **no human merge has landed** since fire #4 — the only commits since #5 are the heartbeat status commits themselves (last real merge: #26 on 07-09). Every remaining backlog item is **CLAIMED** by one of those open PRs (or would collide with it), **deploy-gated** (any merge to boraoke `main` auto-deploys to live boraoke.com — an unattended heartbeat never triggers a client-facing deploy), or **TL-blocked** (Vercel rate-limit, YouTube quota, OAuth console, EN/ES OG cards). The one genuinely-unclaimed non-trivial item — "Deflake TV e2e on CI" — is non-deterministic/expensive for a headless fire and would mint a **6th** undeliverable deploy-gated PR onto the stack (fires #5/#6 already made that call). Reconciliation was done in #5, so no fresh grooming exists.
- **Step 3 — Decision: IDLE, no merge, no new PR.** Per parallel-driver "when in doubt, idle" + TL cost-consciousness. Nothing here is auto-mergeable regardless.
- **Class-level action (not busywork):** three consecutive fires now hitting the identical human-merge wall is a systemic waste, so filed **ONE framework-intake note** (the sanctioned single-file framework write for a product-scoped tab) — `work/self-improvement/inbox/2026-07-11-heartbeat-human-merge-saturation-backoff.md` — proposing a heartbeat auto-backoff for merge-saturated products (after N idle fires with ≥1 open heartbeat PR, skip the expensive cold-resume and emit a cheap "still saturated" line, or auto-pause + resume-on-drain). This elevates the "pause the heartbeat" recommendation from per-fire product logs into the framework backlog so it actually gets built.
- **Step 4 — Recorded:** additive fire-#7 entry here + BOARD.md header, committed/pushed to boraoke `main`. Durable launchd — no re-arm needed.

### Open items for you (TL) — unchanged, this is the whole bottleneck
5 gate-green PRs are stacked awaiting **your** merge, each triggering a boraoke.com prod deploy:
- **#30** TICKET-48 — host-login throttle → Upstash cross-instance
- **#29** TICKET-47 — unplayable-skip rate exempt
- **#28** TICKET-46 — kiosk-TV token self-heal (behavior-neutral in log mode — lowest-risk merge)
- **#27** TICKET-24a — rotation nits
- **#25** TICKET-44 — moderation (CI-WAIT)

The constraint is **human-merge throughput, not dev throughput.** Recommendation (now made 3×): batch-merge the 5 when the Vercel rate-limit is clear (it was ~24h from 07-09, so almost certainly clear now), **or pause the boraoke heartbeat** until the pile drains — otherwise hourly fires keep burning tokens on an undeliverable pile (the filed framework note proposes automating exactly this). Still separately TL-blocked: YouTube quota form, Google OAuth console origins, EN/ES OG cards (debug-Chrome login).

## 2026-07-11 — Heartbeat fire #4 (autonomous, unattended)

- **Advanced:** TICKET-48 (security hardening, LOW/MED) — **host-login failure throttle → Upstash-backed cross-instance limiter** (PR #10 M-1 follow-up). The per-IP throttle in `lib/host-auth.ts` was an in-memory `Map` per process; on Vercel serverless each lambda keeps its own map, so online host-token guessing was not actually rate-limited cross-instance. Fix: new **`lib/rate-limit-counter.ts`** — a reusable fixed-window per-key counter that uses Upstash Redis (`INCR`+`EXPIRE`) when configured and falls back to the existing in-memory LRU `Map` when Upstash env is absent (dev/CI/zero-secret boot byte-unchanged). Throttle fns became async; `app/api/host/login/route.ts` awaits them. Tunables unchanged (10 failures/60s). Fail-open on Redis error (defense-in-depth; primary HMAC/timing-safe auth untouched). Built generic so room-create/search limiters can adopt it later.
- **Selection rationale:** highest-priority safe, non-claimed item. Verified collision-free via `gh pr view --json files` — NONE of the 4 open PRs (#25 moderation, #27 rotation, #28 tv-self-heal, #29 advance-rate-limit) nor the 6 open worktrees touch `lib/host-auth.ts`, `app/api/host/login/route.ts`, or the new counter module. Skipped all moderation/tv/rotation/advance-adjacent follow-ups (owned by open PRs); skipped the patronUuid-strip item (genuine patron-highlight design fork → TL's call); skipped TL-blocked items (Vercel rate-limit, YouTube quota, OAuth console, EN/ES OG cards). Board's stale HIGH "atomic store RMW" line again recognized as already-delivered (TICKET-21/PR #16).
- **Gate chain:** worktree `.worktrees/ticket-48` off origin/main → Dev opus (**467/467** unit = ~460 baseline +7, `npm run build` exit 0; commit `44112d7`) → App Tester **N/A** (backend-only, no UI) → Cyber **folded into Reviewer** (security-throttle change) → Reviewer opus D-022 **APPROVE-WITH-FOLLOWUPS**, no blockers, independently re-ran 467/467 + build exit 0, verified memory-path byte-equivalent to prior impl (report committed on branch).
- **Security disposition (Reviewer, load-bearing):** fail-open on Redis error is correct (throttle is defense-in-depth; HMAC/timing-safe `verifyHostToken` + prod-locked default untouched). INCR+EXPIRE non-atomicity fails TOWARD over-throttling one IP (bounded, self-heals on next successful login) — acceptable, Lua-EVAL variant flagged as optional. Key `rl:login:<ip>` collision-free; only the IP string reaches keys; growth TTL-bounded (Redis) / 1000-key LRU (memory). No new leak/PII/DoS.
- **Decision: DELIVER, not auto-merge.** boraoke.com is a live client site with Vercel auto-deploy on `main` — any merge = client-facing prod deploy, which the unattended heartbeat never triggers. PR **#30** opened, left OPEN for the TL to merge. https://github.com/paulosalvatore/boraoke/pull/30
- **Two non-blocking Reviewer follow-ups filed** (do NOT gate merge, on BOARD.md): FU-1 Lua-EVAL the Redis register (close the two-round-trip TTL-less-counter race); FU-2 adopt `lib/rate-limit-counter.ts` for `lib/room-create-throttle.ts` + the search limiter.
- **Worktree:** `.worktrees/ticket-48` kept until PR #30 merges (then worktree-cleanup).

## 2026-07-11 — Heartbeat fire #3 (autonomous, unattended)

- **Advanced:** TICKET-47 (LOW) — **exempt `reason=unplayable` advances from the anti-grief rate charge** (F2 follow-up from PR #26 opus). The per-room advance limiter (`lib/advance-rate-limit.ts`, 12/room/60s) charged every advance, including the TICKET-41 watchdog's `reason=unplayable` skips. A run of instantly-unplayable/unembeddable queue heads fires `advance?reason=unplayable` in rapid succession (instant `onError`, no 12s stall ladder to pace it); after 12 in a minute the 13th 429s and the TV **wedges on an unplayable video up to 60s**. Fix: split into two independent per-room sliding-window buckets — singer-skip (non-unplayable) stays **exactly 12/60s** (the anti-grief throttle, byte-unchanged), unplayable-watchdog gets a separate **40/60s** bucket. `advance/route.ts` resolves `skipReason` before the charge and selects the bucket. Additive back-compat API (`advanceRateLimitOk(roomId, {unplayable?}|now?, now?)`); +5 unit tests.
- **Selection rationale:** highest-priority safe, non-claimed item. Verified via `gh pr view --json files` that NONE of the open PRs (#28 ticket-46, #27 ticket-24a, #25 ticket-44) touch `lib/advance-rate-limit.ts` or `app/api/queue/advance/route.ts` → collision-free. Skipped the CLAIMED moderation worktree `ticket-44` (PR #25 CI-WAIT) and all moderation-adjacent follow-ups; skipped the TICKET-46 self-heal nits (part of open PR #28); skipped `ticket-24a`/`ticket-46` open PRs and stale `ticket-33`/`ticket-33b`; skipped TL-blocked items (Vercel rate-limit, YouTube quota, OAuth console, EN/ES OG cards). The board's stale HIGH "atomic store RMW" line was again recognized as already-delivered (TICKET-21/PR #16) and not picked.
- **Gate chain:** worktree `.worktrees/ticket-47` off origin/main → Dev opus (**465/465** unit = 460 baseline +5, `npm run build` exit 0; boraoke has no ESLint config/`lint` script, so build+jest is its CI-green substrate; commit `fd2e2c8`) → App Tester **N/A** (backend-only, no UI surface) → Cyber folded into Reviewer (security-throttle change) → Reviewer opus D-022 **APPROVE-WITH-FOLLOWUPS** (review committed `1a694b9`), no blockers, independently re-ran 465/465 + build exit 0.
- **Security disposition (Reviewer, load-bearing):** `reason` is forgeable and the screen token scrapeable, so a scraped-token forger alternating `reason=unplayable`/non-unplayable can force an **effective 52 advances/min/room** (12 singer + 40 unplayable) vs 12 today — a forged unplayable still skips the current singer. Judged **acceptable as-is**: bounded, per-room, requires scraping that room's public TV page, consistent with the already-TL-accepted scrapeable-token prototype threat model, strictly better than a full exemption, and worth it to fix the real 60s wedge. Allowlist holds (only exact `"unplayable"` reaches the generous bucket; junk falls back to the strict 12-bucket; no reason string reaches a Redis key/telemetry prop unsanitized; no new unbounded heap surface).
- **Decision: DELIVER, not auto-merge.** boraoke.com is a live client site with Vercel auto-deploy on `main` — any merge = client-facing prod deploy, which the unattended heartbeat never triggers. PR **#29** marked ready-for-review, left OPEN for the TL to merge.
- **Three non-blocking Reviewer follow-ups filed** (do NOT gate merge, on BOARD.md): FU-1 (security, LOW) server-side playability signal to close the 12→52/min forged-grief gap; FU-2 (test, NIT) route-level negative test for junk `reason` fallback; FU-3 (housekeeping, NIT) revisit `ADVANCE_BUCKETS_MAX` since one room can now take 2 LRU slots.
- **Worktree:** `.worktrees/ticket-47` kept until PR #29 merges (then worktree-cleanup).

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

## 2026-07-11 — Heartbeat fire #5 (autonomous, unattended) — RECONCILIATION (no new PR)

- **Advanced (bounded increment = backlog reconciliation, not a new dev PR):** corrected the board's stale, misleading `[HIGH] Atomic store RMW (PR #14 opus)` follow-up. It was listed as "first candidate for the next dev slot" through heartbeats #1–#4, but it is **already fully delivered by merged TICKET-21 / PR #16**: `rewrite`/`removeEntry`/`reorder` all route through one `MERGE_SCRIPT` Lua `EVAL` (server-side atomic read→merge→write — verified in `lib/store/upstash.ts` header + `mergeApply`), and the concurrency-regression tests exist in `__tests__/store.test.ts` ("append-during-relay never loses a submit" + "two racing relays"). Marked ✅ RESOLVED, no open action. This is status-accuracy work (board-vs-reality drift is the TL's #1 documented priority).
- **Why no new dev PR this fire (deferential / cost-conscious):** every backend-surgical follow-up on the board is either CLAIMED by an open PR (#25 moderation→queue/pending/e2e-helpers; #27 skip/rotation; #28 tv; #29 advance; #30 login/rate-limit-counter — footprints checked via `gh pr view --json files`) or STALE (the HIGH item above). The only genuinely-unclaimed non-trivial dev item left is the fragile MED "Deflake TV e2e on CI," which is non-deterministic/expensive for a headless unattended fire and would mint a **6th** undeliverable PR onto an already-stacked, Vercel-rate-limited pile. Per the heartbeat's parallel-driver + "when in doubt, idle/groom" guidance, the highest-value cheap action was the reconciliation above, not more undeliverable inventory.
- **Decision:** no merge, no new PR opened. Additive status-doc correction only, committed to `main` on the boraoke repo (product-owned status docs; not a framework write).
- **Open items for the TL (unchanged, now the bottleneck):** 5 PRs stacked and awaiting your merge, each triggering a boraoke.com prod deploy — #30 (TICKET-48 login throttle), #29 (TICKET-47 unplayable rate-exempt), #28 (TICKET-46 tv self-heal), #27 (TICKET-24a rotation nits), #25 (TICKET-44 moderation, CI-WAIT). Still blocked: Vercel hobby deploy rate-limit (~24h from 07-09), YouTube quota form, Google OAuth console origins, EN/ES OG cards (debug-Chrome login). **The real constraint now is human-merge throughput + the Vercel rate-limit, not dev throughput** — future heartbeat fires will keep hitting claimed/stale backlog until the pile drains; consider batch-merging when the rate-limit clears, or pausing the boraoke heartbeat until then.
- **Selection safety:** shared framework HEAD confirmed on `main`; boraoke checkout on `main`; touched no open PR's worktree/branch/files; edited only `work/status/BOARD.md` + `work/status/MANAGER-LOG.md` additively.

## 2026-07-11 — Heartbeat fire #6 (autonomous, unattended) — IDLE

- **heartbeat 2026-07-11 fire #6: idle** — nothing new to advance. State is unchanged since fire #5: the same 5 PRs (#30/#29/#28/#27/#25) are still open and unmerged (no human merge landed; the only commits since #5 are the heartbeat status commits themselves), so the pile has not drained. Every remaining backlog item is either **CLAIMED** by one of those open PRs (moderation follow-ups → #25; rotation → #27; tv self-heal nits → #28; unplayable/advance → #29; rate-limit-counter adoption → #30) or would **collide** with one; the only genuinely-unclaimed non-trivial item, "Deflake TV e2e on CI," is non-deterministic/expensive for a headless fire and would mint a **6th** deploy-gated, undeliverable PR onto the stack (#5 already judged this). Reconciliation was already done in #5, so no fresh grooming exists either.
- **Decision:** no merge, no new PR, no new inventory — per parallel-driver "when in doubt, idle" + TL cost-consciousness. The bottleneck remains **human-merge throughput + the Vercel rate-limit**, not dev throughput.
- **Recommendation to TL (repeat of #5, now with one more idle fire behind it):** batch-merge the 5 stacked PRs when the Vercel rate-limit clears, or **pause the boraoke heartbeat** until the pile drains — otherwise hourly fires keep landing on claimed/stale backlog and burn tokens for no deliverable increment.
- **Selection safety:** boraoke checkout on `main`; touched no open PR's worktree/branch/files; edited only `work/status/MANAGER-LOG.md` + `work/status/BOARD.md` additively.
