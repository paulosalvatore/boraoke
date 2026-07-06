# Security Audit — TICKET-10: Rotation Modes UI

**Auditor:** Cyber Security agent (D-011)
**Date:** 2026-07-06
**PR:** #14 — paulosalvatore/cantai, branch `ticket/10-rotation-modes`
**Worktree:** `/Users/paulosalvatore/Documents/GitHub/cantai/.worktrees/ticket-10`
**Verdict:** PASS-WITH-NOTES

---

## Scope

New and modified surfaces audited from the local diff
(`git diff $(git merge-base origin/main origin/ticket/10-rotation-modes)..origin/ticket/10-rotation-modes`):

- `app/api/host/mode/route.ts` (new — mode switch endpoint)
- `app/api/host/skip/route.ts` (modified — grace param)
- `app/api/queue/route.ts` (modified — rotation caps + re-lay on submit)
- `lib/rotation.ts` (new — adapter: `orderQueue`, `checkSubmit`, `relayQueue`)
- `lib/rotation-modes.ts` (new — mode vocabulary, caps, labels)
- `lib/rooms.ts` (additive — `getRoomMode`, `setRoomMode`, `RoomBackend.update`)
- `packages/rotation-engine/src/engine.ts` + `types.ts` (modified — grace, no-show streak, cap corrections)
- `lib/host-auth.ts` (read-only — existing auth primitives; no changes in this PR)

---

## CI Status (mandatory — S1)

```
Vercel            pass
Vercel Preview    pass
build-and-test    pass  (1m47s)
```

All required checks green. App unit suite: **308/308 pass**. Engine unit suite: **59/59 pass**.

---

## Audit Checklist

### 1. POST /api/host/mode — Auth discipline and input validation

`requireHost` is called **before** the body is parsed (lines 19-22 of `route.ts`): auth rejects happen before any user-supplied data is read. Correct discipline.

`roomIdFromRequest` validates the `?room=` param via `isValidRoomId` before any store lookup; a malformed room ID returns null → 400. No arbitrary string reaches a Redis key.

**Cross-room tamper check:** The session cookie name is room-scoped (`cantai_host_<roomId>`). `requireHost(req, roomId)` looks up `hostCookieName(roomId)` and then calls `verifySessionValue(roomId, cookie)`. The session value is derived `hmac(resolveRoomToken(roomId), "cantai-host-session-v1")`. Since each room has a distinct host-code hash, a session minted for room A cannot verify against room B's token. Cross-room tampering is structurally blocked. ✓

**Mode enum validation:** The route maintains an inline `valid` array and checks `valid.includes(raw as RoomMode)` before calling `normalizeRoomMode`. Arbitrary strings cannot reach `setRoomMode` or Redis. ✓ (See INFO-1 below for a maintenance note.)

**Conclusion:** Auth-first, room-scoped, strictly enum-validated. No auth bypass found.

### 2. POST /api/host/skip — Grace param is host-only

`requireHost` gates the entire handler (lines 25-27). Patron requests receive 401 before `grace` is read.

The `grace` flag is extracted with a strict boolean equality check: `grace = (body as Record<string, unknown>)?.grace === true`. Only the literal `true` boolean sets it; truthy values (`1`, `"true"`, non-empty string) do not. JSON parse failure falls to `catch` → `grace = false` (plain skip). ✓

The grace re-queue path requires `head.mode === "sing"` (listen entries are not graced). The `head &&` guard covers an empty queue. ✓

**Conclusion:** Grace is host-only by construction; no patron path to self-grant it exists.

### 3. Re-lay write path — DoS surface analysis

**Finding MEDIUM-1 (see Findings section).**

`relayQueue` (lib/rotation.ts:196-215) is called on every successful patron submit (`app/api/queue/route.ts:162-164`). The relay:

1. Reads the full queue: 1 `getQueue` (lrange).
2. For each index `i` from 1 to N-1, calls `store.reorder(roomId, id, i)` — where each `reorder` is a full `lrange` + `del` + `rpush`-all (3 sequential Redis round-trips).

