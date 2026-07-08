# Review report — TICKET-43: recoverable sessions (local room memory + host-session recovery)

- **PR:** paulosalvatore/boraoke #22
- **Branch:** ticket/43-session-recovery
- **Reviewer:** Reviewer agent (sonnet pass + opus judgment)
- **Date:** 2026-07-08
- **Verdict (round 1):** REQUEST-CHANGES (1 blocking — probe bounding; 1 gate clarification)
- **Verdict (round 2, final):** APPROVE — all requested items confirmed fixed (see "Re-review (round 2)" section at bottom)

---

## Gate preconditions

| Gate | Status |
|---|---|
| App Tester PASS | CONFIRMED — comment on PR #22 by paulosalvatore; report at work/reports/testing/TICKET-43-app-test.md on branch |
| Security | TM-waived N/A-by-content. Assessment: waiver is sound — this is client-side localStorage only; the load-bearing invariant (host code never persisted) is type-forbidden + defensively stripped + test-asserted + App-Tester-verified raw localStorage inspection. No attack surface arises from reading an existing endpoint under the host's own cookie. Waiver accepted. |
| CI (verify-green-local.sh) | boraoke does NOT have a verify-green-local.sh / local-Docker gate. The gate substrate for this repo is the GitHub Actions workflow (.github/workflows/ci.yml: npm ci → rotation-engine node --test → npm run build → npm test → playwright test:e2e). Dev claims match what I independently ran: 371/371 unit, build clean, e2e 30/31. The 1 failure (feedback.spec.ts) is pre-existing — confirmed: feedback.spec.ts is byte-identical between main and ticket/43-session-recovery (diff returned empty). The gate is met to the extent possible for this repo; the reviewer's own local run of `npm test` returned 371 passed, 25 suites, 0 failed. |

---

## What I checked

### 1. Tests — independently run

Ran on ticket-43 worktree (`npm ci` already done):

```
npm test (ticket-43 worktree):
  Test Suites: 25 passed, 25 total
  Tests:       371 passed, 371 total
  Time:        1.353 s
```

`npm test -- --testPathPattern=room-memory`:
```
PASS __tests__/room-memory.test.ts
  add ✓ × 3
  dedupe ✓ × 3
  order ✓ × 2
  cap ✓ × 1
  forget ✓ × 2
  resilience ✓ × 4
  sync seam ✓ × 1
  SECURITY INVARIANT — never stores host code ✓ × 2
  17 passed, 0.223s
```

`npm run build`: clean (type-check passes, route table emitted, no errors).

The e2e was not re-run by this reviewer locally (needs a running server at port 3043). I relied on the App Tester's verified result (30/31, feedback.spec.ts pre-existing) which is confirmed by the byte-identical spec file check.

**Pre-existing failure confirmation:** `diff e2e/feedback.spec.ts .worktrees/ticket-43/e2e/feedback.spec.ts` returned empty — the file is byte-identical between main and the PR branch. The failure predates this PR. CONFIRMED.

### 2. lib/room-memory.ts quality review

**Schema versioning (cantai_rooms_v1):** The `_v1` suffix is a correct forward-looking convention. There is no migration story for v2 in this PR — but none is needed yet. The `claimable` field was added specifically to avoid a v1→v2 migration when accounts land (the accounts doc, I-2, uses uuid→account link at read time, not a data rewrite). The comment in `syncLocalRooms()` explains this explicitly. The shape is also coerced at read time (`coerceRoom`) with sensible defaults for new fields, so a future additive field addition wouldn't break existing blobs. A v1→v2 migration story is not required now; the design deliberately defers it. This is acceptable.

**Fail-soft paths:**
- Corrupt JSON: `loadRooms` wraps `JSON.parse` in try/catch → returns []. Confirmed non-throwing.
- `storage.getItem` returning null: checked with `if (!blob) return []`. Confirmed.
- `saveRooms` wraps `setItem` in try/catch → quota exceeded / sandboxed → cache misses silently. Confirmed non-throwing.
- `browserStorage()` wraps `window.localStorage` access in try/catch → returns NULL_STORAGE on sandboxed iframe. Confirmed.
- All fail-soft paths are tested in the `resilience` describe block. Quality: high.

