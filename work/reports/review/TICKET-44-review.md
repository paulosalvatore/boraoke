# Review Report — TICKET-44 (venue-optional song moderation)

**Reviewer:** Reviewer agent (D-011 / D-022 opus tier)
**Date:** 2026-07-09
**PR:** https://github.com/paulosalvatore/boraoke/pull/25
**Branch:** `ticket/44-moderation` → `main`
**Worktree:** `/Users/paulosalvatore/Documents/GitHub/cantai/.worktrees/ticket-44`

---

## Verdict

**[reviewer] APPROVE**

All gates passed (App Tester PASS 9/9, Security PASS-WITH-NOTES, CI green per dev/app-tester reports). The implementation is correct, well-tested, and well-isolated. No blockers. Two findings are flagged below — one product question (re-add fairness position) and one nit (response over-echo disposition). LOW-3 TTL follow-up is the highest-priority post-merge ticket.

---

## Preconditions Verified

| Gate | Status |
|------|--------|
| App Tester PASS | PASS — 9/9 items, 470 unit tests, 42 e2e tests (work/reports/testing/TICKET-44-app-test.md) |
| Security PASS | PASS-WITH-NOTES — 4 LOW, 2 INFO, 0 BLOCKER/HIGH (work/reports/security/TICKET-44-security.md) |
| CI green | Dev + App Tester both report `npx jest` 470/33 + `npm run build` GREEN. CI substrate confirmed: `npm ci && npm run build && npm test && npm run test:e2e`. Dev explanation on why framework `verify-green-local.sh` doesn't apply to this product PR is accurate. |
| Dev report currency | Current: implementation log has 4 commits with SHAs (80e1b87, b99e96e, fc8c1bf, 781763b4); status line matches the diff. |

---

## Mergeability (PR #26 / TICKET-45 merged to main)

PR #26 (TICKET-45: advance/skip authorization) merged at 2026-07-09T04:11:49Z. Dev claimed "zero shared-file edits."

**Verification:** I ran `comm -12` on both branch file lists against the merge base.

**True conflict: exactly 1 file — `work/events/2026-07.jsonl`** (append-only event log). This is trivially resolvable by accepting both appended lines.

**Dev claim evaluation:** The claim of "zero shared files" is slightly imprecise — both branches modified `work/events/2026-07.jsonl` — but the spirit is correct: zero shared production code files conflict. PR #26 did not touch `app/api/queue/route.ts`, `lib/rooms.ts`, `lib/telemetry-types.ts`, `messages/*.json`, or any of the pending/moderation files introduced by TICKET-44.

**Action required before merge:** Dev must rebase `ticket/44-moderation` onto updated `main` and resolve the `work/events/2026-07.jsonl` conflict (accept both append blocks). All production code merges cleanly.

---

## Frozen-QueueStore Claim Verified

`git diff "$BASE"..origin/ticket/44-moderation --name-only | grep -E "lib/store|lib/rotation|lib/queue-rate"` → **empty output.** Confirmed: `lib/store.ts`, `lib/rotation.ts`, `lib/queue-rate-limit.ts`, and all `lib/store/` subdirectory files are untouched. `TvScreen.tsx` and `app/(patron)/[room]/tv/page.tsx` are also untouched.

Unapproved entries are invisible to the public queue/TV **by construction** — no filtering layer required or added. The isolation claim is structurally sound.

---

## Approve-Path Failure Modes

### Re-add on approval refusal: cap-bounce risk — NONE

When `checkSubmit` or `store.addEntry` refuses an approval, the route calls `pendingStore.add(item)` with the original `item` (including original `pendingId`). This path is correct:

- `pendingStore.add()` does NOT re-check `pendingRoomMax` / `pendingUuidMax`. The cap check lives only in the submit route.
- The entry was already counted in the pending total before `take()` removed it. Re-adding it does not increment the cap beyond what was already authorized.
- **Conclusion: no cap-bounce risk. Entry is safely re-added.**

### Re-add on approval refusal: original submission order — PRODUCT QUESTION (flag, no ruling)

In both drivers, the re-add sends the entry to the **tail** of the pending list:

- **Memory driver:** `take()` calls `Map.delete(pendingId)`, then `add()` calls `Map.set(pendingId, item)`. After `delete` + `set`, JavaScript Map places the key at the end of insertion order. Original position is lost.
- **Upstash driver:** `take()` calls `lrem(index, 0, pendingId)` + `del(item key)`, then `add()` calls `set(item key, item)` + `rpush(index, pendingId)`. `rpush` appends to the tail. Original position is lost.

