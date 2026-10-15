# TICKET-125 — Cyber Security report

## Status
Re-gate at `638d427`: **PASS** (HIGH 1 closed; 1 new MEDIUM that is pre-existing on main, non-blocking, needs a follow-up ticket). First gate at `7be6824` was FAIL (HIGH 1).

## Context
- Repo: boraoke, PR #89, branch `ticket/125-enter-idle-search`, worktree `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t125-enter-idle-search`.
- Runtime files in scope: `app/api/search/route.ts`, `lib/live-search-gate.ts`, `lib/youtube-search.ts` (rate limiter), `lib/search-trigger.ts`, `components/SongSearch.tsx`, `messages/*.json`.
- Threat focus: drain of the platform's 100/day `search.list` budget (rate ceilings per uuid / per IP), and DoS of the free index tier.
- Method: a scratch jest probe outside the repo (`--rootDir <tree> --roots <scratch>`) drives the real `GET` handler with `fetch` mocked (counts outbound `search.list`), the karaoke index stubbed to a miss, and `reserveSearchCall` forced ok so the per-IP RATE ceiling is measured instead of the daily cap. Run unchanged against the PR head, the previous head `7be6824`, and `origin/main` (`git archive` + symlinked `node_modules`). No network, no real YouTube key, no prod.

## Log