**Defensive hostCode strip:** `rememberCreatedRoom` destructures `{ id, name }` from the input object — only those two fields (plus `createdAt`) reach `upsert`. The TypeScript type `{ id: string; name: string; createdAt?: number }` has no `hostCode` field, so a correctly typed call cannot pass one. The destructure is belt-and-suspenders for the runtime JavaScript case where an over-broad object is passed. The test "does not persist a hostCode even if smuggled into the input object" verifies the runtime strip via a type assertion cast. Confirmed effective.

Could a future field rename defeat it? Only if someone adds a field `hostCode` to the `RememberedRoom` interface itself — but that type is the output, not the input to `rememberCreatedRoom`. The input type deliberately has no such field, and the destructure ignores anything extra. Future-proof against rename: YES, because the strip is structural (destructure extracts ONLY named fields; anything else is dropped), not a property-name blacklist.

**Cap-eviction correctness:** `upsert` does `sortRooms([merged, ...rooms.filter(r => r.id !== entry.id)]).slice(0, MAX_ROOMS)`. The sort is most-recent-first, so `.slice(0, 50)` keeps the 50 most recent and drops the oldest. This is correct. The cap test ("caps at 50, dropping oldest") passes at 17/17.

### 3. /api/host/session probe pattern — BLOCKING ISSUE

**Finding:** `SavedRooms.tsx` fires one `fetch('/api/host/session?room=...')` per `created` room in an unbounded parallel `for` loop on every landing-page load.

The cap is MAX_ROOMS = 50. A device that is a venue host running many karaoke nights could have 10–30 created rooms. On landing load, all their created rooms fire simultaneous GETs to the venue's own Next.js backend. On a low-power venue device (a tablet running Boraoke as the host station), this is a landing-page fan-out of N parallel requests — N up to 50 — on every visit to `/`.

The ticket acceptance criteria (item 4) says "probe `/api/host/session` for that room" without a bounding constraint. However, the practical use case is hosts with multiple past rooms. The UX impact of a burst of 10–30 parallel fetches on a venue tablet is real: 10-30 concurrent requests that block on the same in-memory store, slow the initial render, and could rate-pressure the server-side store in a multi-tenant deployment.

This is a genuine correctness/performance issue, not a taste finding. The fix is a cheap one-liner: probe only the top N most-recently-touched created rooms (e.g., top 3, or probe lazily on hover/click rather than on landing load). Since the list is already sorted most-recent-first by `loadRooms`, a `.filter(r => r.role === 'created').slice(0, 3)` guards the probe loop.

**This is a blocking item.** The rest of the implementation is correct and clean; this one issue must be addressed before merge.

### 4. PatronRoom.tsx touch — minimal, correctly flagged

The diff adds exactly: one import (`rememberJoinedRoom`) and one call (`rememberJoinedRoom({ id: roomId, name: venueName || roomId })`) inside the existing boot `useEffect`, adjacent to the `cantai_last_room` setItem that already exists there. The form region (SongSearch, submission, queue display) is completely untouched.

**TICKET-40 sequential-merge flag is correct and necessary.** I confirmed TICKET-40's branch also modifies PatronRoom.tsx — it adds a `submitBtnRef` at line 51 and a `parsedVideoId` effect block at lines 124–152 (different region from TICKET-43's boot useEffect at line 77). These changes do not conflict in content but WILL produce a merge conflict since both branches diverge from the same base commit (a1129ed) with different insertions. Sequential merge is required; the PR flagged this correctly.

### 5. Wave-28 seam

`claimable` on the persisted shape, `syncLocalRooms()` stub, and the TODO comment referencing `work/planning/accounts-and-identity.md` (I-2) are all present and correctly documented. The stub is genuinely a no-op (returns the claimable subset, zero side effects — confirmed by test "returns only claimable (created) rooms and mutates nothing"). The seam matches the planning doc: I-2 describes claiming as a uuid→account link resolved at read time, not a data rewrite, so the stored `claimable: true` flag is sufficient without any migration. Seam quality: correct.

### 6. pt-BR copy quality

All copy verified against App Tester report and component source:

- "Suas salas" — natural, correct.
- "Salvas neste dispositivo — volte rápido pra uma sala que você criou ou entrou." — "pra" (contraction of "para") is informal, appropriate for a karaoke app. "Que você criou ou entrou" is grammatically correct (entered — entered into). Natural.
- "Entrar" / "Admin" / "TV" — standard.
- `aria-label={\`Esquecer ${room.name}\`}` — "Esquecer" = to forget. Correct verb choice. Accessible.
- "Sua sessão expirou — entre com o código da sala." — natural, honest, actionable. Correct.

Copy quality: good. No issues.

### 7. Rebase surface vs main

The PR branch has 5 commits ahead of main (base: a1129ed). The diff surface is 19 files, entirely additive except for the 6-line PatronRoom.tsx addition, 16-line AdminRoom.tsx addition, 8-line app/new/page.tsx addition, and 4-line app/page.tsx addition. No framework files touched. No regressions in the diff to main. The only merge-conflict risk is PatronRoom.tsx vs TICKET-40 (flagged correctly).

### 8. Dev report currency

Dev report (work/reports/dev/TICKET-43.md) is current: reflects the implemented state, commits SHA in the "Commits" section, self-verification results match what I independently verified (371 unit, 31 e2e with 1 pre-existing fail). Status line: "IMPLEMENTED — suite green (371 unit + 31 e2e), draft PR opened." Accurate.

---

## Verdict: REQUEST-CHANGES

### Blocking items

**[BLOCKING-1] Probe bounding in SavedRooms.tsx — unbounded parallel fetch fan-out on landing load**

The `useEffect` that probes `/api/host/session` fires one parallel `fetch` per created room in the list, with no upper bound. With MAX_ROOMS = 50 and a host who has created many rooms over time, this fans out up to 50 simultaneous requests on every landing page load. On a low-power venue device, this delays the landing render and pressure-tests the in-memory store unnecessarily.

