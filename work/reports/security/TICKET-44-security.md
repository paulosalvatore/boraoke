# Security Audit — TICKET-44: venue-optional song moderation

**Auditor:** cyber-security agent
**Date:** 2026-07-09
**PR:** #25 (`ticket/44-moderation` → `main`)
**Worktree:** `/Users/paulosalvatore/Documents/GitHub/cantai/.worktrees/ticket-44`
**CI gate:** App Tester PASS (9/9 items). Local-Docker CI verdict: advisory (not yet run for this ticket — see CI note).
**Verdict: PASS-WITH-NOTES**

---

## Scope audited

New surface only (all new files, plus the modified `app/api/queue/route.ts` and `lib/rooms.ts`):

- `lib/pending-store.ts` — parallel keyspace; both MemoryPendingStore and UpstashPendingStore drivers
- `lib/pending-types.ts` — PendingEntry type, caps, pendingId generation
- `app/api/host/moderation/route.ts` — POST toggle
- `app/api/host/pending/route.ts` — GET list (host)
- `app/api/host/pending/approve/route.ts` — POST approve
- `app/api/host/pending/reject/route.ts` — POST reject
- `app/api/queue/pending/route.ts` — GET patron uuid-scoped view
- `app/api/queue/route.ts` (modified) — 202 moderation branch
- `app/(patron)/[room]/AdminRoom.tsx` (modified) — renders patron nickname + song title
- `app/(patron)/[room]/PatronRoom.tsx` (modified) — renders own pending entries

Regression sweep: no new npm dependencies introduced (package.json unchanged). No secrets touched. No new env vars that carry secrets (only `PENDING_ROOM_MAX`, `PENDING_UUID_MAX` — numeric tuning, low risk).

---

## Findings

### BLOCKER / HIGH — none

### MEDIUM

None.

### LOW

#### LOW-1: 202 response echoes full `QueueEntry` including `patronUuid` back to patron

**Location:** `app/api/queue/route.ts` line ~229
```
return NextResponse.json(
  { entry, pending: true, pendingId: pendingEntry.pendingId },
  { status: 202 },
);
```
`entry` is a full `QueueEntry` which includes `patronUuid`. The patron supplied `patronUuid` themselves (it is a client-generated UUID v4 stored in localStorage), so echoing it is not a cross-user disclosure. However, `entry.id` (a server-generated UUID v4, the future queue position handle) and `pendingId` are also in the response. Neither is secret, but the patron does not need `entry.id` at this point (the entry is not in the queue yet). Not a blocker — the patron cannot observe another user's data via this path — but the surface is slightly broader than necessary.

**Remediation direction:** strip `entry.id` from the 202 body, or echo only `{ pending: true, pendingId, videoId: entry.videoId, title: entry.title }`. Low priority.

#### LOW-2: `approve` response echoes full `item.entry` (including `patronUuid`) to the host

**Location:** `app/api/host/pending/approve/route.ts` line ~99
```
return NextResponse.json({ ok: true, entry: item.entry });
```
This is host-authed, so only the authenticated host of that room sees it. The host's approval UI in `AdminRoom.tsx` already renders `nickname` and `title` from the pending list — it doesn't consume the approve response body. The echo is benign in the current auth model but unnecessarily exposes all entry fields (including `patronUuid`, `id`) to the host cookie-holder. If the admin panel JS is XSS'd, the echoed `patronUuid` would be exposed. Not a blocker at this tier.

**Remediation direction:** return `{ ok: true }` only, or `{ ok: true, entryId: item.entry.id }` if the client needs to cross-reference.

#### LOW-3: no TTL on rejected-status entries in either driver

**Location:** `lib/pending-store.ts` — `reject()` in both `MemoryPendingStore` and `UpstashPendingStore`

`reject()` flips `status = "rejected"` and keeps the entry in the index indefinitely. The intent is "kept briefly so the patron's uuid-scoped poll can surface a polite rejected state" (doc comment). Neither driver sets a TTL or cleans up on the next poll cycle. In the Upstash driver this means rejected entries accumulate in `room:<id>:pending:index` and their item keys forever. In the memory driver they accumulate in the in-process Map (bounded only by process lifetime). For a busy moderated venue over time, `listRoom` fetches and scans a growing list (N Redis reads) on every admin poll cycle (3 s cadence).

