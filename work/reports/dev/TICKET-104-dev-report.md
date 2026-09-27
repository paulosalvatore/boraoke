# TICKET-104 — Dev report

**Status:** implemented; unit suite green; new e2e spec green; full e2e + floor gates in progress at time of writing (updated below).
**Worktree:** `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t104-creator-admin`, branch `ticket/104-creator-admin`
**Plan:** `work/plans/TICKET-104-plan.md`

## What the code actually says (versus what the ticket assumed)

The ticket asked me to verify its reading rather than take its word. Two corrections came out of that, and both changed the design.

**1. The claim credential is a cookie, not localStorage.** The ticket suggested keying the claim on `creatorUuid` "since the device already holds `cantai_patron_uuid`". But `room.creatorUuid` is the *registered identity* uuid, and its authoritative copy is **`boraoke_identity`** — an httpOnly, root-path, **2-year** cookie (`lib/identity.ts:30,40`). The localStorage `cantai_patron_uuid` is only a mirror of it. The identity cookie outlives the 30-day host session by 24x, and the creator's uuid is never exposed to any client (`PublicRoom` omits `creatorUuid`, `lib/rooms.ts:85-87`; `__tests__/rooms.test.ts:172` already asserts it). So the claim can be keyed on a credential the page's JS cannot read, and **nothing has to be persisted in localStorage at all** — `lib/room-memory.ts`'s never-store-the-host-code invariant is preserved untouched, not weakened and not worked around.

**2. The gap is wider than "after 30 days".** Room creation issues **no host session at all** (`app/api/rooms/route.ts` sets only the identity cookie). So before this change, a creator who clicked "abrir painel" on the very page that had just shown them the host code landed on the **login gate** and had to type it immediately. `e2e/moderation.spec.ts:52-59` encodes exactly that as the expected flow. The ticket described the cliff as 30 days out; it was in fact at second zero.

## Mechanism chosen, and the trade-off

**Option (ii), a creator-claim path — keyed on the httpOnly identity cookie.** New `POST /api/host/claim?room=<id>`: read `boraoke_identity` from the cookie, compare constant-time to the room's `creatorUuid`, and on a match issue the normal host session cookie. `AdminRoom.checkSession()` tries it once when the session probe 401s, before falling back to the gate.

Rejected:
- **(i) extend the cookie's reach** alone — a longer or more eagerly rolled host session does nothing once the cookie is *cleared* (new profile, privacy cleanup), and nothing for the buried-hero half of the ticket. It is also strictly weaker than (ii) for the same code volume.
- **(iii) persist a token in localStorage** — literally what item 5 asked for, and the weakest available: XSS-readable, and it makes every remembered room a standing credential. It would buy *less* resilience than a 2-year httpOnly cookie while overturning a documented security invariant. Refused deliberately, in writing, rather than silently.

**The trade-off, stated plainly:** this fixes the same-device case completely and does **not** help a new device or a wiped browser. That is intentional. A device with no proof of ownership should not get admin; the shown-once host code remains the cross-device path, and no mechanism can rescue a creator who kept neither the code nor the device — only accounts (wave 4/5) can.

## The privilege escalation this created, and the guard that closes it

`createIdentityResolver` (`lib/identity.ts`) adopted a **caller-supplied** uuid verbatim whenever no identity cookie was present, and both callers (`POST /api/identity`, `POST /api/rooms`) then returned it as the httpOnly identity cookie. Harmless while nothing authorized off an identity. The moment a claim endpoint exists it becomes a one-request takeover:

```
POST /api/identity {"legacyUuid": "<a creator's uuid>"}   → Set-Cookie: boraoke_identity=<creator>
POST /api/host/claim?room=<their room>                    → host session
```

So the claim would have shipped with a trivial bypass. Closed in `lib/identity.ts`: in the **client-asserted branch only**, a uuid that already owns rooms server-side (`identityStore.listRooms`) is not adopted — a fresh uuid is minted instead. A cookie-presented uuid is untouched (we set it; it is never re-litigated). The lookup **fails closed**: if it throws, adoption is refused.