**Impact:** A patron whose entry was first in the approval queue can be sent to the back when the host tries to approve during a full queue. The entry is never lost, but it loses its place in the approval order.

**Ruling:** This is a product decision — not a correctness bug at this tier. The host's approval UI shows items oldest-first, and the patron's submission order is a reasonable expectation. For early access with small queues, the impact is minimal. TM should decide whether to file a follow-up ticket. I flag it here and do not block on it.

### Concurrent approve race (two approves of the same pendingId simultaneously)

In the Upstash driver, `take()` is non-atomic (GET → status check → lrem → del across 4 commands). Two concurrent approve requests could both `GET` the same item with `status=pending`, both pass the status check, and both return the item — potentially creating a duplicate queue entry. The second `lrem` and `del` would be no-ops.

This is within the same risk class as LOW-4 (racy cap), and at this tier (one host browser per room) the probability is negligible. I note it for completeness; it does not block merge.

---

## Security LOW Disposition

### LOW-1 / LOW-2 (over-echo of response fields)

**LOW-1:** `POST /api/queue` returns `{ entry, pending: true, pendingId }` on 202. `entry` includes `patronUuid` (client-generated, not secret) and `entry.id` (server-generated UUID, not used by the patron client at this point). No cross-user disclosure.

**LOW-2:** `POST /api/host/pending/approve` returns `{ ok: true, entry: item.entry }`. The `AdminRoom.tsx` `decidePending` function does not consume the response body — it ignores the response other than `res.ok`. The echo is dead code in the current UI.

**Ruling:** These are genuinely cheap fixes (strip `entry.id` from 202 body; return `{ ok: true }` from approve). The security surface is currently benign (no cross-user disclosure, dead code in the UI). **I recommend filing as a follow-up ticket rather than blocking this PR** — the value-of-merge-now outweighs a one-field trim that doesn't change observable behavior. File after merge. If the TM wants them in this PR, they are trivially inlineable (30-minute fix), but I do not require them.

### LOW-3 (no TTL on rejected entries)

Security correctly flags this as the highest-priority follow-up. The Upstash `reject()` flips status but sets no `EXPIRE`, meaning rejected entries accumulate in the index indefinitely. Every `listRoom` call then does 1 LRANGE + N GETs for each accumulated entry, including stale rejected ones.

**Ruling:** Not a blocker at early-access volume (rooms are ephemeral, patron counts are small). But the polling cost math below makes this the most important follow-up to file before any production load.

### LOW-4 (racy cap overcount)

Documented and bounded. Upstream submit rate limit provides practical mitigation. Not a blocker.

---

## Polling Behavior and Upstash Command Cost

### Admin pending poll (`GET /api/host/pending`)

Every 3 seconds, the admin page fires two fetches: `fetchQueue` and `fetchPending`.

`fetchPending` → `pendingStore.listRoom(roomId)` → in the Upstash driver: `1 LRANGE` + `N GET` (one per entry in the index, including rejected ones). This is an **N+1 GET pattern**.

Per admin poll cycle:
- `GET /api/queue`: 1 LRANGE + 1 GET (isPaused) + 1 GET (getRoomMode) + 1 GET (getRoomModeration) = 4 commands
- `GET /api/host/pending`: 1 LRANGE + N GETs = 1+N commands
- Total per cycle: 5+N commands

At 20 polls/min (3s cadence), 0 pending entries: **100 commands/min**. At 10 pending entries: **220 commands/min** per active admin session.

### Patron pending poll (`GET /api/queue/pending`)

Same N+1 pattern: `listForUuid` calls `listRoom` first (1 LRANGE + N GETs for ALL room entries), then filters by uuid. Each patron poll pays for ALL pending entries, not just their own.

At 10 patrons + 1 admin, 0 pending: ~55 cmds/poll cycle = 18.3 polls/min = **1,100 cmds/min**. At 10 pending entries: 110 cmds/poll = **2,200 cmds/min**. At 20 pending entries (10 UUID-capped patrons × 2): 220 cmds/poll = **4,400 cmds/min**.

### Assessment