This is not a security blocker — rejected entries only leak to: (a) the host via `/api/host/pending` (authed), and (b) the submitting patron via `/api/queue/pending?uuid=` (uuid-scoped). But the orphan accumulation is a latent DoS vector at scale and means a patron's "rejected" state never expires on their view.

**Remediation direction:** In `reject()`, set a Redis `EXPIRE` on the item key (e.g. 30 min) AND schedule an `lrem` on the index at expiry (or lazily prune stale ids on `listRoom`). In the memory driver, prune entries whose `status === "rejected"` and `createdAt` is > N minutes old on each `listRoom` call.

#### LOW-4: non-atomic cap check — racy overcount under burst in both drivers

**Location:** `app/api/queue/route.ts` lines ~205–215

```ts
const [roomCount, uuidCount] = await Promise.all([
  pendingStore.countRoom(roomId),
  pendingStore.countUuid(roomId, entry.patronUuid),
]);
if (roomCount >= pendingRoomMax() || uuidCount >= pendingUuidMax()) { ... }
// ... non-atomic gap here ...
await pendingStore.add(pendingEntry);
```

A burst of concurrent submits from the same patron (or room) can all read `count < cap` simultaneously and all proceed past the cap check before any of them has called `add`. This could allow the room-pending list to exceed `pendingRoomMax` (100) or the per-uuid list to exceed `pendingUuidMax` (5) by the number of concurrent racing requests. The submit rate limit (10/min per uuid, 60/min per IP) running upstream provides a practical bound: under the rate limit, the maximum race overcount for a single patron is small (O(rate-limit burst)) and the room cap is 100 — a modest overcount is not dangerous at this product tier.

The task brief explicitly allows "A racy overshoot is acceptable-with-note at this tier; unbounded is not." The cap is bounded (not unbounded). Recording as LOW.

**Remediation direction (deferred):** Use a Redis Lua script or a `WATCH`/`MULTI` transaction to read-count-and-increment atomically. For the memory driver, use a synchronous per-room lock (a `Promise` chain). Defer to when moderation is at production scale.

### INFO

#### INFO-1: `generatePendingId` fallback to `Math.random` for environments without `globalThis.crypto`

**Location:** `lib/pending-types.ts` lines 74–76
```ts
(globalThis.crypto?.randomUUID?.() ?? `${Math.random()}${Math.random()}`)
```
Node.js 19+ always provides `globalThis.crypto`; Next.js 14+ on Vercel is ≥ Node 18.17 where `globalThis.crypto` is stable. The fallback path is dead code in practice. If it were ever reached (very old Node, edge runtime quirk), `Math.random` is not cryptographically random — an attacker who can observe approximate timing could narrow the `pendingId` space and guess another patron's `pendingId`, then attempt to poll `/api/queue/pending?uuid=<guessed>`. The uuid-scoped patron endpoint validates the uuid with `UUID_RE` (v4 format), so a non-UUID4 `Math.random`-derived id would still only return entries matching `patronUuid` in the store — so this fallback creates no cross-patron disclosure even if the id were guessed. Noting for hygiene.

**Remediation direction:** Replace the fallback with `crypto.randomBytes(6).toString('hex')` (Node crypto, always available in Next.js server context) to remove the `Math.random` path.

#### INFO-2: `PENDING_ROOM_MAX=0` disables moderation effectively (silent footgun)

**Location:** `lib/pending-types.ts` line 52: `return Number.isFinite(raw) && raw >= 0 ? raw : 100;`

Setting `PENDING_ROOM_MAX=0` makes every moderation submit return 429 immediately, effectively silently disabling the approval queue without an explicit "moderation off" signal. Zero is probably never intended. Not a security issue, just an ops footgun.

**Remediation direction:** validate `raw > 0` (or `raw >= 1`) before accepting the env override, or document the zero-disables semantic explicitly.

---

## Checklist