Cost per relay at queue depth N: **O(N) sequential Redis network calls**. At N=200 (QUEUE_MAX): up to 199 × 3 = 597 sequential RTTs. At Upstash typical latency (~5-20ms/RTT), that is 3–12 seconds of added latency per submit near the cap.

Is the re-lay bounded by QUEUE_MAX? Yes — `addEntry` returns false (and the relay is skipped) once the queue is at QUEUE_MAX. The relay's own `getQueue` also reads at most QUEUE_MAX entries. The bound exists; the concern is the O(N²) total cost to fill a queue from empty in full-karaoke mode (no per-patron sing cap): sum(N=1..199) of 3N RTTs ≈ 60,000 sequential Redis round-trips.

In a serverless (Vercel) deployment, relay latency is borne per-request and does not starvation-block concurrent requests. However, per-submit latency scales linearly with queue depth, and in full-karaoke mode there is no per-patron sing cap to limit how fast one patron can fill the queue.

**Does engine `order()` have pathological input?** The `roundRobin` function (engine.ts:256) is O(N × distinct_buckets) in the worst case. With N≤200 and all-unique UUIDs, this is 200×200 = 40,000 cheap JS operations (< 1ms). Crafted UUIDs or table IDs cause no algorithmic degradation at this scale. ✓

### 4. Fairness-abuse surface (product integrity)

**Finding MEDIUM-2 (see Findings section).**

Per-person-1 cap (PER_PERSON_CAP=2) and per-table-2 cap (PER_TABLE_CAP=4) are keyed off `patronUuid` and `table`, both self-reported by the patron. A patron can bypass per-person caps by generating a new UUID (clear localStorage / open incognito) and can present a fabricated table number to bypass per-table caps.

This is inherent to the no-auth UUID identity model. The engine correctly enforces caps given the identity presented; it has no mechanism to verify identity across sessions.

**Severity assessment:** This is a product-integrity limitation, not a security vulnerability. At a real bar, the host can observe suspicious queue patterns and remove entries. The design doc accepts this as a v1 tradeoff. Recommend documenting it explicitly and tracking a follow-up for per-IP submission hints as a lightweight mitigation.

### 5. No new dependencies

No changes to `package.json` or any package manifest in the PR diff. The `@cantai/rotation-engine` workspace package is existing. The `npm audit` output shows 2 moderate postcss/next vulnerabilities that are pre-existing (not introduced by this PR). ✓

The engine package exports are zero-dep and zero-IO (pure TypeScript). ✓

### 6. TICKET-1..9 protections intact

All 308 app unit tests pass on the branch. The engine's 59 tests pass. Verified protections:

- Host-auth cookie (TICKET-7/9): `requireHost` + room-scoped cookies — unchanged, working ✓
- QUEUE_MAX cap (pre-existing): still enforced before relay and before addEntry ✓
- UUID validation regex on patron submit (pre-existing): unchanged ✓
- Body size cap (MAX_BODY_BYTES=4096): unchanged ✓
- Per-room throttle on login (TICKET-9): unmodified ✓

---

## Findings

### MEDIUM-1 — Relay O(N) sequential Redis round-trips on patron submit path

**Location:** `lib/rotation.ts:196-215` (relayQueue), `app/api/queue/route.ts:162-164` (call site)

**Problem:** Every successful patron submit triggers `relayQueue`, which issues N-1 sequential `store.reorder` calls on a queue of size N. Each `reorder` is a full list `lrange` + `del` + `rpush-all` (3 Redis round-trips). At QUEUE_MAX=200, one relay is ~597 sequential Redis RTTs, adding several seconds of latency to the patron submit. In full-karaoke mode there is no per-patron sing cap, allowing one patron to flood the queue and repeatedly trigger growing relays. The relay is bounded by QUEUE_MAX (no infinite loop) and serverless isolation prevents cross-request starvation, but per-submit latency scales linearly with queue depth.

