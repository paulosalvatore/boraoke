# TICKET-127 — Cyber Security gate (D-011), PR #98

**Verdict: PASS** (with notes: 0 BLOCKER, 0 HIGH, 1 MEDIUM, 2 LOW, 4 INFO). Nothing blocks.

Audited code at head `a00a09f` on `ticket/127-room-write-race`, verified equal to `origin/ticket/127-room-write-race` at the start, 2026-10-16. During the audit the Reviewer pushed `30fe4b7` and `8a6286b`. Those two commits add only `work/reports/review/TICKET-127-review.md` and an event-log line, so the audited code is unchanged at `8a6286b`. Before each probe run I checked `git diff --quiet -- lib app` in this worktree, and it was clean every time. Diff: `git diff origin/main...HEAD`.

## Scope

- `lib/rooms.ts`: the `rev` field, `normaliseRoomRev`, `ROOM_CAS_SCRIPT`, `mutateRoom`, `ROOM_WRITE_ATTEMPTS`, `RoomWriteConflictError`, both backends' `update`, the six mutators, and the revoke rebind.
- Blast radius: every route that writes a room record (`login`, `session` POST (logout), `revoke-sessions`, `mode`, `language`, `moderation`, plus `createRoom`); `lib/host-auth.ts` (`attachClaimCookie`, `requireHost`, the login throttle); `lib/retention.ts`; and `AdminRoom.tsx` `handleLogout`, to check how a 500 on logout is handled.
- Read: the ticket, `work/plans/TICKET-127-plan.md`, `work/reports/dev/TICKET-127-dev-report.md`, `work/evidence/TICKET-127/`, and R-1 / R-2 in `work/reports/security/TICKET-118-security.md`.

## Evidence

- **Dev suites on this head, real Redis.** I ran them in my own container, `boraoke-t127-cyber-redis` (`redis:7-alpine`, redis_version 7.4.11, 127.0.0.1:6437), and stopped it afterwards. The command was `REDIS_TEST_URL=redis://127.0.0.1:6437 npx jest --runTestsByPath` over `room-write-race`, `room-write-cas`, `room-cas-lua.integration`, `room-session-epoch-backend`, `host-session-revocation`, `claim-token-owner-pin` and `host-claim`. Result: `Test Suites: 7 passed, 7 total` / `Tests: 230 passed, 230 total`, with 0 skipped, so the real-Lua suites did run.
- **My probes.** Source is in `work/evidence/TICKET-127/security/cyber-probes.test.ts.txt`. I ran it from `__tests__/`, then removed it, so it is not part of the suite. Verbatim output is in `work/evidence/TICKET-127/security/cyber-probes-output.txt`. The probes drive the app's real `roomBackend`, swapped for `UpstashRoomBackend` on my Redis through a RESP adapter that injects per-command latency (round-trip time, RTT) to model Upstash REST.
- No e2e, no build, no server, as briefed. boraoke has no `verify-green-local.sh`, so the targeted jest above is the green evidence, the same as the #96 gates.

## Attack results

### 1. Can an interleaving still lose a security-relevant update? No.

- The dev's 45 worst-order pairs pass on memory and on real Redis.
- **C1, my own probe:** 200 rounds on real Redis with 0-3 ms jitter per hop. Each round ran, all at once: an owner revoke, a staff logout, two code logins, three different settings writes, and two logins started after the revoke. Each round then checked:
  - the old session is dead;
  - every pre-revoke staff claim is dead, the logged-out one included;
  - the owner's claim is live and still pinned;
  - post-revoke logins are live;
  - all three settings landed;
  - the pin survives a later code login (the R1f shape).
- Result: `C1 violations 0 []`.
- A first run showed 7-8 "post-revoke login claim dead" violations. The diagnostic gave `null=false, listLen=5, inList=false`: that is the `MAX_CLAIM_TOKENS = 5` cap evicting the oldest non-owner hash (TICKET-120, by design), not a lost update. With the probe kept inside the cap, the result is 0.

### 2. R-1 / R-2 / revoked claim coming back