### 2026-10-14 first gate at `7be6824`: FAIL (HIGH 1)
Full text in the PR #89 comment `## [cyber-security] D-011 gate — PR #89 (TICKET-125) — **FAIL** (1 HIGH)`; it was dispatched read-only, so this file did not exist then. Summary:
- HIGH 1: index-only lookups shared the billed limiter's 2,000-key LRU map and inserted a uuid key before checking the IP bucket, so a free-lookup flood with fresh uuids evicted the host's own billed `ip:` bucket. Probe (d): 180 billed/min on #88, 1,800 billed/min on #89 from one real IP.
- LOW 2: the 2 s cooldown does not lower the paced single-uuid ceiling (30/min, same as #88).
- LOW 3: the legacy path (no `v=2`) is a permanent marker bypass; needs a sunset ticket.
- INFO 4: parameter pollution / malformed input is harmless. INFO 5: index-tier DoS is strictly harder than on #88. INFO 6: the `anon@<ip>` cooldown key embeds the raw first XFF hop (fold into TICKET-126).

### 2026-10-15 re-gate at `638d427`
Head verified: `git rev-parse HEAD` = `origin/ticket/125-enter-idle-search` = `638d4272089a38bd19f1603dc12f3e656085a729`. Fix batch `93c3799` + `632d2c3`, then the main merge `a73ca7a`.

**Merge spot-check (Dev claim: the merge touched none of this ticket's runtime files).** Confirmed. `git diff --stat c2765b1 a73ca7a` on the route, gate, limiter, trigger, SongSearch, `lib/search-budget.ts` and `lib/karaoke-index/` is empty. Outside `work/` the merge brought only main's files: #91 (`app/api/host/login/route.ts`, `app/api/rooms/route.ts`, `lib/host-auth.ts`, `lib/rooms.ts`, claim-token test, already gated on main), #92 (`.gitignore`, harvest script note) and test/README lines. `git diff origin/main...HEAD` outside `work/` is 18 files, all TICKET-125 (route, gate, trigger, limiter, SongSearch, messages, README, package.json `measure:t125`, jest/e2e suites). No new dependency.

**HIGH 1: CLOSED.** `lib/youtube-search.ts`:
- `indexRateLimitOk` now uses its own `indexHits` map with its own LRU cap (`evictOverflow(indexHits)`); it never touches `hits`, so free traffic cannot evict a billed `u:`/`ip:` key.
- The IP bucket is checked first; on rejection it returns before any `iu:` key is inserted.
- Probe, 30 simulated seconds (3 RATE windows, ceiling 3 × `RATE_IP_MAX` = 90), verbatim:

  | Probe | `7be6824` (FAIL head) | `638d427` (PR head) | `origin/main` (#88) |
  |---|---|---|---|
  | (d) one real IP: 40 billed `live=1` + 2,100 free index lookups per second, fresh uuids | **900** | **90** | 90 |
  | (d0) control, same billed traffic, no flood | 90 | 90 | 90 |
  | (d-spoof) billed from one real IP, index flood under 2,100 distinct spoofed XFF IPs per second | **900** | **90** | n/a (main has no index-only path) |

  90 per 30 s = 180/min, #88's figure. The probe catches the bug on the old head, so it can fail. The Dev's regression test `__tests__/search-rate-isolation.test.ts` holds the same shape over one window plus two unit assertions (billed IP bucket survives 5,000 fresh-uuid lookups; 0 billed buckets added, 241 index keys).

**Rest of the fix batch: no new issue.**
- *Old tab on cooldown gets 429* (`route.ts:242-250`). Probe (f), verbatim on head: `v2 4 keystrokes in 1.2s: statuses 200,200,200,200 billed=1 reserves=1 | legacy: statuses 200,429,429,429 billed=1 reserves=1`. On `7be6824` legacy was `200,200,200,200 billed=1 reserves=1`. The cooldown check is still before `reserveSearchCall`, so a deferred or legacy-429 request spends no daily budget. The 429 body is the same localized `searchRateLimited` copy as the rate limiter; it leaks no retry timing or budget state. `isLegacyClient` is the same predicate `liveAllowed` uses, so the two cannot disagree.
- *Enter on a pasted link* (`SongSearch.tsx:585-596`): the only change is that `preventDefault` now runs after the `parseYouTubeVideoId` check, so the queue form submits a pasted link as it did before this PR. Client-only; the queue-add endpoint and its validation are unchanged. No new surface.
- *Per-mode once-guard* (`lib/search-trigger.ts`, `setScope`): client-side only; it allows at most one extra live fire per text (the other mode). The server is the control and is unchanged by it: per-uuid cooldown, billed rate limiter, daily budget.
- *Deferred costs no budget*: shown in probe (f) above (4 keystrokes → `reserves=1`), and now held by the B1 assertion in `__tests__/api-search-index-tier.test.ts`.
- Copy: plain strings rendered through `t("enterToSearch")` (`SongSearch.tsx:729`), no rich text, no `dangerouslySetInnerHTML`.
- Secrets: no key material in the diff (`git diff origin/main...HEAD | grep -E "AIza|sk-"` empty). The `*nokey*` evidence files are screenshots of the no-key degraded state.

**NEW MEDIUM 7 (pre-existing on main, not introduced by this PR, non-blocking): the BILLED limiter has the same churn hole across two IPs.** Location: `lib/youtube-search.ts` `rateLimitOk` (`:450-457`), unchanged by this PR apart from the `map` parameter.
- Why: `rateLimitOk` charges and inserts `u:<uuid>` before the IP verdict, and rejected requests still insert their fresh uuid key. A host on IP A sending ~2,000 rejected billed requests with fresh uuids keeps its own `ip:A` at the LRU tail but evicts `ip:B`, so a second address the attacker controls gets a new 30-per-10 s window each cycle.
- Evidence, probe (e), IP B bills 40/s and IP A floods 2,100 billed-path requests/s with fresh uuids: IP B billed **900** in 30 s (ceiling 90), total 990. Identical on the PR head, on `7be6824`, and on `origin/main`, so this PR neither introduced nor worsened it.
- Impact: needs two source addresses (trivial with IPv6 or wifi + cellular), and is still capped by the cross-instance daily budget. Today spoofed XFF (TICKET-119) is already unbounded, so this matters once TICKET-126 makes the per-IP limit real.
- Remediation direction: apply the same two fixes to `rateLimitOk` that the PR applied to `indexRateLimitOk`: evaluate the IP bucket first and insert no uuid key when it rejects. Optionally keep `ip:` keys in their own small map so uuid churn can never evict them. Add probe (e) as a regression test. Suggest filing it as its own ticket or folding it into TICKET-126.

**Earlier LOW/INFO items, re-checked.**
- LOW 2 (paced single uuid 30/min): unchanged (`LIVE_COOLDOWN_MS = 2000`, `RATE_WINDOW_MS = 10_000`). Disclosed in the PR body. Still LOW, no change required.
- LOW 3 (legacy marker bypass): unchanged by design. The PR body says a sunset ticket is needed; **no such ticket exists yet** in `work/tickets/` (branch or main). TM to file it.
- INFO 4, INFO 5: unchanged; the index map now has its own cap, which makes INFO 5 slightly better (index churn can no longer touch billed state at all).
- INFO 6 (raw XFF in the `anon@` key): unchanged; PR body defers it to TICKET-126. Note: no `TICKET-126` file exists in `work/tickets/` on the branch or on main; TM to confirm the ticket is filed.
- New INFO 8: with spoofed XFF an attacker can churn the index map and reset other venues' free `iip:` buckets. Free tier only, no billing impact, same TICKET-119 class.

**Tests run (targeted only, per dispatch).** `npx jest` on the 7 search suites (`search-rate-isolation`, `api-search-index-tier`, `live-search-gate`, `search-trigger`, `api-search-budget`, `api-search`, `search-pagination`): `Test Suites: 7 passed, 7 total` / `Tests: 95 passed, 95 total`. No e2e, no build, no servers (shared machine, load ~96).

**CI.** boraoke has no `scripts/verify-green-local.sh`, so there is no D-051 local-Docker verdict to cite. The record is the Dev's post-merge full run (jest 65 suites, 1,099 passed, 10 skipped; `npm run build` exit 0; e2e 132/132) plus my targeted run above. The TM should treat the CI precondition as satisfied by that record or run the full jest itself before merge.

### Verdict
**PASS.** HIGH 1 is closed and measured closed. The fix batch adds no new issue. MEDIUM 7 is pre-existing on main and does not block this PR; it needs a follow-up ticket.

## Friction
- Same class of bug twice in one limiter (insert-before-check + shared LRU map), first on the index path, now found on the billed path that has carried it since PR #8. Proposed guardrail: any LRU-capped rate limiter that keys on a client-controlled id must check the non-client-controlled bucket first and must never insert on rejection; a probe like (d)/(e) (eviction under a fresh-key flood) belongs in the house security checklist for rate limiters.
- The first gate's report was not committed (read-only dispatch); the PR comment was the only record until this file.