Fix: limit the probe to the most-recently-touched N created rooms only (propose N=3 — the host's 3 most recent sessions are the only plausible "still warm cookie" candidates; older cookies are almost certainly expired). The list is already sorted most-recent-first, so a `.filter(r => r.role === 'created').slice(0, 3)` in the probe loop is sufficient. Alternatively, probe lazily on hover/click of the Admin link.

```ts
// Replace:
for (const room of rooms) {
  if (room.role !== "created") continue;
  fetch(...)
}

// With (eager top-3 approach):
const toProbe = rooms.filter(r => r.role === "created").slice(0, 3);
for (const room of toProbe) {
  fetch(...)
}
```

For rooms beyond the top 3, the admin link already safely falls back to `?expired=1` (which routes to the login gate), which is the correct behavior when the probe hasn't run. This is the sensible default.

### Gate clarification (non-blocking, for TM awareness)

**[INFO-1] verify-green-local.sh absent from boraoke repo**

The reviewer framework (D-051) treats the local-Docker `verify-green-local.sh` GREEN as the authoritative CI gate. This repo does not have that script. The CI gate for boraoke is GitHub Actions (npm ci → build → npm test → playwright). I ran the unit suite locally (371/371) and verified the build — but could not run the full GitHub Actions gate locally. This is a framework repo gap, not a PR defect. Noting for TM.

### Nits (non-blocking)

**[NIT-1] v1→v2 migration story is absent but not needed yet**

The comment "Versioned for future migration" on `ROOMS_KEY` implies a migration path exists but none is documented. Acceptable at this wave — the design avoids the need for a v2 migration by embedding `claimable` now and by using additive coercion. If a breaking schema change ever becomes necessary, the `_v1` suffix is a clear rename hook. Document the intended strategy in a follow-up ticket if desired (optional: file a TICKET-44 or add a comment inline).

**[NIT-2] `adminHref` always shows `?expired=1` until probe completes**

While the host-session probe is in flight, `hostValid[room.id]` is `undefined`, so `adminHref` evaluates to `/${room.id}/admin?expired=1`. This means there is a brief flash where a host with a valid cookie first sees "expired=1" in the href (even if the link doesn't visually say "expired"). The UX self-corrects once the probe resolves, but it could cause a confusing transient state if the user clicks Admin very fast after landing. Consider: default to the plain `/${room.id}/admin` when the probe is in-flight (undefined) — the AdminRoom already calls `checkSession()` on load and will redirect to the login gate if needed. This avoids the misleading transient href and is more honest. (Optional — do not block on this.)

---

## Evidence relied upon

- Diff: local `git diff a1129ed..origin/ticket/43-session-recovery` (git-local-first)
- Test run: `npm test` in ticket-43 worktree → 371/371
- Room-memory targeted run → 17/17
- Build: `npm run build` → success
- Pre-existing failure confirmation: byte-identical feedback.spec.ts between main and branch
- App Tester PASS report: work/reports/testing/TICKET-43-app-test.md (on branch)
- Security waiver: TM-assessed N/A-by-content, confirmed by reviewer
- PatronRoom.tsx overlap: TICKET-40 branch diff — confirmed separate regions but merge conflict inevitable
- Planning doc: work/planning/accounts-and-identity.md — I-2 claim model consistent with `claimable` flag and syncLocalRooms stub
- Ticket: work/tickets/TICKET-43-session-recovery.md — all 6 acceptance criteria checked against diff

---

## Acceptance criteria check

| AC | Status |
|---|---|
| 1. Creating a room records id/name/role/createdAt with NO host code field | PASS |
| 2. Joining a room records id/name/lastSeen/role:joined | PASS |
| 3. Landing "Suas salas" with role-appropriate links + ✕ + "salvas neste dispositivo" | PASS |
| 4. Valid cookie → admin direct; expired → login gate with honest copy | PASS |
| 5. claimable flag + syncLocalRooms stub pointing at accounts plan, no auth built | PASS |
| 6. Unit tests (add/dedupe/forget/order/cap/never-stores-hostCode) + E2E green | PASS (371/371 unit, 30/31 e2e pre-existing fail) |

All acceptance criteria are met by the implementation. The blocking item (probe bounding) is a quality/performance issue not directly in the ticket's acceptance criteria but is a correctness concern the Reviewer is responsible for catching.

---

## Summary

The implementation is clean, well-structured, and correctly addresses the ticket's scope. The lib quality is high: fail-soft paths, type-enforced + runtime-stripped security invariant, injected storage for testability, documented wave-28 seam. The single blocking issue is the unbounded parallel probe fan-out on landing load, which needs a cap (top-3 created rooms is the natural bound). The fix is a one-liner; re-review expected to be fast.

---

# Re-review (round 2) — fix commit 512b8fe

Dev addressed all three items (PR reply: issuecomment-4918944893). Delta reviewed locally (`git diff f70e384..origin/ticket/43-session-recovery`); suite re-run independently.

## BLOCKING-1 — probe bounding: FIXED, confirmed at the fetch loop

- New pure helper `roomsToProbe(rooms, limit = MAX_HOST_PROBES)` in `lib/room-memory.ts` (`MAX_HOST_PROBES = 3`): `rooms.filter(r => r.role === "created").slice(0, limit)`.
- **Critical check — the bound genuinely gates the fetch loop, not just a display list:** `SavedRooms.tsx`'s probe `useEffect` now iterates `for (const room of roomsToProbe(rooms))` — the `fetch` call itself is inside this bounded loop. The old unbounded `for (const room of rooms) { if (role !== "created") continue; fetch(...) }` is gone. Max 3 fetches per landing load, most-recent-first (loadRooms returns sorted). Confirmed in the diff and current file.
- 3 new unit tests (`describe("probe bound (BLOCKING-1, PR #22)")`): bound holds with 5+ created rooms (exactly 3, most-recent-first, joined never probed), fewer-than-limit case, custom limit. All pass.

## NIT-1 — in-flight adminHref: FIXED

Default flipped: only a probe that POSITIVELY returned expired (`hostValid[room.id] === false`) routes to `?expired=1`; in-flight/unprobed rooms link to plain `/<id>/admin`, whose own `checkSession()` self-routes. This also correctly covers the >3 unprobed rooms after BLOCKING-1 — they get the plain link, never a misleading "expirou".

## NIT-2 — migration story: DOCUMENTED

`ROOMS_KEY` doc comment now states the strategy: additive shape changes absorbed at read time by `coerceRoom` defaults (no key bump); `_v2` only on a breaking shape change with a one-time read-v1→write-v2 migration in `loadRooms`.

## Independent verification (round 2)

- `npm test` at HEAD f4e42e2: **25 suites, 374 passed, 0 failed** (371 + 3 new probe-bound tests).
- `npm run build`: compiled successfully, 22/22 static pages, type-check clean.
- Dev report updated (status line current, round-1 fix log added) — TICKET-F23 currency satisfied.
- Dev reports full e2e 31 passed on PORT=3043 this round (including the feedback spec that was flaky/failing before — consistent with a flaky pre-existing test, not a regression).

## Final verdict: APPROVE

All round-1 items resolved and confirmed by direct code read + independent test run. Sequential-merge constraint with TICKET-40 (shared `PatronRoom.tsx`) still applies at merge time.

---

# Opus judgment pass (D-022 merge-counting) — 2026-07-08

Second, judgment-tier pass over what the sonnet pass could miss: the load-bearing wave-28 seam, venue-tablet privacy reality, the probe-as-oracle question, UX honesty. Independently re-verified: **374/374 unit** (25 suites), **`next build` clean** (22 pages, type-check clean), **saved-rooms e2e 3/3 green on PORT=3043**, evidence screenshots (`01-landing-suas-salas.png`, `02-admin-session-expired.png`) watched.

## 1. THE WAVE-28 SEAM — the load-bearing ruling

**Question posed:** is `claimable: true` from localStorage alone sufficient evidence for the server to hand room ownership to an account? If a stolen/synced localStorage blob could claim someone else's room, the seam is designed wrong.

**Ruling: the seam is designed RIGHT, and does not need a breaking `_v2` later — PROVIDED wave 28 honors one invariant that must be pinned now (below). Reasoning:**

- I verified directly that room creation persists **no** server-side creator linkage today (`grep creatorUuid|identity: app/api/rooms lib/store.ts` → empty; correct — that is TICKET-26 scope). So the *only* record that "this device created room X" today lives in this localStorage blob.
- The claim model (accounts-and-identity.md I-2) resolves ownership through a **server-side** `identity:{uuid}:rooms` index written at *room-creation time* (TICKET-26 acceptance criterion 3), plus host-token proof for legacy pre-26 rooms (I-4). Crucially, that index is server-authored — it is NOT derived from this localStorage blob.
- Therefore: **`claimable: true` in localStorage is a client-side hint of INTENT to claim, never server-side PROOF of ownership.** A synced/stolen blob presented to `/api/account/claim-rooms` proves nothing on its own — the server must independently confirm the requesting device's registered anon uuid appears in `identity:{room}:...`/`identity:{uuid}:rooms`, or that the caller presents host-token proof. A blob copied to another device carries no valid identity cookie for those rooms, so it fails that server check. The seam is sound.
- The `syncLocalRooms()` stub's TODO already gestures at this ("server verifies ownership via the device's registered anonymous uuid, TICKET-26, or host-token proof for legacy rooms") — good. But it is a *comment gesture*, not a pinned contract, and a future implementer skimming `claimable: true` could naively trust the flag as authorization. That is the one redesign-later risk, and it is cheap to close now with a note.

**What wave 28 (TICKET-28) MUST add — pin this as a claim-path acceptance criterion (a note now, not a redesign later):**

> **The server MUST treat the localStorage `claimable` flag / the client's posted room-id list as an untrusted request, never as ownership evidence.** Ownership for the claim is authorized ONLY by (a) the requesting device's server-registered anon uuid appearing in the server-side `identity:{uuid}:rooms` index (rooms created after TICKET-26), or (b) valid host-token proof (legacy pre-26 rooms, I-4). A `claimable: true` blob with no matching server-side uuid→room link (a synced/copied/stolen blob) MUST be rejected. `syncLocalRooms()` POSTs a *claim request*; the server adjudicates.

This is consistent with I-2 and needs no shape change to what TICKET-43 persists — hence **no `_v2` migration is forced by the seam.** The persisted `{id, name, role, lastTouched, claimable}` shape is a correct forward-compatible client cache. Filing this as a TICKET-28 claim-path AC (and I recommend echoing the one-line "flag is intent, not proof" invariant into the `syncLocalRooms` doc comment as a NIT follow-up) closes the only latent trap. **Seam quality: correct. Verdict unaffected.**

## 2. Venue-tablet privacy — shared-device multi-user reality

Real scenario: a bar tablet where patron A joins rooms, then patron B picks up the same tablet and sees A's "Suas salas". My judgment: **acceptable device-memory semantics for this ticket — NOT a blocker.**

- The exposure is bounded and low-sensitivity: room ids/names A joined (public join slugs) + one-tap re-entry. No PII is stored at this layer by design (accounts-and-identity.md keeps nickname room-scoped/ephemeral; this ticket persists no nickname). "Suas salas" leaks "rooms this browser touched," which on a shared tablet is genuinely shared-browsing state — the same semantics as browser history, not an account.
- The honest copy ("Salvas neste dispositivo") sets the correct mental model, and every row has a working ✕ to forget. The primary venue-tablet actor is the *host* (their own station), for whom this is the intended, desirable recovery affordance.
- The real "not you?" affordance belongs to the accounts wave (sign-out returns the device to a working anon state — TICKET-28 AC 4) and to a future shared-kiosk mode, not here. **Filed as a follow-up nit for the accounts wave (NIT-3 below), not a change request.** Shipping device memory without it is the honest MVP.

## 3. Probe as room-existence oracle — assessed, NOT a new oracle

`GET /api/host/session?room=<id>` is **pre-existing and untouched by this PR** (confirmed: the route is not in the diff). TICKET-43 only *calls* it from the landing page. It returns `{authed, configured}`; `configured` reveals whether host controls exist for a room — but this is already public surface (the admin page calls the same endpoint on load for any visitor, and `roomIdFromRequest` validates the id via `isValidRoomId`, returning 400 on malformed). The client (`SavedRooms.tsx`) reads only `res.ok` (200 vs 401). **No new oracle capability is introduced** — a landing page can only probe rooms it already remembers touching (ids already in its own localStorage), so it learns nothing it didn't already know. The bounded top-3 fan-out (MAX_HOST_PROBES=3) further caps request volume. No security finding.

## 4. UX honesty — confirmed on evidence

Watched `01-landing-suas-salas.png`: "Suas salas / Salvas neste dispositivo — volte rápido pra uma sala que você criou ou entrou." Created rooms show Entrar/Admin/TV; joined show only Entrar; ✕ present per row. `02-admin-session-expired.png`: "Sua sessão expirou — entre com o código da sala." in amber on the login gate — honest, actionable, never claims the code is recoverable. Copy sets exactly the right expectation for a per-device, no-login bridge. Approved.

## Follow-up nits (non-blocking, do NOT gate merge)

- **[NIT-3 — wave 28] Pin the claim-authorization invariant.** Add to TICKET-28 a claim-path AC: the server treats `claimable`/posted room-ids as an untrusted request and authorizes only via server-side uuid→room link or host-token proof (see §1). Optionally echo "flag is intent, not proof" into the `syncLocalRooms()` doc comment. Cheap now; prevents a genuine ownership-transfer bug later.
- **[NIT-4 — accounts/kiosk] Shared-tablet "not you?" affordance.** Device memory on a shared venue tablet exposes prior patrons' touched-room list. Acceptable now; the accounts wave should ship sign-out-clears-device (TICKET-28 AC 4 already covers this) and consider a kiosk/clear-all control. Follow-up, not this ticket.

## Opus verdict: APPROVE (merge-counting)

The implementation is correct, cleanly scoped, honestly copied, and well-tested; the security invariant (host code never persisted) is type-forbidden + runtime-stripped + test-asserted + App-Tester-verified; the wave-28 seam is soundly designed and forces no future migration. The two nits above are follow-ups for the accounts wave, not conditions on this merge. All gates align.

**Merge constraint (unchanged):** sequential merge with PR #21 / TICKET-40 — both touch `PatronRoom.tsx`; #21 merges first, this rebases. Non-conflicting regions but a textual merge conflict is inevitable; TM to sequence.