Accepted cost: a device whose identity predates the cookie, which created rooms and then lost the cookie, can no longer re-adopt its uuid by asserting it — it falls back to the host code. That is the safe side of exactly the ambiguity an attacker impersonates, and it is the only case the guard fires on (a patron-only legacy uuid owns no rooms and still adopts, so TICKET-26's continuity case is intact).

## Adversarial questions the ticket demanded answers to

**What stops a patron who learns a room id from claiming it?** Their identity cookie's uuid is not the room's `creatorUuid`, and there is no other input to the decision: the route reads no body and no query parameter but `room`. Proven both ways — `__tests__/host-claim.test.ts` rejects a different uuid, a prefix-sharing uuid, a non-string, a creatorless room, a non-existent room and `default`; and `e2e/creator-reentry.spec.ts` test 3 opens the admin URL from a second browser context and still gets the code gate. Failures also charge a per-IP budget, so room ids cannot be swept for a claimable one.

**What happens when two devices claim the same room?** Both succeed, and this is unchanged from today rather than new: `sessionValue` is a deterministic HMAC of the room secret, so host sessions have never been unique or revocable per device — two devices that know the code already hold identical, indistinguishable sessions (`lib/host-auth.ts`'s own 30-day note says so). Claim adds a second way to reach the same non-exclusive session, not a new concurrency property. Deliberate host logout (`POST /api/host/session`) remains the only end-a-session control, and it still works.

**Blast radius if `cantai_patron_uuid` is copied off a device?** For this feature, **zero** — it is not an input to the claim decision anywhere. The pre-existing exposure it does carry is unchanged and unrelated: `GET /api/queue/pending?uuid=` is already bearer-style on that uuid by design. What *would* have made the copied value dangerous is the adoption path above, and that is now guarded. Worth noting for the reviewer: the guard is what keeps the answer "zero" — without it, the answer would be "full admin on every room that device created".

**Throttle bucket.** Claim failures use their own counter (`hostclaim:<ip>`), deliberately not login's. Every session-less visit to an admin URL now costs one claim attempt, so sharing the bucket would let ordinary traffic 429 the creator's own code gate on a shared IP (venue tablet, café NAT). Both directions are asserted.

## Files changed

| File | Change |
|---|---|
| `lib/identity.ts` | adoption guard (+ fail-open return now echoes the client's own best-known uuid) |
| `lib/host-auth.ts` | `verifyCreatorClaim`; separate claim throttle bucket |
| `app/api/host/claim/route.ts` | **new** route, cookie-only, throttled |
| `app/(patron)/[room]/admin/AdminRoom.tsx` | one claim attempt before the gate |
| `lib/room-memory.ts` | `primaryCreatedRoom` pure helper (no new storage, no new key) |
| `app/page.tsx`, `app/page.module.css` | returning-creator hero; generic hero unchanged when no created room |
| `messages/{pt-BR,en,es}.json` | 7 new `Landing.*` keys (parity gate green) |

`lib/store/types.ts` untouched. No `cantai_*` key renamed. No new storage key introduced at all.

## prove-your-test-can-fail

### (b) Reverse-check — new tests against the pre-fix implementation

Unit (`git stash push -- lib`, new/changed suites re-run):

```
  ● verifyCreatorClaim — the creator's device gets in › accepts the identity uuid that created the room
  ● verifyCreatorClaim — every other caller stays out › rejects a DIFFERENT identity uuid (a patron who learned the room id)
  ● verifyCreatorClaim — every other caller stays out › rejects a uuid that merely SHARES A PREFIX with the creator's
  ● verifyCreatorClaim — every other caller stays out › rejects a room with NO creatorUuid on record, even when asked with an empty uuid
  ● verifyCreatorClaim — every other caller stays out › rejects a non-string uuid without throwing
  ● verifyCreatorClaim — every other caller stays out › rejects a room that does not exist
  ● verifyCreatorClaim — every other caller stays out › rejects the legacy `default` room, which has no creator
  ● claim throttle — its OWN bucket, never the login one › spending the claim budget does NOT throttle the host-code login path
  ● claim throttle — its OWN bucket, never the login one › spending the login budget does not throttle claims
  ● claim throttle — its OWN bucket, never the login one › a successful claim resets its own bucket
  ● primaryCreatedRoom — which room the hero leads with › is the most-recently-touched CREATED room
  ● primaryCreatedRoom — which room the hero leads with › SKIPS a more recent JOINED room — a patron's hero is not someone else's venue
  ● primaryCreatedRoom — which room the hero leads with › is null for a device that only ever joined rooms
  ● primaryCreatedRoom — which room the hero leads with › is null for a first-time visitor (generic hero stays)
  ● primaryCreatedRoom — which room the hero leads with › picks up a room the device created AFTER joining it (created is sticky)
  ● resolveIdentity (via createIdentityResolver) › refuses to adopt a client-asserted uuid that already OWNS rooms (impersonation)
  ● resolveIdentity (via createIdentityResolver) › refuses adoption when the ownership lookup FAILS but the store is otherwise up
Test Suites: 3 failed, 3 total
Tests:       17 failed, 35 passed, 52 total
```

E2E is the load-bearing one, since the behaviour is UI. Claim route moved aside, `lib` + `app` reverted, spec re-run unchanged:

```
  ✘  1 creator admin re-entry › the creator reaches admin straight from creation, typing nothing (10.2s)
  ✘  2 creator admin re-entry › re-entry works with ONLY the identity cookie left (host session gone) (7.6s)
  ✓  3 creator admin re-entry › a device that did NOT create the room still hits the code gate (2.6s)
  ✘  4 returning-creator homepage hero › the hero leads with the created room and links into admin (7.3s)
  ✓  5 returning-creator homepage hero › a first-time visitor sees the generic hero, unchanged (547ms)
  3 failed
  2 passed (34.8s)
```

That is the correct signature, and the two green ones are the point: tests 3 and 5 are **negative controls** asserting behaviour that must be identical before and after (a non-creator still gets the gate; a first-time visitor still gets the generic hero). They are supposed to pass on the pre-fix code. The three that assert the new capability all fail.

### (a) Mutations that kill each new assertion

| # | Mutation | Result |
|---|---|---|
| M1 | `timingSafeHexEqual(identityUuid, creator)` → 8-char prefix compare | **KILLED** — `rejects a uuid that merely SHARES A PREFIX` (1 failed / 9 passed) |
| M2 | delete `if (roomId === DEFAULT_ROOM) return false` | **KILLED** — `never claims the default room even if a record with a creator exists` (1 failed / 11 passed) |
| M3b | delete BOTH absent-value guards | **KILLED** — `never matches a BLANK creatorUuid against a blank identity uuid` + `rejects a non-string uuid without throwing` (2 failed / 10 passed) |
| M3c | delete ONLY the creator-side blank guard | **SURVIVED-equivalent** — argued below |
| M3d | delete ONLY the identity-side blank guard | **KILLED** — `rejects a non-string uuid without throwing` |
| M4 | claim throttle key → `login:<ip>` (shared bucket) | **KILLED** — both bucket-separation tests (2 failed / 8 passed) |
| M5 | adoption guard always allows (`adoptable` → `true`) | **KILLED** — both new identity tests (2 failed / 15 passed) |
| M6 | adoption guard fails OPEN on lookup error (`catch` → `true`) | **KILLED** — `refuses adoption when the ownership lookup FAILS` |
| M7 | `primaryCreatedRoom` ignores role (`find` → `rooms[0]`) | **KILLED** — `SKIPS a more recent JOINED room` + `is null for a device that only ever joined rooms` (2 failed / 23 passed) |

**M2 and M3b initially SURVIVED and I did not argue them away.** Both guards are unreachable through `createRoom` (it refuses the id `default` via `RESERVED_ROOM_IDS`, and spreads `creatorUuid` only when truthy), so a `createRoom`-only suite cannot distinguish them — which is precisely the "defence that nothing asserts is decoration" case. I added two tests that write the record **straight to `roomBackend`**, and both mutants are now killed. No survivor was left standing on an argument where a test was available.

**M3c, the one remaining survivor, is genuinely equivalent-by-redundancy.** The blank-value guards are a deliberate pair: with the identity-side guard present, a blank `creator` can never be compared because a blank `identityUuid` has already returned false. Removing either one alone leaves the other covering the case; removing both is detected (M3b). The property — two absences never authenticate each other — is asserted, and the pair is belt-and-suspenders by design, not an untested branch.

### (c) Hollowing-out declaration

**A primitive beneath an existing assertion DID change**, so this is not a "nothing changed" case. `resolveIdentity`'s fail-open return changed from `candidate` to `clientKnown ?? candidate`, and the adoption decision itself gained a precondition. The existing assertion that depends on it is `__tests__/identity.test.ts` → *"fail-open: a throwing store never throws out of resolveIdentity"*, which asserts `result.uuid === A` with a fully-throwing store.

Re-examined: it is **not** vacuous, and it is **not** true by construction. It now passes through the `catch` branch's `clientKnown` echo rather than through adoption, and it still discriminates — M5/M6 above both leave it green while flipping other assertions, and reverting the `clientKnown` line makes it fail (the guard would mint a fresh uuid instead of echoing `A`). I also checked the opposite risk deliberately: that the guard might make the fail-open test pass for a *wrong* reason, i.e. by masking a real adoption. It does not — the new test *"refuses adoption when the ownership lookup FAILS but the store is otherwise up"* pins the `ok: true` path separately, so the two cases cannot be confused. The design point behind the split is that `ok: false` means callers set **no** cookie and write **no** `creatorUuid`, so a uuid echoed there can never become a claim credential.

### (d) Triggered mutation pass

`triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path`

Stated for the record, with the borderline call shown rather than hidden: `verifyCreatorClaim` sits on an **identity** path, but it is a comparison, not a parser or normaliser — it introduces no new parsing or normalisation of user input (it compares two opaque values and refuses everything that is not a non-empty string). The clause as written does not fire. I ran a 9-mutant pass on it regardless, above, because it is auth code and the instrument is cheap.

## Gates run

| Gate | Result |
|---|---|
| `npx jest` (full) | **53 suites passed, 939 passed / 5 skipped / 944 total** (52 suites before this ticket; `host-claim.test.ts` is the 53rd). The dispatch brief said 54 — the real count is 53, reported as measured. |
| `PORT=3044 npx playwright test e2e/creator-reentry.spec.ts` | **5 passed (26.4s)** |
| `PORT=3044 npx playwright test` (full) | see the update section below |
| `npm run build` → ES2019 bundle check + `check-css-target.mjs` | see the update section below |
| `npx tsc --noEmit`, filtered to `app/ lib/ components/` | clean (the unfiltered run reports pre-existing jest-types noise in `__tests__/**`, unrelated to this branch) |

E2E ran on `PORT=3044`, not the default 3040, so it could never touch the dev servers of the sibling worktrees (`t99-runtime`, `t101-landing`, `t103-tv-focus`). Playwright's chromium headless shell had to be installed (`npx playwright install chromium`) — it was absent, so the first e2e attempt failed on a missing browser rather than on anything in the diff.

## Friction

- `npx tsc --noEmit` is not a usable signal in this repo as-is: it type-checks `__tests__/**` without jest globals and emits hundreds of `Cannot find name 'describe'` errors. The real typecheck is `next build`. Worth a `typecheck` script that excludes tests, or jest types in the base tsconfig.
- The Playwright browser was not installed in this worktree's environment; a first-time e2e run costs a 93 MB download before any test can execute.

## Deferred, not done (deliberately out of scope)

Room creation could also issue the host session directly, saving the claim round-trip on the very first hop. I left it alone on purpose: the claim path already covers that moment, and two mechanisms minting the same session is more surface for no behavioural gain. Worth a follow-up only if the extra request shows up as a real latency problem.