The N+1 GET pattern is a known pre-existing pattern in the queue store (feedback store has the same shape). The incremental cost per moderation entry is O(pollers × pending_count) per 3s. For early access with small rooms and ephemeral lifetimes, this is acceptable. The ideal fix is `MGET` (batch-GET all item keys in one command) in `UpstashPendingStore.listRoom()` — this would reduce N GETs to 1 command regardless of pending count. This should be filed as a follow-up together with LOW-3 TTL; the two are complementary (TTL prunes accumulation; MGET makes the scan cheaper even with accumulation).

**Upstash free tier note:** The free-forever plan is 10K cmds/day (Upstash's current pricing). Even at idle, a single active patron+admin session at 0 pending would saturate this in ~90 minutes. This is not a new problem introduced by TICKET-44 — the existing queue polling already does the same — but it means the MGET + TTL follow-up becomes important before real venue use.

---

## 202 Contract: Existing Clients and Old-Tab Scenario

**Existing tests asserting 201:** `api-queue.test.ts`, `telemetry-instrumentation.test.ts`, `queue-rate-limit.test.ts` all assert `status === 201` for queue submission. These tests run with moderation OFF (default). The default room has no moderation record → `getRoomModeration` returns `false` → the moderation branch is skipped → 201 is returned. All 201 assertions remain valid. The new `api-moderation.test.ts` is the only file asserting 202, and it does so after explicitly enabling moderation.

**Old-tab scenario (patron tab open when host toggles moderation ON):** The patron `PatronRoom.tsx` submit handler (`handleSubmit`) checks only `if (!res.ok)` — it does not check for specific status codes. `202 Accepted` satisfies `res.ok === true`, so the success path runs normally (`setSubmitSuccess(true)`, `fetchPending()` fires). The patron sees their pending state appear on the next `fetchPending` call. The 3s poll on `fetchQueue` will also fetch `moderation: true` within 3 seconds if the patron's UI needs to adapt. **No in-flight breakage for pre-toggle patrons.**

**No `201`-specific client logic found anywhere** in the changed files or `PatronRoom.tsx`.

---

## i18n Keys — Spot Check

15 new keys confirmed present across all 3 catalogs (`en.json`, `es.json`, `pt-BR.json`). The App Tester confirmed 221 keys × 3 catalogs and the i18n-completeness unit test passed. I spot-checked voice quality:

| Key | PT-BR | EN | ES |
|-----|-------|----|----|
| `Admin.moderationLabel` | "Moderação de músicas" | "Song moderation" | "Moderación de canciones" |
| `Admin.moderationHint` | "Com isso ligado, cada música entra numa fila de aprovação e só vai pro telão depois que você aprovar." | "With this on, every song lands in an approval list and only hits the TV once you approve it." | "Con esto activado, cada canción entra en una lista de aprobación y solo va a la TV después de que la apruebes." |
| `Patron.pendingWaiting` | "⏳ Aguardando aprovação do anfitrião" | "⏳ Waiting for the host to approve" | "⏳ Esperando la aprobación del anfitrión" |
| `Patron.pendingRejected` | "O anfitrião não aprovou esta música. Que tal escolher outra?" | "The host didn't approve this song. Want to pick another?" | "El anfitrión no aprobó esta canción. ¿Quieres elegir otra?" |
| `Errors.pendingFull` | "Tem muita música esperando aprovação agora — tente de novo daqui a pouco." | "Lots of songs are waiting for approval right now — try again in a bit." | "Hay muchas canciones esperando aprobación ahora — intenta de nuevo en un rato." |

Voice quality is good: warm, patron-friendly, consistent across locales. No ICU placeholder mismatches detected. `{nickname}` in `Admin.pendingApproveAria` / `Admin.pendingRejectAria` is present in all three catalogs.

---

## Telemetry Props Reuse Verified

`lib/telemetry-types.ts` diff: docstring-only changes to `host_action` and `submit_rejected` comments adding the new prop values (`approve`, `reject`, `moderation_change`, `moderation`). The `TELEMETRY_EVENTS` const array is unchanged. No new event types. Verified.

---

## Test Suite Assessment

- **Unit (470 tests / 33 suites):** Includes `pending-store.test.ts` (both-driver conformance), `room-moderation.test.ts` (getter/setter), `api-moderation.test.ts` (OFF→201, ON→202, approve→queue, reject→rejected, caps-at-approval, uuid-isolation, unauth-401), `i18n-completeness.test.ts` (195 keys × 3 locales). Coverage is complete for the moderation surface.
- **E2e (42 tests / 3 new moderation specs):** `moderation.spec.ts` covers OFF-unchanged, ON-approve, ON-reject with full UI assertions including `data-testid` fixtures. The `warmUp` pattern (pre-compile all moderation routes before room creation) correctly mitigates the documented memory-driver singleton reset caveat.
- **Flake note:** Pre-existing `host-controls` flake documented and isolated. Self-heals on retry, unrelated to moderation (exercises the `/default` queue, which has `getRoomModeration → false` → unchanged path).

---

## Code Quality Notes

- **`UpstashPendingStore.take()` non-atomic:** 4 separate Redis commands (GET, status check in JS, lrem, del). Two concurrent approves could both succeed. Assessed as LOW risk at this tier (single-host rooms). Same class as existing `UpstashFeedbackStore`.
- **`UpstashPendingStore.countRoom/countUuid`:** Both call `listRoom`/`listForUuid` in full, then `.filter().length`. This means counting costs 1+N commands — expensive if called frequently. The submit path runs `countRoom` + `countUuid` in parallel before every moderated submission. At low pending counts this is fine; at high counts (approaching `PENDING_ROOM_MAX=100`) it becomes 100+ GETs per submit. Acceptable at this tier; MGET follow-up addresses it.
- **`pendingRoomMax()`/`pendingUuidMax()` zero footgun (INFO-2):** Noted by security; `raw >= 0` allows `PENDING_ROOM_MAX=0` to silently disable moderation. Acceptable for early access where this env var is explicitly set.
- **Re-add uses `Map.set` in memory driver (preserves Map key but resets insertion order after delete):** Noted above in approve failure modes. Not a correctness bug; a product fairness question.

---

## Blocking Items

**None.**

---

## Required Pre-Merge Action

1. **Rebase `ticket/44-moderation` onto current `main`** and resolve the `work/events/2026-07.jsonl` conflict (accept both sets of appended lines). This is the only merge conflict. All production code merges cleanly.

---

## Nits (non-blocking)

1. **NIT:** `app/api/host/pending/approve/route.ts` line 99 returns `{ ok: true, entry: item.entry }`. The `AdminRoom.tsx` `decidePending` function ignores the response body. The echo is dead weight (LOW-2). File as follow-up.
2. **NIT:** `app/api/queue/route.ts` 202 body includes `entry.id` which the patron client doesn't use at this point (LOW-1). File as follow-up.
3. **NIT:** `UpstashPendingStore.listRoom()` does N sequential GETs. A `MGET` batch would collapse N commands to 1. File as follow-up alongside LOW-3 TTL.

---

## Recommended Follow-Up Tickets (file after merge, in priority order)

1. **HIGH PRIORITY:** LOW-3 — add TTL / lazy prune on rejected pending entries (Upstash EXPIRE + memory prune) to prevent orphan accumulation and N-GET cost growth on every admin poll.
2. **HIGH PRIORITY:** MGET optimization for `UpstashPendingStore.listRoom()` — collapse N GETs to 1 batch command to control Upstash command cost under load.
3. LOW-1 / LOW-2 — trim over-echo from 202 and approve response bodies.
4. LOW-4 — atomize cap enforcement (Lua script or per-room lock).
5. Product question — approve-failure re-add fairness position: decide whether a refused approval should re-insert at original position (requires positional index) or tail (current behavior). TM call.
6. INFO-1 — remove `Math.random` fallback in `generatePendingId`.
7. INFO-2 — validate `PENDING_ROOM_MAX > 0` or document the zero-disables semantic.

---

## Evidence Relied Upon

- `work/reports/testing/TICKET-44-app-test.md` — PASS, 9/9 items, 470 unit + 42 e2e
- `work/reports/security/TICKET-44-security.md` — PASS-WITH-NOTES, 4 LOW, 2 INFO
- `work/reports/dev/TICKET-44-dev-report.md` — current, 4 commits with SHAs
- `work/evidence/ticket-44/` — 13 screenshots confirming admin toggle, pending cards, i18n locales
- Local git diff: `git diff "$BASE"..origin/ticket/44-moderation` (read locally, zero API calls)
- Direct reads: `lib/pending-store.ts`, `lib/pending-types.ts`, `app/api/host/pending/approve/route.ts`, `app/api/host/pending/reject/route.ts`, `app/api/host/moderation/route.ts`, `app/api/queue/pending/route.ts`, `app/(patron)/[room]/PatronRoom.tsx` (submit handler + pending poll), `app/(patron)/[room]/admin/AdminRoom.tsx` (moderation toggle + pending section), `e2e/moderation.spec.ts`
- Mergeability analysis: `git merge --no-commit --no-ff origin/main` in worktree (aborted after detecting single conflict)

---

## Summary

TICKET-44 delivers a clean, well-isolated opt-in moderation layer. The parallel keyspace design is the correct call — it guarantees zero contamination of the rotation engine and TV by construction. The implementation mirrors established patterns (feedback-store driver, host-language endpoint, getRoomMode normalization) precisely. Gate chain is complete. The only pre-merge action is a trivial rebase to absorb the event-log conflict left by PR #26. The HIGH-PRIORITY follow-ups (LOW-3 TTL + MGET) should be filed immediately after merge to stay ahead of Upstash command cost growth.

**[reviewer] APPROVE — pending rebase to resolve the single `work/events/2026-07.jsonl` conflict from PR #26.**

---

## Opus Merge-Counting Second Pass (D-022) — Venue-Owner Lens

**Reviewer:** Reviewer agent, opus tier (D-022 second pass — this is the APPROVE that counts for merge)
**Date:** 2026-07-09

### Verdict

**[reviewer] APPROVE** — moderation-ON is honestly shippable for its target venue. One MEDIUM follow-up (toggle-OFF orphan) and one product question (re-add-to-tail) are filed as non-blocking; neither is a ticket AC. Single `work/events/2026-07.jsonl` conflict must be rebased pre-merge (confirmed jsonl-only via merge-tree; PR #26/TICKET-45 merged).

### 1. Friday-night workability ruling — SHIPPABLE

Walked a rush with moderation ON (AdminRoom.tsx read in full). The approval loop is workable on a phone for the target venue:
- **Poll cadence** 3s (POLL_INTERVAL) — fast enough that a new pending card appears within one breath; not so fast it thrashes a phone. Reuses the same cadence the host already lives with for the queue.
- **Badge** — `pendingBadge` shows the live count of `status==="pending"` next to the "Approvals" title; a host running the bar glances and sees "3" without scrolling.
- **Card actions** — single-tap ✓/✕ per card, each `disabled={busy}` so a double-tap can't double-fire; nickname + table + title on the card give enough to judge without opening anything. Ergonomically this is a two-thumb loop, correct for behind-the-bar.
- **Flood bound** — per-room 100 / per-uuid 5 pending caps (pending-types.ts) plus the upstream 10/min-per-uuid submit rate limit mean a 15-during-a-rush scenario is real but bounded; the host is never handed an unbounded wall.

**Patron-trust when approvals lag 10 min:** the pending copy ("⏳ Waiting for the host to approve" / "⏳ Aguardando aprovação do anfitrião") is honest and calm but sets **no time expectation**. That is acceptable for v1 — it does not over-promise, and a stale-but-honest "waiting" is better than a countdown the busy host can't honor. Optional future polish: a soft "this can take a few minutes on a busy night" subtitle. **Not a blocker.**

### 2. Toggle-OFF orphan ruling — CONFIRMED, MEDIUM (non-blocking follow-up)

Walked the code. When a host toggles moderation OFF with pending entries outstanding:
- `POST /api/host/moderation` only flips `RoomSettings.moderation` — it does **not** drain, approve, or reject the pending store. Existing pending entries are untouched.
- `AdminRoom.tsx:385` renders the pending section under `{moderation && ...}` — so **the approve/reject UI vanishes** the instant the toggle goes OFF. The host has no in-product way to resolve the stranded entries.
- `GET /api/queue/pending` (patron) does **NOT** gate on the moderation flag — so `PatronRoom.tsx` keeps rendering the stranded entry as "⏳ Waiting for the host to approve" **indefinitely**. The patron waits forever for an approval that can no longer happen through the UI.

So: the patron sees an honest-looking but permanently-false "waiting" state; the host can't clear it. This is a real trap. **Severity: MEDIUM.** It is NOT a ticket AC (the AC is silent on toggle-OFF semantics), it is bounded today by ephemeral rooms (memory driver → entries die with the lambda; Upstash not yet provisioned), and it is not a data-integrity or security issue — so it does **not block merge**. File a follow-up: on toggle-OFF, either (a) auto-reject outstanding pending entries (cleanest — patron gets the polite rejected card), or (b) keep the admin pending section visible whenever `pending.length > 0` regardless of the toggle, so the host can drain it. Option (a) is preferred.

### 3. Re-add-to-tail ruling — ACCEPTABLE prototype semantics (product question, non-blocking)

A refused approval (queue-full / cap 409) calls `pendingStore.add(item)` again. Because `pendingId` is time-sortable and preserved, the re-added entry keeps its **original** chronological position in `listRoom` (sorted by pendingId) — it does NOT go to the tail of the approval list. So the host-facing approval order is preserved. The only "place loss" is that the *queue* slot the patron would have had is deferred until the queue drains — and that only happens in the genuine queue-full/cap edge. "Approval order = submission order" holds except at capacity, which is the honest, expected behavior. **Acceptable as-is; file the fairness nuance as a product question if the TL wants approval to reserve a slot.** Not a blocker.

### 4. Copy-voice notes (3 locales) — WARM, non-sarcastic across the board

Read all three catalogs under a negative-emotion lens:
- **Rejected** (the hardest): en "The host didn't approve this song. Want to pick another?" / es "El anfitrión no aprobó esta canción. ¿Quieres elegir otra?" / pt-BR "O anfitrião não aprovou esta música. Que tal escolher outra?" — no blame, no scolding, redirects to a next action. Party-host voice held. 
- **Waiting**: calm, emoji-softened, no false urgency.
- **pendingFull** (patron flood): "Lots of songs are waiting… try again in a bit" — deflects to the crowd, not the patron. Good.
- **pendingApproveFailed** (host): names the likely cause (queue full) + a retry — actionable, not alarming.
No sarcasm, no passive-aggression in any locale. es reads as native, not machine-translated. **Copy passes.**

### 5. Adversarial findings

- **Moderation as a griefing tool (mass-reject):** a host-code holder mass-rejecting is **in the trust model** — the host code IS venue-owner authority (rooms.ts: HMAC'd one-time code = venue identity until #14 accounts). Anyone with the admin URL + code already has full remove/skip/reorder power over the queue; reject adds nothing new to that blast radius. The TL's "skip-hole cousin" is a host-code-sharing problem, not a moderation-specific one, and is out of scope for this ticket. No new attack surface.
- **Cross-room reject/approve:** impossible by key schema — `pendingKeys.item(roomId, id)` namespaces every op under the room, and `roomIdFromRequest` + `isValidRoomId` (ROOM_ID_RE `^[a-z0-9-]{1,64}$`) block keyspace escape. A reject/approve with a valid pendingId but wrong room simply 404s (the id isn't in that room's list). Confirmed.
- **Toggle-ON mid-night race on in-flight 201s:** NO orphan/race. A submission already committed to the queue (201, `store.addEntry` done) is a real queue entry and is unaffected by a later toggle-ON — moderation only diverts submissions that arrive AFTER the flag is read (`getRoomModeration` at the top of the POST path). There is no window where an in-flight submit is half-queued-half-pending: each POST reads the flag once and takes exactly one branch. The inverse (toggle-OFF mid-flight) likewise can't half-divert. Clean.

### Test verification (run locally this pass)

| Suite | Result |
|-------|--------|
| jest (full) | **470 passed, 33 suites** |
| jest rotation/engine | **15 passed** (the "engine" subset) |
| playwright --list | **42 tests, 13 files** |
| next build | **GREEN** (all routes compiled, incl. /api/queue/pending, /api/host/pending/*) |
| Mergeability | single conflict `work/events/2026-07.jsonl` (merge-tree "changed in both"); PR #26 MERGED — **rebase required pre-merge** |

### Follow-ups to file post-merge (non-blocking)

1. **[MEDIUM] Toggle-OFF orphan** — auto-reject (or keep admin pending UI visible while pending>0) so stranded "waiting" entries can't outlive the toggle. Highest priority of the three.
2. **[LOW] Rejected-entry TTL** (already noted by Security LOW-3 / dev report) + MGET batching for the poll.
3. **[product question] Re-add slot reservation** — whether a queue-full-refused approval should reserve the patron's place.

**[reviewer] APPROVE (opus, merge-counting) — pending the single `work/events/2026-07.jsonl` rebase. Moderation-ON is shippable for the target venue; toggle-OFF orphan and re-add fairness are non-blocking follow-ups.**
