# TICKET-104 — Dev report

**Status:** ROUND 3 — the credential is redesigned after the security gate's REQUEST-CHANGES. See `## Round 3` at the end; the round-2 status line below is kept for history. Round 2 status was: B1 and B2 fixed, all report corrections applied. Gates: jest **53 suites / 948 passed / 5 skipped / 953 total**; full Playwright **113 passed, 0 failing runs out of 3 consecutive fresh-server runs**; ES2019 + CSS-target floor gates OK. B3 (App Tester, Cyber Security) is the Tech Manager's. See `## Round 2` at the end of this file; the corrections the review asked for are applied inline above it, so this file reads as the current record rather than a patchwork.
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

Accepted cost, corrected per review NB-2 (Round 1 got both halves of this wrong):

- **The affected population is not "a device whose identity predates the cookie".** Such a device owns no rooms at all — `creatorUuid` and `addRoom` only began at TICKET-26 — so it cannot trigger the guard. The real case is a **post**-TICKET-26 device that created rooms and then lost its identity cookie while keeping localStorage. Same accepted cost, different population: it falls back to the host code.
- **It is not the only case the guard fires on.** It also fires when `store.listRooms` **throws**, and that path refuses adoption for *everyone* until the rooms index recovers — patron-only uuids included. Round 1 answered that case by minting a substitute uuid, which `PatronRoom.tsx` then writes into `cantai_patron_uuid`, **irreversibly discarding the device's real identity** over a transient error (its own-row highlighting and pending-submissions view, gone for good). That is worse than the error it was reacting to. Fixed in round 2: `adoptable` now returns a tri-state and the `"unknown"` case returns `ok: false` — nothing registered, no cookie set, the client keeps its own uuid and retries on the next load. The impersonation property is unchanged (still fail-closed), and nothing is destroyed.

## Adversarial questions the ticket demanded answers to

**What stops a patron who learns a room id from claiming it?** Their identity cookie's uuid is not the room's `creatorUuid`, and there is no other input to the decision: the route reads no body and no query parameter but `room`. Proven both ways — `__tests__/host-claim.test.ts` rejects a different uuid, a prefix-sharing uuid, a non-string, a creatorless room, a non-existent room and `default`; and `e2e/creator-reentry.spec.ts` test 3 opens the admin URL from a second browser context and still gets the code gate. Failures also charge a per-IP budget, so room ids cannot be swept for a claimable one.