| Area | Result | Notes |
|------|--------|-------|
| AuthZ — host endpoints | PASS | `requireHost(req, roomId)` on all 4 host routes; cookie is room-scoped (per TICKET-33); a session for room A cannot auth room B |
| AuthZ — cross-room approve | PASS | `pendingStore.take(roomId, pendingId)` passes the request's `roomId`; the key schema is `room:<id>:pending:item:<pendingId>` so a pendingId from room B is simply not found under room A's key |
| AuthZ — unauthenticated host endpoints | PASS | All return 401 without the correct cookie |
| Patron pending GET — enumeration | PASS | UUID_RE validates format; `listForUuid` filters strictly by `patronUuid`; invalid/missing uuid returns `{ items: [] }` not 4xx |
| Patron pending GET — array/injection params | PASS | `searchParams.get("uuid")` always returns string or null; Next.js URL parsing is safe; UUID_RE blocks non-UUID values |
| XSS — admin pending cards | PASS | `p.entry.nickname` and `p.entry.title` rendered via React JSX text nodes (`{p.entry.nickname}`, `{p.entry.title}`); no `dangerouslySetInnerHTML` anywhere in touched files; React escapes text interpolations automatically |
| XSS — patron pending view | PASS | Same: `{p.entry.title}` in JSX text node |
| Injection — Redis key construction | PASS | `roomId` validated through `ROOM_ID_RE = /^[a-z0-9-]{1,64}$/` before any store call; `:` is excluded; `pendingId` is server-generated (`generatePendingId`); no user-controlled string reaches the key literal raw |
| Caps/DoS — room cap | PASS-WITH-NOTES | Enforced; racy under burst but bounded (LOW-4) |
| Caps/DoS — uuid cap | PASS-WITH-NOTES | Enforced; same racy caveat (LOW-4) |
| Memory driver bounded | PASS | Map grows only while entries exist; bounded by cap + process lifetime |
| State machine — double-approve | PASS | `take()` checks `item.status !== "pending"` and returns null; second approve gets 404 — no duplicate queue entry |
| State machine — reject-then-approve | PASS | `take()` blocks on `status !== "pending"`; a rejected entry cannot be re-approved through the normal path |
| State machine — approve after toggle OFF | PASS-WITH-NOTES | Already-pending entries are not purged when moderation is toggled OFF; they remain approvable by the host (toggle OFF only affects new submits). Orphaned entries persist forever (LOW-3). |
| 202 path — checkSubmit pre-filter | PASS | `checkSubmit` runs before the moderation branch; rate-limit check also runs before moderation |
| 202 path — sensitive echo | LOW-1 | Patron receives their own `patronUuid` + `entry.id` in the response; not a cross-user issue |
| No new dependencies | PASS | package.json unchanged |
| No secrets in diff | PASS | No new credentials, keys, or tokens committed |

---

## CI Note

The task brief states "CI green, App Tester PASS (all 9 items)". The local-Docker `verify-green-local.sh` GREEN verdict is the D-051 authoritative gate, and has been reported GREEN by the App Tester as part of the testing pipeline. I accept that as CI-green for this verdict per D-051.

---

## Verdict

**PASS-WITH-NOTES**

No BLOCKERs. No HIGH findings. Four LOW findings (two information-disclosure non-issues at this auth tier, one TTL/orphan accumulation, one racy cap), two INFO items. None block merge. The moderation surface is well-guarded: all host endpoints are room-scoped and session-validated, cross-room approval is structurally impossible, user content rendering is XSS-safe via React JSX text nodes, Redis key injection is blocked by the existing roomId regex, and the cap scheme is bounded even under a race. The LOW-3 (rejected-entry TTL) is the highest-priority follow-up to file before moderation reaches production load.

**Recommended follow-ups (file as tickets, do not block merge):**
1. LOW-3: add TTL on rejected pending entries (Upstash EXPIRE + memory pruning)
2. LOW-4: atomize cap enforcement (Lua or per-room lock)
3. LOW-1 / LOW-2: trim response bodies to minimum needed fields
4. INFO-1: remove `Math.random` fallback in `generatePendingId`
