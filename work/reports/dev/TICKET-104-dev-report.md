# TICKET-104 — Dev report

**Status:** round 2 complete — B1 and B2 fixed, all report corrections applied. Gates: jest **53 suites / 948 passed / 5 skipped / 953 total**; full Playwright **113 passed, 0 failing runs out of 3 consecutive fresh-server runs**; ES2019 + CSS-target floor gates OK. B3 (App Tester, Cyber Security) is the Tech Manager's. See `## Round 2` at the end of this file; the corrections the review asked for are applied inline above it, so this file reads as the current record rather than a patchwork.
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

I also accepted **NB-6** (warm-up), and **NB-3** is recorded as confirmed with the reviewer's stronger argument: `clientKnown` is by construction either the caller's own cookie or the uuid the caller itself just asserted, so the echo cannot disclose anything *independently* of the `ok`-gating on cookie-setting and `creatorUuid` writes. **NB-5** is filed as `work/tickets/TICKET-111-logout-lockout-warning.md` — logout is now a permanent self-inflicted lockout behind a bare `Confirmar`, and the wording is a Tech-Lead call, so I did not choose it.

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