**Remediation direction:** (1) Replace the N sequential `reorder` calls with a single `store.rewrite(roomId, desired)` that writes the entire ordered list in one operation (already exposed as a private helper in the Upstash store; promoting it to the `QueueStore` interface eliminates the N loop). (2) Add a per-patron (or per-IP) rate limiter on POST /api/queue sing submissions in full-karaoke mode, consistent with the existing search rate limiter pattern (TICKET-8).

### MEDIUM-2 — Fairness caps trivially bypassed via UUID rotation or fake table numbers

**Location:** `lib/rotation-modes.ts:39-42` (cap constants), `packages/rotation-engine/src/engine.ts:128-143` (capViolation), `lib/rotation.ts:120-133` (listen cap check)

**Problem:** Per-person-1 (cap=2) and per-table-2 (cap=4) rely on self-reported `patronUuid` (from browser localStorage) and `table` (user-typed string). A patron clears localStorage or uses incognito to get a fresh UUID → full cap resets. A patron supplies a different table string each time → no table cap. This is an inherent no-auth UUID identity limitation accepted in the v1 design.

**Severity judgment:** Product integrity, not a direct security vulnerability. Real exploit path exists but requires manual effort and is visible to the host. At bar scale (single host, physical venue), the host can detect and remove spam entries.

**Remediation direction:** Document as an accepted v1 limitation in the design notes. As a follow-up, consider per-IP submit tracking (server-side) as a lightweight mitigation: map IP → pending sings, enforce a soft cap without requiring auth. This does not eliminate the bypass (NAT, VPN) but raises the cost meaningfully. Track as a separate ticket.

### INFO-1 — Standalone mode valid-array in route.ts diverges from RoomMode type on new additions

**Location:** `app/api/host/mode/route.ts:33`

**Problem:** The route maintains `const valid: RoomMode[] = ["full-karaoke", "per-table-2", "per-person-1"]` as a literal. When a new mode is added to the `RoomMode` union in `lib/rotation-modes.ts`, the route will silently reject it (returns 400) until this array is manually updated. TypeScript does not enforce completeness of the inline array against the union type.

**Remediation direction:** Derive the valid values programmatically: `const valid = MODE_META.map(m => m.mode)` (importing `MODE_META` from rotation-modes). This makes the route's acceptance set automatically track the canonical mode list.

---

## Friction (recurring pattern)

The relay-per-submit pattern (MEDIUM-1) is a systemic design gap: the adapter couples a write-heavy fairness recompute to every patron submit rather than isolating it to lower-frequency events (host-triggered mode switches, which already exist). A `QueueStore.rewrite` interface addition (one bulk list replace) would both fix MEDIUM-1 and make future relay operations cheaper by default. Recommend a skill or agent-prompt note: "after any additive store op, check whether the hot patron path incurs an O(N) Redis cost."

---

## Verdict: PASS-WITH-NOTES

No BLOCKERs or HIGHs. Two MEDIUMs (relay cost and fairness-bypass) and one INFO. The MEDIUMs do not block merge by policy but should have follow-up tickets filed before the product reaches high-volume usage. All existing security controls (host auth, input validation, QUEUE_MAX, UUID regex) are intact and correctly applied to the new surfaces.

---

# Re-audit Addendum — Dev remediation delta (commit 8f5766e, tip d3b213c)

**Date:** 2026-07-06 (same day)
**CI on tip:** build-and-test pass (run 28821013782); Vercel pass. App suite **325/325** (+17), engine **59/59**.

## Resolution verification

### MEDIUM-1a — Bulk `rewrite` store op ✓ RESOLVED