- **R-1 (a stale write drops the owner pin): closed for ordinary interleavings.** Every writer recomputes from the latest commit, so a stale write cannot land after the rebind. Shown by the pairs `stale moderation/logout, interleaved revoke` (which fail on main per the dev's reverse check) and by C1. **Under a sustained login flood, the pin can still be lost by another route. See M-1.**
- **R-2: unchanged, and stated as unchanged.** A logout on the owner's own device still clears the pin on purpose (`revokeRoomClaimToken`, `if (next.ownerClaimTokenHash === hash) delete ...`). The fix stays with TICKET-156.
- **Revoked claim coming back: no.** A logout's removal, or a rebind's prune, can only be replaced by a write computed from it. In C1 and in every C3 trial, no pre-revoke staff claim and no pre-revoke session was ever alive afterwards. No `BUG-*` flag appeared anywhere.

### 3. Legacy and deploy

- **Missing `rev` reads as 0: not exploitable.** `rev` is written only by `UpstashRoomBackend.update` / `MemoryRoomBackend.update` from `normaliseRoomRev(room.rev) + 1`. No request body can reach the record: settings are validated enums or booleans, `createRoom` builds the record from fixed fields, and `mutateRoom` forces `id` and `rev` from its own read (`lib/rooms.ts:776`). In C2, a snapshot with `rev` deleted, `rev: 0`, `rev: "abc"` or `rev: -1` against a record at rev > 0 is refused (`conflict`). Only the matching revision commits.
- **Mixed old/new window: slightly broader than the plan says, but no worse than main.** See I-2. C2 measured that an old-code plain `SET` restores a logged-out hash (`resurrected by old SET = true`), as main does today. Because that `SET` writes back the `rev` it read, it also rolls the revision back, so a new-code writer that read at that same older revision then passes its compare (`new-code stale CAS after rollback = ok`, an ABA). The impact is bounded by the window and equal to main's blind writes. There is no permanent effect: old code spreads `rev` through, and new code always re-reads, so a room can never get stuck in conflict.
- **KEEPTTL vs retention: correct.** The script passes `KEEPTTL` exactly when `roomUpdateSetOptions()` says to (ARGV[3]), as the previous `set` did. The real-Redis suite pins both directions (TTL above 29 days kept; plain SET gives `PTTL -1`), and mutants M3/M11 are killed. Retention switched off after a room's creation still makes the record permanent on its next write. That is unchanged from main, and `bumpSessionEpoch` mirrors whatever TTL the record has.

### 4. Retry exhaustion as DoS (quantified)

**Setup:** C3 on real Redis. N attacker loops run `issueRoomClaimToken`, which is exactly what each successful `POST /api/host/login` does. A **successful** login is never throttled: `resetLoginThrottle(ip)` at `app/api/host/login/route.ts:72`. Each probe runs a victim operation while the flood is in steady state, 6 trials per victim, with hop latency "base + jitter" ms each way.

| Hop latency | Attackers | Revoke rebind exhausted | …then fallback owner mint null | Rooms left without owner pin | Settings 500 | Owner mint null |
|---|---|---|---|---|---|---|
| 1+1 | 10 | 2/6 | 0 | 0/6 | 1/6 | 3/6 |
| 1+1 | 200 | 1/6 | 0 | 0/6 | 3/6 | 3/6 |
| 5+3 | 50 | 1/6 | 1 | 1/6 | 1/6 | 0/6 |
| 5+3 | 200 | 4/6 | 3 | 3/6 | 2/6 | 1/6 |
| 5+3 | 500 | 5/6 | 4 | 4/6 | 3/6 | 5/6 |
| 15+10 | 200 | 6/6 | 6 | 6/6 | 5/6 | 4/6 |
| 15+10 | 500 | 6/6 | 5 | 5/6 | 5/6 | 6/6 |

Per caller, checked against each fail-safe claim:

- **Revoke, sessions half: true in 100% of trials.** The atomic `INCR` bump is not CAS, so a flood cannot stop it. The old session and every pre-revoke claim were dead in every trial, so **the flood cannot stop a revoke from taking effect.**
- **Revoke, "mints the owner a fresh pinned claim": false under the very contention that triggers the branch.** The fallback is `attachClaimCookie(res, roomId, { owner: true })`, another `mutateRoom` racing the same flood, and in most exhausted trials it returned null. The attacker's next post-bump login then mints onto the dead-tagged list (`bound=false`), which deletes `ownerClaimTokenHash`. The room ends with no pin. See M-1.
- **Can the owner be locked out? Not by this alone.** The revoke route always hands back a session cookie derived from the post-bump snapshot (`sessionForRoom(result.room)`), and it keeps rolling. What the owner loses is the pin, which means the revoke lever (a second revoke returns 403) and the no-typing path. A lockout also needs the owner to lose that cookie and not have the code. That is the same end state as R-1.
- **Logout throwing before telling the client: true and safe.** `revokeRoomClaimToken` throws, the route never reaches the cookie-clearing lines, and the result is a 500. `AdminRoom.handleLogout` flips to the gate only on `res.ok`, so the device stays signed in and is never told it logged out. Under a login flood, logout always reported ok, because the cap had already evicted the staff hash, so the claim is dead either way. Under a settings flood it threw in 2/6 trials. The cost is availability only: the device's claim stays live until a retry or an owner revoke.
- **Settings 500 under flood:** availability only, and nothing is half-written.
- **A stolen session (no code) cannot block a revoke.** C6 floods settings writes and re-checks `verifySessionValue` before each request, as `requireHost` does. That flood dies at the bump, and even 500 in-flight requests at 15+10 ms left the pin live in 24/24 trials (`rooms-with-live-pin=6/6` in every row). The host-code holder is the only effective adversary.
- **Amplification:** under a flood, each attacker request costs about 27-30 CAS EVALs (`CAS-evals/flood-req` up to 29.8), plus one read per attempt. That is about 55-60 store commands per login, against about 3-4 on main. Most attacker requests also exhaust themselves (livelock), and `mutateRoom` has no backoff. See L-1.

**Is a per-room write rate limit needed? Not for this merge, and not in that form.** A per-room write budget is spendable by the same code holder, and it would refuse the owner's rebind just as surely as the contention does. The effective throttle is a cap on **successful** logins (claim mints) per IP and per room, plus jittered backoff in `mutateRoom`. That bounds the commit rate an attacker can sustain, which is the only input to exhaustion. Filed as a follow-up direction under M-1 and L-1.

### 5. Lua correctness

- **The compare is exact.** The stored revision is normalised in Lua (number, or a numeric string, otherwise 0) and compared with `tonumber(ARGV[1])`, a decimal string of the TS-normalised integer. Both sides are doubles, exact for any reachable revision, which advances by 1 per write. The number-vs-string `rev` cases are parity-tested over 13 shapes by the dev, plus 8 more by me (C5). Three exotic **string** shapes disagree, see I-1. None is reachable.
- **No injection.** The script is a constant. The record JSON travels as ARGV[2] and is stored verbatim, never concatenated into the script. `cjson.decode` runs under `pcall`, and a non-object value returns -1 and writes nothing. One key, built from a validated room id.
- **EVAL arguments are bounded:** 1 KEY and 3 ARGV. The record is small and bounded: name ≤ 60 characters, at most 5 claim hashes of 64 hex, enum or boolean settings, no user-controlled free-form field.

### 6. `requireHost`: 0 writes, 1 read. Confirmed.

C4 counts, through the instrumented adapter: `requireHost cmds=1 casEvals=0; verifyClaim cmds=1; record unchanged=true`. The dev's `room-write-cas.test.ts:99` asserts the same on memory.

## Findings

### M-1 — MEDIUM — a host-code holder's login flood can still cost the room its owner pin, and the revoke's "fresh pinned owner claim" fallback does not hold under that flood

- **Where:**
  - `lib/rooms.ts:567-575`: the rebind `catch` and the fallback branch.
  - `app/api/host/revoke-sessions/route.ts`: `attachClaimCookie(res, roomId, { owner: true })`.
  - `lib/rooms.ts` `issueRoomClaimToken`: `bound=false` deletes `ownerClaimTokenHash`.
  - `app/api/host/login/route.ts:72`: successful logins are unthrottled.
- **Exploit:** someone with the host code runs about 50-500 concurrent successful-login loops on the room around (or continuously through) the owner's revoke. The rebind exhausts its 32 attempts, and the fallback owner mint usually exhausts too. A post-bump attacker login on the dead-tagged list then drops the pin.
- **Measured:** pin lost in 1/6 trials at 50 attackers and 5+3 ms hops, 3/6 at 200, and 4-6/6 at 200-500 with 15+10 ms hops.
- **What still holds:** the sessions and every pre-revoke claim are always ended, so the lever's security effect holds.
- **What is lost:** the lever for next time and the no-typing path, the same end state as R-1.
- **Why not HIGH:**
  - It needs the host code, which this lever was never able to evict.
  - It needs a sustained high-concurrency flood rather than one stale write.
  - The owner keeps a live, rolling session.
  - On main, the same pin loss takes a single well-timed stale write (R-1), so this PR is a strict improvement.
- **Forward risk:** if TICKET-156 adopts the #96 option (a) style "pin-less room: the next code login becomes owner", this flood becomes a route for a code holder to *take* ownership. TICKET-156 must not hand the pin to a plain code login on a room that lost it under contention.
- **Remediation direction (follow-up ticket, non-blocking):**
  - Cap successful logins / claim mints per IP and per room. A venue legitimately mints a handful per hour, and the cap should leave out requests that present the live owner token.
  - Add jittered backoff to `mutateRoom` retries.
  - Make the revoke's fallback owner mint not lose to the same flood. For example: retry it with backoff inside the revoke's own budget, or have a rebind that cannot commit write the owner pin through a path that does not compete with ordinary mints.

### L-1 — LOW — retry loop with no backoff: about 15x store-command amplification and livelock under contention

- **Where:** `lib/rooms.ts:770` `mutateRoom` retries immediately, up to `ROOM_WRITE_ATTEMPTS = 32` (`:743`).
- **Measured:** under a flood, each request makes about 27-30 CAS EVALs, plus reads, against about 1 on main, and most attacker requests exhaust themselves.
- **Impact:** a flood costs about 15x more Upstash commands (quota or bill) and lambda time per request, and the queue and rooms may share that store.
- **Not new as a lever:** the flooder needs the host code or a live session.
- **Remediation direction:** jittered exponential backoff between attempts, and possibly a lower bound for non-owner mints.

### L-2 — LOW — comments overstate the exhausted-rebind fallback

- **Where:**
  - `lib/rooms.ts:570`: "The route mints the caller a fresh OWNER claim token, so the pin survives this path too."
  - `lib/rooms.ts:498-501`: "…and the route mints the owner a fresh pinned claim token."
  - `app/api/host/revoke-sessions/route.ts:94`: "…or a freshly minted OWNER one when every rebind was clobbered".
- **Why it matters:** M-1 measured that, under the contention that reaches this branch, the mint usually returns null and the pin does not survive. The plan (§4) does state "or keeping the session cookie if that mint also exhausts", but the code comments do not. On this surface the standing criticism is comments outrunning code.
- **Remediation direction:** say "attempts to mint… if that also fails to commit, the device keeps only its session cookie and the room may lose its pin (M-1)".

### I-1 — INFO — Lua and TS disagree on three exotic string revisions; a room storing one would refuse every write

- **Measured (C5):** `rev="0b1"` (TS 1), `rev=" 7"` (TS 7), and `rev="0x1p4"` (TS 0) are all refused by the script with the revision TS sends. JS `Number()` accepts binary/octal literals and Unicode whitespace; Lua `tonumber` does not, and Lua takes `0x1p4` as 16.
- **Impact if it occurred:** permanent conflict for that room: no claim mints, logout 500s, settings 500s, the rebind exhausts.
- **Not reachable:** the server only ever stores `rev` as a number, and no input path writes it. Only a hand edit could plant one.
- **Direction:** treat any non-number `rev` as 0 on both sides, or accept only `number`.

### I-2 — INFO — the deploy-window residual includes an ABA on `rev`

The plan says an old-code write "carries the rev it read, so a new-code compare-and-set cannot see it". There is a further effect. That write rolls the stored revision back, so an in-flight new-code writer that read at that same older revision also passes its compare (C2). It is bounded to the drain window, and to any Vercel instant rollback to a pre-#98 deployment (which restores main's blind writes wholesale). It is no worse than main and has no permanent effect. Worth a line in the plan's residuals.

### I-3 — INFO — `rev` resets on create; for TICKET-151 (deletion), use a revision that cannot repeat

`createRoom` writes the record without `rev` with a plain `SET`, and the existence check is check-then-set (pre-existing). If a room is deleted, or expires under retention, and a same-slug room is created, a writer still holding a rev-0 snapshot of the old room would pass the new room's compare. Today it is unreachable in practice: it would need a millisecond window across a deletion or expiry, and there is no deletion path yet. When TICKET-151 lands, the fix is to create with `SET NX` and/or seed `rev` from a value that cannot repeat.

### I-4 — INFO — R-2 is unchanged by design

The owner logging out on the owner device still removes the pin, and so the lever. This PR does not claim otherwise. It stays with TICKET-156.

## Verdict

**PASS.** The compare-and-set closes the lost-update class it targets. Specifically:

- every security-relevant pair, plus 200 randomized full-concurrency rounds on real Redis, loses nothing;
- R-1 is closed for ordinary interleavings;
- a revoked claim cannot return;
- `rev` cannot be forged or omitted to pass a stale write;
- the Lua compare is exact and injection-free;
- `requireHost` is 1 read and 0 writes.

The remaining exposure is M-1, a host-code-holder flood that costs the pin but not the revoke's effect. It is strictly harder to trigger than the R-1 it replaces, and it goes to a follow-up, with L-2's comment fix ideally folded into this PR.

## Friction

- On this surface, each mechanism's fallback ("the route mints a fresh owner claim") keeps being asserted rather than probed under the same adversary that triggers it. A fallback that shares the contended resource with the attack is not a fallback. Proposal (W6): the auth-surface concurrency-probe rule should require every stated fail-safe branch to be exercised under the attack that reaches it, not in isolation.