**What happens when two devices claim the same room?** Both succeed, and this is unchanged from today rather than new: `sessionValue` is a deterministic HMAC of the room secret, so host sessions have never been unique or revocable per device — two devices that know the code already hold identical, indistinguishable sessions (`lib/host-auth.ts`'s own 30-day note says so). Claim adds a second way to reach the same non-exclusive session, not a new concurrency property. Deliberate host logout (`POST /api/host/session`) remains the only end-a-session control, and it still works.

**Blast radius if `cantai_patron_uuid` is copied off a device?** For this feature, **zero** — it is not an input to the claim decision anywhere. The pre-existing exposure it does carry is unchanged and unrelated: `GET /api/queue/pending?uuid=` is already bearer-style on that uuid by design. What *would* have made the copied value dangerous is the adoption path above, and that is now guarded. Worth noting for the reviewer: the guard is what keeps the answer "zero" — without it, the answer would be "full admin on every room that device created".

**Throttle bucket.** Claim failures use their own counter (`hostclaim:<ip>`), deliberately not login's. Every session-less visit to an admin URL now costs one claim attempt, so sharing the bucket would let ordinary traffic 429 the creator's own code gate on a shared IP (venue tablet, café NAT). Both directions are asserted.

## Files changed

| File | Change |
|---|---|
| `lib/identity.ts` | adoption guard (+ fail-open return now echoes the client's own best-known uuid) |
| `lib/host-auth.ts` | `verifyCreatorClaim`; separate claim throttle bucket; the no-claim marker (name/options/detector) |
| `app/api/host/claim/route.ts` | **new** route, cookie-only, throttled, refuses after logout |
| `app/api/host/session/route.ts` | logout also sets the no-claim marker |
| `app/api/host/login/route.ts` | a successful code login clears the no-claim marker |
| `e2e/helpers.ts` + 4 existing specs | `dropCreatorIdentity` helper; claim route warmed; gate-reaching specs present as non-creators |
| `app/(patron)/[room]/admin/AdminRoom.tsx` | one claim attempt before the gate |
| `lib/room-memory.ts` | `primaryCreatedRoom` pure helper (no new storage, no new key) |
| `app/page.tsx`, `app/page.module.css` | returning-creator hero; generic hero unchanged when no created room |
| `messages/{pt-BR,en,es}.json` | 7 new `Landing.*` keys (parity gate green) |

`lib/store/types.ts` untouched. No `cantai_*` key renamed. **No new localStorage key** — the only new client-side state is the httpOnly `boraoke_noclaim_<room>` cookie that makes logout stick, which is server-set and unreadable from JS.

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
| M3c | delete the creator-side guard LINE entirely | **KILLED** — `rejects a room with NO creatorUuid on record` + `rejects a room that does not exist`, both with `TypeError: The "data" argument must be of type string… Received undefined` (2 failed / 19 passed). Round 1 labelled this SURVIVED-equivalent and that was **wrong** — see the correction below. |
| M3c′ | weaken that guard to `typeof creator !== "string"` only (keep the type check, drop `length === 0`) | **SURVIVED-equivalent** — the narrower variant, argued below |
| M3d | delete ONLY the identity-side blank guard | **KILLED** — `rejects a non-string uuid without throwing` |
| M4 | claim throttle key → `login:<ip>` (shared bucket) | **KILLED** — both bucket-separation tests (2 failed / 8 passed) |
| M5 | adoption guard always allows (`adoptable` → `true`) | **KILLED** — both new identity tests (2 failed / 15 passed) |
| M6 | adoption guard fails OPEN on lookup error (`catch` → `true`) | **KILLED** — `refuses adoption when the ownership lookup FAILS` |
| M7 | `primaryCreatedRoom` ignores role (`find` → `rooms[0]`) | **KILLED** — `SKIPS a more recent JOINED room` + `is null for a device that only ever joined rooms` (2 failed / 23 passed) |

**M2 and M3b initially SURVIVED and I did not argue them away.** Both guards are unreachable through `createRoom` (it refuses the id `default` via `RESERVED_ROOM_IDS`, and spreads `creatorUuid` only when truthy), so a `createRoom`-only suite cannot distinguish them — which is precisely the "defence that nothing asserts is decoration" case. I added two tests that write the record **straight to `roomBackend`**, and both mutants are now killed. No survivor was left standing on an argument where a test was available.

**Correction (review NB-1): M3c is KILLED, and Round 1's reasoning about it was unsound and dangerous.** I mutated the guard to `typeof creator !== "string"` — keeping the type check — and reported the survivor as "belt-and-suspenders". The reviewer deleted the **whole line**, which is the mutation that matters, and it fails 2 tests with a `TypeError` from `createHmac().update(undefined)`. My stated argument ("a blank `creator` can never be compared because a blank `identityUuid` has already returned false") does not hold: the killing case is a **non-blank** identity uuid against an **absent** creator, which the identity-side guard never touches.

So the creator-side guard is **not** redundant. Its `typeof` half is the only thing standing between a creatorless room — every legacy room, and every room created while the identity store was down — and an unhandled `TypeError`, i.e. **HTTP 500 on every claim against such a room**. Only the `length === 0` half is redundant with the identity-side check (M3c′ above), and even that is cheap defence against a hand-written record. A future reader deciding whether to simplify this must not take "belt-and-suspenders" from this file.

### (c) Hollowing-out declaration

**A primitive beneath an existing assertion DID change**, so this is not a "nothing changed" case. `resolveIdentity`'s fail-open return changed from `candidate` to `clientKnown ?? candidate`, and the adoption decision itself gained a precondition. The existing assertion that depends on it is `__tests__/identity.test.ts` → *"fail-open: a throwing store never throws out of resolveIdentity"*, which asserts `result.uuid === A` with a fully-throwing store.

Re-examined: it is **not** vacuous, and it is **not** true by construction. It now passes through the `catch` branch's `clientKnown` echo rather than through adoption, and it still discriminates — M5/M6 above both leave it green while flipping other assertions, and reverting the `clientKnown` line makes it fail (the guard would mint a fresh uuid instead of echoing `A`). I also checked the opposite risk deliberately: that the guard might make the fail-open test pass for a *wrong* reason, i.e. by masking a real adoption. It does not — the new test *"refuses adoption when the ownership lookup FAILS but the store is otherwise up"* pins the `ok: true` path separately, so the two cases cannot be confused. The design point behind the split is that `ok: false` means callers set **no** cookie and write **no** `creatorUuid`, so a uuid echoed there can never become a claim credential.

### (d) Triggered mutation pass

`triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path`

Stated for the record, with the borderline call shown rather than hidden: `verifyCreatorClaim` sits on an **identity** path, but it is a comparison, not a parser or normaliser — it introduces no new parsing or normalisation of user input (it compares two opaque values and refuses everything that is not a non-empty string). The clause as written does not fire. I ran a 9-mutant pass on it regardless, above, because it is auth code and the instrument is cheap.

## Gates run

| Gate | Result |
|---|---|
| `npx jest` (full) | see `## Round 2` for the current measured counts. (Round 1 reported 939/944; that was **stale** — the tip measured 943/948 once the logout fix landed. NB-4.) |
| `PORT=3044 npx playwright test e2e/creator-reentry.spec.ts` | Round 1 reported 5 passed; the tip has **7** tests (the two logout tests landed mid-ticket). NB-4. |
| `PORT=3044 npx playwright test` (full) | Round 1 reported **113 passed / 0 failed. That was a lucky draw, not a green gate** — the reviewer measured 112/1 on the same tip, and the failing test was the headline acceptance criterion, failing ~43% of the time because of B1. See `## Round 2`. |
| `npm run build` → ES2019 bundle check + `check-css-target.mjs` | both **OK**, verbatim: `bundle-es-target: OK — all 49 chunk(s) parse at ES2019.` / `css-target: OK — the TV surface uses nothing newer than Chrome 68 (13 stylesheet(s) scanned).` The CSS gate also printed 15 **advisory** (non-build-blocking, non-TV) findings, pre-existing in kind; my one added line contributes a single `gap inside display:flex` in `app/page.module.css`, the same vocabulary that file already uses 8 times. |
| `npx tsc --noEmit`, filtered to `app/ lib/ components/` | clean (the unfiltered run reports pre-existing jest-types noise in `__tests__/**`, unrelated to this branch) |

E2E ran on `PORT=3044`, not the default 3040, so it could never touch the dev servers of the sibling worktrees (`t99-runtime`, `t101-landing`, `t103-tv-focus`). Playwright's chromium headless shell had to be installed (`npx playwright install chromium`) — it was absent, so the first e2e attempt failed on a missing browser rather than on anything in the diff.

## Friction

- `npx tsc --noEmit` is not a usable signal in this repo as-is: it type-checks `__tests__/**` without jest globals and emits hundreds of `Cannot find name 'describe'` errors. The real typecheck is `next build`. Worth a `typecheck` script that excludes tests, or jest types in the base tsconfig.
- The Playwright browser was not installed in this worktree's environment; a first-time e2e run costs a 93 MB download before any test can execute.

## Deferred, not done (deliberately out of scope)

Room creation could also issue the host session directly, saving the claim round-trip on the very first hop. I left it alone on purpose: the claim path already covers that moment, and two mechanisms minting the same session is more surface for no behavioural gain. Worth a follow-up only if the extra request shows up as a real latency problem.

## What the full e2e run caught (and why running it mattered)

The first full-suite run failed **12** existing specs. Neither failure class was visible from the unit suite or from my own new spec, and one of them was a real defect rather than a stale expectation.

**1. A real regression: auto-claim silently defeated LOGOUT.** Three `render-and-links.spec.ts` logout tests failed because the creator's 2-year identity cookie let the next admin load claim straight back in after logout. That destroys the one control `lib/host-auth.ts` names as the mitigation for the shared-venue-tablet case — "the next person to pick it up is host for 30 days", with logout as the answer. Fixed with a no-claim marker: logout sets `boraoke_noclaim_<room>` (httpOnly, `/api/host`-scoped, 3-year so it outlives the identity cookie it suppresses), the claim route refuses while it is present, and a successful host-code login clears it so the marker is not a one-way door. Both halves have e2e tests (`deliberate LOGOUT is not undone by auto-claim`, `entering the host code after a logout restores frictionless re-entry`) plus unit coverage of the marker's naming, per-room scoping, and lifetime-vs-identity-cookie ordering.

**2. Stale expectations: nine specs reached the code gate by creating a room.** That is precisely the flow this ticket abolishes, so a creator no longer sees the gate. Rather than weaken those assertions, I made each spec present as the device the gate actually serves — a **non-creator** holding the code — via a new `dropCreatorIdentity(page)` helper that clears only the identity cookie. The specs still test the code path they were written to test.

**3. One more, found by fixing the above:** `/api/host/claim` is POSTed on **every** login-gate render, so its first compile happened mid-test and reset the in-process memory store, wiping the room the spec had just created (`contrast.spec.ts` failed on the login that followed). Warmed in `warmModerationRoutes`, which exists for exactly this documented hazard.

This is the part I would flag to the next Dev: my own new spec was green and the unit suite was green while a security control was broken. Only the full suite said so.

---

# Round 2 — response to the opus REQUEST-CHANGES on PR #81

The review is at `work/reports/reviewer/TICKET-104-review.md`. Two blockers were mine (B1, B2); B3 is the Tech Manager's. Everything below is measured in this worktree.

## B1 — the claim throttle could 429 the creator out of their own room

**The defect, restated so it is not softened.** `AdminRoom` POSTs `/api/host/claim` on *every* session-less admin render, and the route charged a **per-IP** failure **even when no identity cookie was presented**. Ten ordinary admin-URL opens from one public IP inside a minute spent the budget, and the creator's own claim then returned 429 — which `AdminRoom` collapsed into the code gate, i.e. the shown-once, unrecoverable code. So the feature could hand the room's owner exactly the dead end the ticket was filed to remove, and do it silently, from a venue's shared wifi. The bucket *separation* from login was right and worked; the bucket's *scope* was wrong.

**The fix** (`lib/host-auth.ts` + `app/api/host/claim/route.ts`):

1. **A caller with no valid identity cookie is never charged.** They presented nothing and learn nothing from the 401, so it is not an attempt at anything. This removes essentially every incidental charge, including the e2e warm-up's (NB-6, also fixed — it now warms with a malformed room id, which returns 400 before the throttle or the store is touched).
2. **The bucket is keyed on the caller's own identity uuid, not their IP.** One device can no longer spend another device's budget, so a shared NAT is no longer a shared fate.
3. **`AdminRoom` distinguishes 429 from 401** and shows a "too many attempts from this device, wait a minute — you do not need the code for this" notice (`data-testid="claim-throttled-notice"`, new `Admin.claimThrottled` key in all three catalogs) instead of silently presenting the gate.

**Why identity-keyed bucketing is sound here, stated because it would be naive elsewhere.** This route has no guessable secret: the caller cannot supply a uuid, so the only "attack" is sweeping room ids hoping one's `creatorUuid` equals your own — a v4 collision. Rotating to a fresh identity therefore buys an attacker nothing, because a fresh identity owns nothing and matches nothing. The bucket is not an anti-guessing control; it is a cheap bound on one device's pointless retry loop. A caller with no identity cookie is unbounded *here*, which matches the posture of the app's other unauthenticated single-store-read endpoints (`GET /api/rooms?id=`, `GET /api/host/session`); the expensive write path keeps its own throttle. Bucket keys are attacker-suppliable in shape (cookies can be forged by a non-browser client) but bounded in lifetime by the window TTV and in count by `MAX_TRACKED_KEYS`' LRU — the same exposure IP keys already have behind a proxy.

**Regression tests** (`__tests__/host-claim.test.ts`, route-level, because the defect lived in the route's charging decision rather than in the counter): a 40-request session-less flood from the venue IP leaves the creator's claim at 200; another device's 20 failed claims throttle *that device* and leave the creator's budget untouched; a garbage identity cookie is neither charged nor usable as a bucket key; a genuinely exhausted identity gets **429 with `{throttled: true}`**, distinguishably; a successful claim resets only its own bucket.

### B1 — the distribution, not a run

A single green run on a rate-limiter-dependent test is worth nothing; that is precisely how round 1 reported 113/0 on a defect that fails ~40% of the time. So this is measured as a rate, with a **positive control** — the same 3-spec combination (`creator-reentry` + `contrast` + `render-and-links`; the first holds the headline acceptance test, the other two generate the session-less admin renders that spent the budget), fresh dev server per run, `git stash` used to put the *shipped* code back for the control phase.

| Condition | Runs | Failing runs |
|---|---|---|
| **as shipped** (per-IP bucket, charged with no cookie, warm-up charging too) | 5 | **3** |
| **fixed** (identity-keyed, no charge without a valid identity cookie, warm-up returns 400 first) | 8 | **0** |

As-shipped failures were always in `creator-reentry`, 3–4 tests per failing run, always including `the creator reaches admin straight from creation, typing nothing` — the ticket's own acceptance criterion. That reproduces the reviewer's 3-in-7 independently and at a higher rate, because my combination generates more session-less renders than theirs.

The control matters more than the fixed column: it shows the failures were *caused by the throttle scope* and not by a flaky harness, so 0/8 afterwards is evidence of a fix rather than of luck. Per-run detail is in the raw log of this round's distribution script.

## B2 — the "marker is not a one-way door" property was asserted by nothing

Mutant **N2** (delete the marker-clearing block in `POST /api/host/login`) survived the whole suite, because the test called `context.clearCookies()` right after the code login and destroyed the marker cookie itself. Test 4 was named for the property and did not measure it.

Fixed by asserting it *before* the `clearCookies()`, and — per the standing instruction — **the mutant is now in the table below with its kill recorded**, because the gap existed precisely because no mutant covered this mechanism. The table previously had none for the no-claim marker, on the very thing I had flagged as most wanting review.

## Corrections to the round-1 record

Applied inline above, so this file reads as the current record: **NB-1** (M3c is KILLED, and my "belt-and-suspenders" conclusion was unsound and would have invited someone to delete the one guard preventing an HTTP 500 on legacy rooms), **NB-2** (the guard fires on a second case, the affected population was misidentified, and the `listRooms`-error path was destroying the device's real uuid — now returns `ok: false` instead), **NB-4** (stale counts; reverse-check evidence for the two logout tests supplied below).

I also accepted **NB-6** (warm-up), and **NB-3** is recorded as confirmed with the reviewer's stronger argument: `clientKnown` is by construction either the caller's own cookie or the uuid the caller itself just asserted, so the echo cannot disclose anything *independently* of the `ok`-gating on cookie-setting and `creatorUuid` writes. **NB-5** is filed as `work/tickets/TICKET-112-logout-lockout-warning.md` — logout is now a permanent self-inflicted lockout behind a bare `Confirmar`, and the wording is a Tech-Lead call, so I did not choose it.

## Round-2 mutation table — the marker mechanism, and B1

Run against the round-2 tip. E2E mutants run `e2e/creator-reentry.spec.ts` (7 tests); unit mutants run `__tests__/host-claim.test.ts`.

| # | Mutation | Result |
|---|---|---|
| **N1** | claim route no longer CHECKS the marker | **KILLED** — `deliberate LOGOUT is not undone by auto-claim` (1 failed / 6 passed) |
| **N2** | `POST /api/host/login` no longer CLEARS the marker — *the review's SURVIVED-real-gap* | **KILLED** by the repaired assertion — `entering the host code after a logout restores frictionless re-entry` (1 failed / 6 passed). On real code the same test **passes** (7 passed), so it kills the mutant rather than merely passing. |
| **N3** | logout no longer SETS the marker | **KILLED** — `deliberate LOGOUT is not undone by auto-claim` (1 failed / 6 passed) |
| M3c | delete the creator-side guard line entirely (the reviewer's mutation) | **KILLED** — 2 failed / 19 passed, verbatim below |
| M3c′ | weaken it to `typeof creator !== "string"` only | **SURVIVED-equivalent** — the `length === 0` half is genuinely redundant with the identity-side check; the `typeof` half is not, and M3c proves it |
| B1-a | charge the budget even with NO identity cookie (the shipped defect) | **KILLED** — `a garbage identity cookie is not charged either` (1 failed / 20 passed) |
| B1-b | collapse the bucket key so all callers share one (IP-style) | **KILLED** — 4 failed / 17 passed, including the venue-flood and cross-device tests |
| B1-c | return the 429 as a plain 401 (client cannot distinguish) | **KILLED** — `a genuinely exhausted identity gets 429 — DISTINGUISHABLE from a 401` (1 failed / 20 passed) |

M3c verbatim, which is what makes the round-1 label wrong rather than merely imprecise:

```
  ● verifyCreatorClaim — every other caller stays out › rejects a room with NO creatorUuid on record, even when asked with an empty uuid
    TypeError: The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined
  ● verifyCreatorClaim — every other caller stays out › rejects a room that does not exist
    TypeError: The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined
Tests:       2 failed, 19 passed, 21 total
```

## (b) Reverse-check for the two logout tests (NB-4)

Removing the **whole** no-claim mechanism (marker check + set + clear) — the true pre-fix state:

```
    ✓  1 the creator reaches admin straight from creation, typing nothing
    ✓  2 re-entry works with ONLY the identity cookie left (host session gone)
    ✘  3 deliberate LOGOUT is not undone by auto-claim
    ✓  4 entering the host code after a logout restores frictionless re-entry
    ✓  5 a device that did NOT create the room still hits the code gate
    ✓  6 the hero leads with the created room and links into admin
    ✓  7 a first-time visitor sees the generic hero, unchanged
  1 failed, 6 passed
```

**Test 3's reverse-check is that failure.** **Test 4's cannot be a pre-fix revert, and saying so precisely matters:** with no marker mechanism at all, "no marker remains after login" is vacuously true, so test 4 *must* pass against the pre-fix code. Its (b) evidence is therefore the **N2 mutant** — the only mutation that can distinguish it — and N2 is killed above. A reverse-check that comes back green is normally a finding; here it is the expected answer to the wrong question, and the mutant is the right instrument.

## Friction (round 2)

- I wasted a diagnosis cycle chasing a phantom "cross-suite interference" bug: my own background distribution script `git stash`es three files for its positive-control phase, and a jest run I fired during that window was reading pre-fix code. Lesson worth generalising: **never take a measurement against a worktree while a background job is mutating it**, and make such a script announce its stash window loudly.
- An earlier mutation script backed files up by **basename**, so `app/api/host/{claim,login,session}/route.ts` collided and the restore wrote `session/route.ts` over `claim/route.ts`. Caught immediately (the file's own content was obviously wrong) and rewritten, but it could have been committed silently. Backups in any mutation harness must be keyed on the full path.

## Round-2 gate results

| Gate | Result |
|---|---|
| `npx jest` (full) | **53 suites passed, 948 passed / 5 skipped / 953 total** |
| `PORT=3054 npx playwright test` (full), **3 consecutive fresh-server runs** | **113 passed every time — 0 failing runs out of 3** (6.7m / 6.8m / 7.8m). This is the reviewer's condition #1; a single run is deliberately not reported as evidence. |
| B1 distribution, 3-spec combination | as shipped **3 failing runs / 5**; fixed **0 failing runs / 8** |
| `npm run build` → ES2019 + CSS target | `bundle-es-target: OK — all 49 chunk(s) parse at ES2019.` / `css-target: OK — the TV surface uses nothing newer than Chrome 68 (13 stylesheet(s) scanned).` 15 advisory non-TV findings, as before. |
| `npx tsc --noEmit` (filtered to `app/ lib/ components/ e2e/`) | clean, except the pre-existing `e2e/advance-auth.spec.ts` error that is on `main` and unrelated to this branch |

Not run by me, and not mine to run: the App Tester and Cyber Security gates (B3).

---

# Round 3 — response to the Cyber Security REQUEST-CHANGES

Report: `work/reports/cyber/TICKET-104-security-gate.md`. Two blockers, both demonstrated end-to-end in real browsers, and both real. This round **replaces the credential** rather than patching it.

## What I got wrong, stated plainly

My round-1 and round-2 reports asserted that the claim credential was "a cookie page JS cannot read" and that the blast radius of a copied `cantai_patron_uuid` was "zero". **Both were false**, and I asserted them as verified facts in a section headed SECURITY CONTRACT, which is how they propagated through a reviewer's endorsement and a TM's relay upward. The gate exfiltrated the value with one `fetch`, replayed it from a different browser profile, and took real host control of a room — and the victim's logout provably did not revoke it.

The specific thing I failed to check: I reasoned about the *cookie's* attributes (httpOnly, path-scoped) and never asked whether the cookie's **value** was obtainable by other means. It was, twice over — `POST /api/identity` echoes it in a response body, and `cantai_patron_uuid` mirrors it in localStorage on every room visit, which `/new` then sends as `patronUuid` so it *becomes* `creatorUuid`. httpOnly on a value the server hands out elsewhere is decorative.

## The redesign: a purpose-built credential

The root cause is structural, exactly as the gate said: the identity uuid is *required* to be client-readable (own-row highlighting, the `?uuid=` pending poll) and was *required* to be secret (the claim). One value cannot be both. So the claim now has its own.

| | Round 2 (broken) | Round 3 |
|---|---|---|
| Credential | the identity uuid, = `creatorUuid` | a 256-bit CSPRNG token, `boraoke_claim_<room>` |
| Reachable by page JS | **yes** — `/api/identity` echo + localStorage mirror | **no** — never in a response body, never in localStorage, never a request parameter |
| At rest | compared against `creatorUuid` in plaintext | only `hashClaimToken` hashes, in `Room.claimTokenHashes` |
| Revocation | a marker cookie in the **victim's own jar** — revoked nothing for a copier | **server state**: logout clears the hashes, so every copy dies |
| Lifetime | 3 years, reasoned against another cookie's 2 years | 180 days, **rolling**, no cross-cookie comparison at all |
| `creatorUuid`'s role | the credential | back to being a non-secret ownership label |

Lifecycle: room creation mints one and sets the cookie (never in the 201 body); a successful claim and a verified session probe roll it; **logout revokes every token server-side**; a successful host-code login mints a **fresh** one, so a revoked credential stays dead while the legitimate owner gets frictionless re-entry back. Tokens are a capped list (`MAX_CLAIM_TOKENS = 5`) so a venue can hold the credential on the tablet *and* the owner's phone — which one hash could not do without silently killing the other device.

**B-S2 — logout is now authenticated.** `POST /api/host/session` requires `requireHost`, so a cross-site top-level POST is a 401 that changes nothing: no cookie planted, no token revoked. This is the fix the gate asked for, and the reason it belongs in this PR rather than in TICKET-115 is that this PR is what turns an unauthenticated logout from a recoverable nuisance into a permanent lockout.

**O3 dissolves rather than being re-tuned.** No number was picked to beat another cookie's lifetime; correctness lives in server state, and the cookie is simply bounded (180 days) and rolling so an active venue never ages out. The no-claim marker is deleted entirely, which also removes O5 (page JS could plant a marker) by construction.

**O1/O2 — the throttle keyspace.** The key is back to the server-derived client IP, so a caller cannot invent bucket keys and evict the login throttle from the shared LRU. That does **not** reintroduce B1's shared fate, because the shape changed: the route **verifies the credential first and only consults or charges the budget after a failure**, so a live credential is never subject to it, and a caller presenting no credential is never charged at all (no store read either). B1's property is now held by a stronger mechanism than re-keying.

**O4 — correcting the record, as asked.** My earlier claim that the adoption guard "is what keeps the answer zero" was wrong: the secrecy of the uuid was, and the uuid was not secret — knowing it was sufficient *without* adoption, because the claim route read it straight from the Cookie header. The guard is kept (it still prevents obtaining a *legitimately issued* durable identity cookie, and prevents store pollution) but it is not load-bearing for this feature, and it carries a real patron-continuity cost.

## Tests that would have caught both blockers

Their absence is why two rounds of review missed this, so they are the centre of this round. Neither is expressible as a unit test: one needs a second browser profile, the other a second origin.

- **`the claim credential cannot be exfiltrated and replayed (B-S1)`** — the victim's page scrapes *everything* JS can reach (`document.cookie`, every localStorage key, the `/api/identity` echo), asserts the claim credential is in none of it, then replays every credential-shaped scrap from a **different browser context** as each cookie name the app uses. The claim must 401, `POST /api/host/moderation` must 401, and no dashboard may render.
- **`a cross-site top-level POST to logout changes nothing (B-S2)`** — a page served from a **different origin** (`http://evil.test`, fulfilled by route interception so the POST still hits the real server) auto-submits a form to the logout endpoint. The owner's claim must still be 200 afterwards.

### (b) Reverse-check — both new tests against the round-2 (vulnerable) code

`git stash` of the six changed source files, the spec unchanged:

```
  ✓   1 the creator reaches admin straight from creation, typing nothing
  ✘   2 re-entry works with ONLY the claim cookie left (host session gone)
  ✓   3 deliberate LOGOUT is not undone by auto-claim
  ✘   4 entering the host code after a logout restores frictionless re-entry
  ✓   5 a device that did NOT create the room still hits the code gate
  ✓   6 the hero leads with the created room and links into admin
  ✓   7 a first-time visitor sees the generic hero, unchanged
  ✘   8 the claim credential cannot be exfiltrated and replayed (B-S1) › everything page JS can see is NOT enough to claim the room
  ✘   9 a third-party page cannot lock the creator out (B-S2) › a cross-site top-level POST to logout changes nothing
  ✓  10 the owner's OWN logout still works, and still sticks
  4 failed, 6 passed
```

**Tests 8 and 9 fail against the vulnerable code — each catches its own blocker.** Tests 2 and 4 fail because the credential does not exist in round 2 (expected). Test 10 passes in both, correctly: the round-2 marker also made logout stick from the *victim's* point of view — which is precisely why test 10 alone was never evidence, and why the revocation test below exists.

### (a) Mutations — 8 run, 8 killed

| # | Mutation | Result |
|---|---|---|
| S1 | claim route trusts the identity cookie again (**recreates B-S1**) | **KILLED** — 9 failed / 16 passed |
| S2 | logout drops `requireHost` (**recreates B-S2**) | **KILLED** — all 3 B-S2 tests |
| S3 | logout clears cookies but does not revoke server-side | **KILLED** — `a token COPIED off the device stops working once the owner logs out` |
| S4 | host-code login mints no fresh credential | **KILLED** — `entering the host code after a logout mints a FRESH token` |
| S5 | room creation leaks the token in the 201 body | **KILLED** — `puts it in NO response body` |
| S6 | an empty hash list counts as a match (every legacy room becomes claimable) | **initially SURVIVED — real gap**, now **KILLED**; see below |
| S7 | claim consults the throttle **before** verifying (recreates B1's shared fate) | **KILLED** — `a SPENT budget on the creator's own IP still lets a valid token through` |
| S8 | throttle keyed on the client-chosen token instead of the IP (recreates O1) | **KILLED** — 2 tests, including the keyspace one |

**S6 was a SURVIVED-real-gap and I fixed it rather than arguing it.** The suite only ever saw `claimTokenHashes` **absent** (revocation deletes the key; creation never writes `[]`), so a mutation treating an *empty* list as a match went unnoticed — and that mutation makes every legacy room claimable by anyone. Closed with a test that writes `claimTokenHashes: []` straight to `roomBackend`, the same technique the `default`-room and blank-creator guards needed. Re-run with that test present: **1 failed / 25 passed** — killed.

### (c) Hollowing-out declaration

**A primitive beneath existing assertions changed, and one assertion HAD been hollowed.** The no-claim marker was deleted, so the round-2 assertion `expect(cookies).not.toContain('boraoke_noclaim_<id>')` — the one I added in round 2 to close B2 — became **true by construction**: with no marker mechanism at all it passes with the login route granting nothing. I found it by re-reading every assertion that named the removed mechanism, and re-pointed that test at the property that now carries the meaning: a correct host code must **mint a fresh, httpOnly claim credential**, asserted *before* the `clearCookies()` that would destroy it. S4 confirms the replacement is live.

Also re-examined and re-pointed: `keepOnlyIdentityCookie` → `keepOnlyClaimCookie` (keeping only the identity cookie would now be a test of nothing, since the identity uuid is deliberately worthless here), and the "deliberate LOGOUT" test's rationale comment, which described a mechanism that no longer exists.

### (d) Triggered mutation pass

`triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path`

`hashClaimToken` and `verifyRoomClaimToken` are on an identity path but neither parses nor normalises user input — one hashes an opaque value, the other compares hashes. The clause does not fire. S1/S6/S8 above mutate them anyway, because this is auth code.

## Friction (round 3)

- The B-S1 test cost me four diagnostic cycles to an artifact, not a bug: the dev server's in-process memory store is dropped whenever a route compiles for the first time, and this test is the first thing in the suite to touch `POST /api/identity` and `POST /api/host/moderation`. The room 404'd mid-test while the security property was holding perfectly. Warming both routes helped; the durable fix was to move the `/api/identity` scrape **before** room creation so the reset cannot land on the critical path. Two assertions in that test are now deliberately phrased as absences (`dashboard` count 0) rather than presences (`code gate visible`) for the same reason — the positive "a non-creator sees the gate" claim is kept as its own separate passing test, so nothing was weakened to make anything pass.
- My mutation harness bit me a second time in the same way as round 2: full-path backup keys are now mandatory in it, and the round-2 basename collision would have silently committed a wrong file.

---

# Round 4 — picking up from a Dev that stopped mid-round

I am a fresh Dev. The previous one stopped during a network outage, mid-sentence, having said "Fixed. Re-launching the distribution now that the helper is correct". So the first job was establishing what state the branch was actually in, before believing anything the log or that sentence implied.

## Step 0 — what I actually found (reconciliation)

**The round-3 work was complete and uncommitted.** ~1,020 insertions across 10 files sat in the working tree with **nothing staged and nothing committed**: `git log origin/ticket/104-creator-admin..HEAD` was empty in both directions, so the branch tip equalled the remote and the entire redesign existed only on disk. Had that worktree been cleaned up, round 3 would have been lost in full. It is committed now.

**No stash, and no corruption from either reported hazard.** Checked specifically, because both hazards the previous Dev reported would have left silent damage:

- **The basename-collision hazard did NOT recur.** Round 3's harness (`t104r3mut.py`) keys its backups on the full path (`app__api__host__claim__route.ts`), which is the fix for the round-2 collision that restored `session/route.ts` over `claim/route.ts`. I verified the outcome rather than trusting the code: all six mutated files are **byte-identical** to their pre-mutation backups in `…/scratchpad/t104r3b/`, and I then read all four route files end-to-end to confirm each contains its own route and not a neighbour's. `git stash list` is empty; no `.bak`/`.orig`/`.rej` anywhere in the tree; no live `next dev`, jest or playwright process, and nothing listening on 3050-3060 or 3130-3139. The tree was clean and unmutated.
- **The measure-while-mutating hazard DID recur, and it invalidated the round-3 distribution.** `/tmp/t104r3dist2.log` is the run that sentence launched. Its combination phase is fine — 6/6 pass, ~2.5 min each. Its full-suite phase is garbage and must not be read as a result: **5.3h, 6.9h and 7.0h of wall clock** for a suite that takes minutes, 26-32 failures per run, and among them `contrast math sanity › black text on white background resolves to 21:1`. That assertion is pure arithmetic on two constants; it cannot fail for a logic reason, so its failure is a measurement artifact, not a finding. Three concurrent worktrees (`t99`, `t101`, `t108`) plus the harness were live on this machine overnight. **I discarded that distribution entirely and re-measured** (§ Gates below) rather than trying to interpret it.

One process note while I am on it: the round-3 reverse-check was done with `git stash`. The stash stack is shared across every worktree in this repo, so that is not a safe instrument here — a temporary WIP commit is. It did no harm this time (the stack is empty and the six files verified clean), but I did not reuse the technique.

## What round 4 changes, and what it deliberately does not

**The round-3 redesign is right and I did not relitigate it.** The purpose-built `boraoke_claim_<room>` credential, hashes-at-rest, server-side revocation on logout, the 180-day rolling bound, `creatorUuid` demoted to a label, and the throttle re-shaped to verify-then-charge on a server-derived key — that is the direction the gate asked for, it is implemented coherently, and the gate's B-S1/B-S2/O1/O3/O4 are all answered by it. Four things were still missing or wrong, all found by reading rather than by a failing test.

**1. The same-origin check the gate's direction asked for was never added (B-S2, second layer).** Round 3 added `requireHost` and stopped. That alone does defeat the measured attack — a cross-site top-level POST carries no `SameSite=Lax` cookie — but the specification asks for authentication **plus** a same-origin/CSRF check, and the reason to want both is the lesson of this whole PR: a property resting on one unexamined mechanism is a property nobody has verified. A future `SameSite=None`, a browser quirk, or a same-site-but-not-same-origin subdomain each quietly re-opens the route. Added `isCrossSiteRequest` (`lib/host-auth.ts`) and wired it into `POST /api/host/session` as a second, independent refusal.

It is deliberately **fail-open on absent provenance**, which is a considered trade and is argued in the code: `Sec-Fetch-Site` is unforgeable by page JS and distinguishes exactly the top-level-navigation case the gate exploited, `same-site` passes alongside `same-origin` so an apex/`www` split cannot break the shared-venue tablet's real logout, and a client that sends neither header is a non-browser client (curl, this repo's own unit suite) that cannot be told apart from a browser withholding them — while the attacker, being a browser, always sends them and is in any case already stopped by `requireHost`. Absence is not the attack shape; a stated foreign origin is.

**The no-oracle property is now asserted rather than assumed.** Both refusals return the identical 401 body, and `requireHost` is already false for an unknown room as well as for a wrong session, so the route adds no room-existence signal. There is a test for it (M5 below).

**2. Three comments still asserted the premise the gate disproved.** This is the exact defect the gate called out by name — "a contract comment should name the property's evidence or be marked as an assumption, or it hardens a wrong belief for the next reader" — and round 3 fixed the code while leaving three statements of the false premise in the tree, in the places a future reader is most likely to trust:

- `app/(patron)/[room]/admin/AdminRoom.tsx` — claimed the route "mints a session when the device's httpOnly `boraoke_identity` cookie matches the room's `creatorUuid`", and that "the uuid travels as a cookie the client cannot read". Both false, and the second is verbatim the sentence the gate falsified.
- `e2e/creator-reentry.spec.ts` header — "The proof is the httpOnly `boraoke_identity` cookie matched against the room's `creatorUuid`".
- `lib/identity.ts` — the adoption-guard docblock still said `room.creatorUuid` grants a host session, and still called the guard "load-bearing, do not relax". This one is O4 in a second location: the gate asked for the over-credit to be corrected, round 3 corrected it in the dev report but not in the code comment that a future reader would actually reach. Rewritten to state what the guard does buy (no legitimately-issued cookie for someone else's uuid, no store pollution) and what it does not (admin access).

I verified by an independent sweep that `room.creatorUuid` now has **zero non-comment reads** anywhere in `app/` or `lib/` — the only privileged gates are `requireHost` (session cookie) and `verifyClaim` (claim token), neither of which touches an identity uuid. So the comments were the only thing left asserting it.

**3. One new assertion was vacuous.** The B-S1 e2e test closed with `expect([200, 401]).toContain(victimClaim.status())`, written to absorb the dev store's documented reset. It accepts every status the route can return, so it cannot fail and is not evidence — and worse, it made the test read as covering one more property than it does. Removed, with the reasoning left in place, because the property is real and is pinned where it *can* fail: the B-S2 cross-site test asserts the owner's claim is exactly 200 after an attack, and "re-entry works with ONLY the claim cookie left" asserts it directly.

**4. The round-3 e2e distribution was re-measured from scratch** (see § Gates).

## (a) Mutations — 5 run, 5 killed, each by the right assertion

Harness: `…/scratchpad/t104r4mut.py`, full-path backup keys, restore-and-reverify after every mutant. Baseline both suites: **65 passed**.

| # | Mutation | Result |
|---|---|---|
| M1 | logout drops the cross-site check, **keeping `requireHost`** (i.e. the tree exactly as I received it) | **KILLED** — 2 failed / 63 passed: `a valid session presented from ANOTHER SITE…`, `a valid session with a FOREIGN Origin…` |
| M2 | `isCrossSiteRequest` never fires (always reports same-site) | **KILLED** — same 2 |
| M3 | `isCrossSiteRequest` refuses **everything** (would break the real logout) | **KILLED** — 4 failed / 61 passed, incl. `the owner's OWN same-origin logout still works — the shared-tablet path` and the two revocation tests |
| M4 | the `Origin` fallback is dropped (clients that send Origin but not `Sec-Fetch-Site` unprotected) | **KILLED** — 1 failed: `a valid session with a FOREIGN Origin…` |
| M5 | logout 404s an unknown room (becomes an existence oracle) | **KILLED** — 2 failed, incl. `is not a room-existence oracle — a real room and a made-up one reply identically` |

M1 and M3 are the pair that matters, and they bracket the check from both sides: M1 proves the new tests fail when the check is absent, M3 proves they fail when it over-refuses. **M3 is why the three new refusal tests use a session that is genuinely VALID.** The three pre-existing B-S2 tests all present a caller with no valid session, so `requireHost` alone refuses them and every one of them stays green with the provenance check deleted — they are tests of `requireHost`, not of this. Only a valid-session-plus-foreign-origin case can distinguish the two mechanisms, and that is what the new ones are.

Restored, baseline re-verified: **65 passed, 65 total.**

## (b) Reverse-check against the pre-fix implementation

For this round's change the pre-fix implementation **is** M1 — the tree as the previous Dev left it, `requireHost` present and no provenance check — so M1's output is the reverse-check, verbatim:

```
=== M1 logout drops the cross-site check, keeping requireHost (the gap I am closing)
    Tests:       2 failed, 63 passed, 65 total
    ● logout is AUTHENTICATED, so nobody can lock the owner out (B-S2) › a valid session presented from ANOTHER SITE cannot log the room out
    ● logout is AUTHENTICATED, so nobody can lock the owner out (B-S2) › a valid session with a FOREIGN Origin cannot log the room out either
```

Round 3's reverse-check of the two e2e blocker tests against the round-2 (vulnerable) code stands as recorded above — 4 failed / 6 passed, with tests 8 and 9 each failing on its own blocker. I did not redo it; the code it ran against is unchanged by this round, and re-running it would have required mutating the tree while the distribution was measuring it, which is the mistake that cost round 3 its distribution.

## (c) Hollowing-out declaration

**A primitive beneath existing assertions changed, and I re-examined the assertions over it.** `POST /api/host/session` gained a second refusal condition, so every existing assertion about a refused logout now has two possible causes and could pass with either guard deleted.

- The three pre-existing B-S2 tests (`a cookie-less POST…`, `a WRONG session value…`, `another room's valid session…`) **are** now hollowed with respect to the new check — each would pass with `isCrossSiteRequest` deleted, because none of them presents a valid session. That is correct and intended: they are `requireHost`'s tests and they still fail when `requireHost` is removed (round 3's S2 mutant). I did not repoint them; I added the three valid-session tests that the new check *can* be the only cause of, and M1/M3 demonstrate the separation. The hazard here is not a dead assertion, it is mistaking those three for coverage of the new layer — hence this paragraph and the comment above them in the test file.
- `logout clears the cookie with maxAge 0 on the matching path` (TICKET-76) and the two revocation tests pass through the new condition on their success path; M3 and M5 confirm they are live rather than true-by-construction.

## (d) Triggered mutation pass

`triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path`

`isCrossSiteRequest` reads two headers and compares a URL host. It parses nothing the app then uses as data, normalises no user input, and computes no money/quantity/identity value — the `new URL()` call is a validity test whose failure is treated as hostile, not a parse whose output is retained. M1-M4 mutate it regardless, because it is auth code.

## A fifth finding, found by reading the design claim back against the code

Round 3's report says, of the capped token list: "Tokens are a capped list (`MAX_CLAIM_TOKENS = 5`) so a venue can hold the credential on the tablet *and* the owner's phone — which one hash could not do without silently killing the other device."

**That was false as implemented, and it fails in the direction that matters.** Every roll *appended* a hash, so `slice(-MAX_CLAIM_TOKENS)` pushed the OLDEST entry off — and the oldest entry belongs to a different device. I probed it before changing anything:

```
  ✘ PROBE: does rolling one device's token evict another device's?
    expect(await verifyRoomClaimToken(id, tablet)).toBe(true)
    Expected: true
    Received: false
```

Concretely: the room is created on the owner's phone, the bar tablet is set up with the host code, and then the owner opens `/admin` five more times. The tablet's credential is gone, and it lands on the shown-once unrecoverable host code — **the exact dead end this ticket exists to remove, delivered by the mechanism whose stated purpose was to prevent it.** The cap read as protecting multi-device support while destroying it. It is not a security hole (nothing gains access; a device loses it), which is why neither the reviewer nor the security gate would have been looking for it — but it breaks the ticket's own acceptance criterion for any venue with two devices.

Worth naming the general shape, because it is the third time on this PR: **the report asserted a property the code did not have, in a sentence confident enough that nobody re-derived it.** B-S1 was that ("a cookie the client cannot read"), O4 was that ("what keeps the answer zero"), and this was that. The fix each time is the same — assert the property in a test that can fail.

**The fix is rotate-in-place.** `issueRoomClaimToken` takes `replacing`: on a roll it drops the presented token's hash and writes the new one, so a device reuses its own slot rather than consuming a new one. `rollClaimCookie` is the roll-site helper (`POST /api/host/claim`, and a verified `GET /api/host/session`); room creation and host-code login keep plain `attachClaimCookie`, because those are a device's *first* token. The cap still binds across distinct devices, and a rolled-away token is still dead.

### Mutations for it — 5 run, 5 killed, but only after fixing a real gap

| # | Mutation | Result |
|---|---|---|
| R1 | rotation **appends** instead of replacing (= the pre-fix implementation) | **KILLED** — 3 failed / 31 passed |
| R2 | the claim route rolls with `attachClaimCookie` again (wrong helper at a roll site) | **KILLED** — 2 failed |
| R3 | the **session probe** rolls with `attachClaimCookie` again | **initially SURVIVED — real gap**, now **KILLED** |
| R4 | rotation replaces but the cap is removed | **KILLED** — 2 failed, incl. the pre-existing cap test |
| R5 | rotation drops the **whole** list rather than this device's entry | **KILLED** — 2 failed |

**R3 was a SURVIVED-real-gap and is the most important line in this table.** My first three tests all drove the *claim route*, so a regression that hit only the session-probe roll site passed the entire suite — and the probe is the busier of the two sites by a wide margin (every admin page load and every landing-page `SavedRooms` check), so it is the one that would actually evict a venue's tablet in production. Closed with a test that drives `GET /api/host/session` directly; R3 now fails 1 test. Per the skill this is blocking rather than a nit, so it is fixed in-PR, not deferred.

**(b) Reverse-check for this fix** is R1 — the append-always implementation is literally the pre-fix code:

```
=== R1 rotation APPENDS instead of replacing (the pre-fix implementation = reverse-check)
    Tests:       3 failed, 31 passed, 34 total
    ● the capped list holds DEVICES, so one device's re-entry never evicts another › a phone re-entering many times does not push the bar tablet's credential off
    ● the capped list holds DEVICES, so one device's re-entry never evicts another › a rolled-away token is dead — rotation still revokes the value it replaced
    ● the capped list holds DEVICES, so one device's re-entry never evicts another › the SESSION PROBE's roll does not evict another device either
```

**(c) Hollowing-out, second pass.** `issueRoomClaimToken`'s list-maintenance primitive changed (append → replace-then-append), so I re-read every assertion over `claimTokenHashes`. The pre-existing `holds the credential for several devices, capped, and logout clears them ALL` still fails under R4, so it is live rather than true-by-construction; it exercises distinct-device issues, which the fix deliberately leaves unchanged. The `a successful claim ROLLS the credential` test is unaffected in meaning (it asserts the new token works and differs), and R2 confirms it is not the thing covering eviction — that needed the new tests.

**(d)** `triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path`. The `replacing` path hashes an opaque token and filters a list of hashes; it parses and normalises nothing.

One judgment call recorded: I also corrected two comments that overstated what the code did — the claim route's SECURITY CONTRACT listed only two write sites (there are now two more via the roll helper) and `MAX_CLAIM_TOKENS`' docblock said "the oldest falls off" without saying oldest *device*. Both are the same defect class as B-S1's false contract line, so I did not leave them for a later round.