- `QueueStore.rewrite(roomId, entries)` added to the interface (`lib/store/types.ts:74-84`), implemented in both drivers.
- **Upstash implementation verified — no hidden loop** (`lib/store/upstash.ts:91-93` → `rewriteKey`, lines 111-116): one `del` + one variadic `rpush(key, ...entries)`. That is 2 Redis commands total, **constant regardless of queue depth** (vs. the previous ~3×(N-1)). The `rpush` spread is a single Redis command with N arguments, not N calls.
- `relayQueue` (`lib/rotation.ts:220-225`) now issues exactly one `store.rewrite` after the read; the N-1 `reorder` loop is gone.
- **Relay-spy test genuinely counts store ops** (`__tests__/rotation-adapter.test.ts:174-203`): `jest.spyOn(store, "rewrite")` / `spyOn(store, "reorder")` with `toHaveBeenCalledTimes(1)` and `not.toHaveBeenCalled()` respectively, plus an order assertion on the resulting queue and a no-write assertion for 0/1-entry queues. Real op-count verification, not prose.
- **Race analysis:** `rewriteKey` is `del` → `rpush`, non-atomic. A concurrent `addEntry` (`rpush`) landing between the relay's read and its `del` is lost (last-writer-wins); one landing between `del` and `rpush` survives (appears at the front, self-heals on next relay). This is the **same read-modify-write class** the pre-existing `reorder`/`removeEntry` ops already had — and strictly fewer race windows than before (1 rewrite vs. N-1 sequential reorders, each itself a del+rpush cycle). **Not worse than the accepted R-M-W class.** ✓

### MEDIUM-1b — Submit rate limiter ✓ RESOLVED

- New `lib/queue-rate-limit.ts`: dual sliding-window buckets — 10/min per `patronUuid` + 60/min per IP, LRU-capped at 2000 buckets (heap-growth guard), pt-BR 429 copy.
- **Bypass-ordering verified** (`app/api/queue/route.ts:116-125`): the limiter is checked immediately after patronUuid regex validation and **before** `getRoomMode`, `getQueue`, `checkSubmit`, `addEntry`, and `relayQueue` — an over-limit caller triggers zero store work. Malformed-uuid requests are rejected 400 *before* charging, so garbage cannot burn a legitimate patron's bucket (test-asserted: "malformed submissions (bad uuid) do not charge the rate bucket").
- **UUID-rotation dodge closed:** `submitRateLimitOk` evaluates and charges the IP bucket even when the uuid bucket already tripped (`lib/queue-rate-limit.ts:70-76`), so rotating uuids cannot avoid IP accounting (test: "IP bucket trips across rotating uuids").
- uuid is normalized (`trim().toLowerCase()`) before bucketing — case-variant uuid strings cannot split a bucket. ✓

### INFO-1 — Mode list derived from MODE_META ✓ RESOLVED

`app/api/host/mode/route.ts:32-34`: `valid` is now `MODE_META.map((m) => m.mode)`; error copy derives from the same list. Single source of truth. ✓

### MEDIUM-2 — Accepted-limitation documentation ✓ RESOLVED (as recommended)

`packages/rotation-engine/README.md` now carries an explicit "Accepted v1 limitation — identity is self-reported (PR #14 security MEDIUM-2)" section describing the uuid-rotation / fake-table bypass and naming per-IP pending-sing grouping as the planned mitigation. Matches the recommended disposition. ✓

## New observation from the delta

### LOW-1 — Rate-limit griefing via patronUuid exposure in GET /api/queue

**Location:** `app/api/queue/route.ts` (GET returns raw `QueueEntry` items incl. `patronUuid`), `lib/queue-rate-limit.ts` (per-uuid bucket)

**Problem:** GET /api/queue returns full `QueueEntry` objects including `patronUuid` (pre-existing exposure, not introduced by this PR). With the new per-uuid limiter, a hostile patron in the room can read a victim's uuid from the queue and spoof 10 well-formed submits with it, exhausting the victim's bucket (1-minute submit lockout, renewable). Impact is a minor griefing DoS of one patron, visible to the host, requiring room presence. Duplicate/cap rejections limit what the spoofer can actually enqueue.

**Remediation direction (follow-up, does not block):** strip `patronUuid` from the public GET projection (clients only need their own uuid, which they already hold locally) — also reduces the MEDIUM-2 impersonation surface generally.

## Re-audit Verdict: PASS

All four findings resolved as claimed and verified in code and tests. The remaining items (MEDIUM-2 accepted limitation, LOW-1 uuid exposure) are documented follow-ups that do not block merge. CI green on tip d3b213c; 325/325 app + 59/59 engine tests pass locally.
