# TICKET-104 — Reviewer report (D-022 opus gate)

**PR:** #81 — `ticket/104-creator-admin` → `main`
**Reviewed tip:** `989849aed9f0efe06eb93b5ed83263dda1fc32ac` (== `origin/ticket/104-creator-admin`; base `dffe7c6`)
**Worktree:** `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t104-creator-admin`
**Reviewer:** opus pass
**Verdict:** **REQUEST-CHANGES** — 3 blockers (one of them a production defect I measured), 6 non-blocking findings.

`triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path` (agreeing with the Dev's own call: `verifyCreatorClaim` sits on an identity path but is a comparison, not a parser. I ran a mutation pass on it anyway, plus three mutants the Dev did not run.)

---

## What this PR is, and the one sentence that matters

Before this PR `room.creatorUuid` was stored and authorised nothing. After it, `creatorUuid` grants a host session through `POST /api/host/claim`, keyed on the httpOnly `boraoke_identity` cookie. **An identity became a credential**, so I reviewed it as an authentication change.

The mechanism choice is right, and better than the ticket's own framing of it — see "Mechanism assessment". The problems below are not in the choice; they are one production availability defect in the throttle, one blind test, and a missing gate.

---

## Verified by EXECUTION (not by reading)

Everything in this section I ran myself in this worktree. Commands and their output are summarised; the tree was restored to the reviewed tip after every mutation (`git status --porcelain` empty, confirmed).

### Live adversarial probe against a running app (`next dev -p 3050`)

All routes warmed first, so no first-compile memory-store reset could invalidate a result (my first attempt *was* invalidated that way — see NB-6).

| # | Probe | Result |
|---|---|---|
| 1 | creator creates room | `creatorUuid` = identity cookie value |
| 2 | **creator claims** | **200** `{authed:true}` + `Set-Cookie: cantai_host_<room>=…; Path=/api/host; Max-Age=2592000; HttpOnly; SameSite=lax` |
| 3 | **patron with its OWN identity, knowing only the room id** | **401**, `set-cookie` count **0** |
| 4 | no cookies at all | **401** |
| 5 | patron injects the creator uuid in **query AND body** (`?uuid=`, `?identity=`, `{uuid,legacyUuid,identityUuid}`) | **401** — the route reads none of them |
| 6 | **one-request takeover:** `POST /api/identity {legacyUuid: <creator uuid>}` then claim | identity cookie minted as a **fresh** uuid (`320dade8…`, ≠ victim `9bb35b7f…`); claim **401** |
| 7 | same via the other minting caller, `POST /api/rooms {patronUuid: <creator uuid>}` | fresh uuid `df2bfe4b…`; claim **401** |
| 8 | logout → re-claim | marker set (`boraoke_noclaim_<room>`, httpOnly, `/api/host`, expiry 2029); claim **401** |
| 9 | **wrong-code login must not clear the marker** | login **401**, marker still present, claim **401** |
| 10 | correct-code login | marker cleared (0 rows in jar), claim **200** |
| 11 | marker is per-room | second room's claim **200** while room 1 is marked |
| 12 | 10 failed claims from one IP, then the creator's own claim | **429** for the creator; host-code login still **200** → see **B1** |

**The adversarial answer the ticket demanded, tested rather than read (probe 3 + 5):** a patron holding the room id gets nothing. No `set-cookie`, no information, and no body/query input reaches the decision. Confirmed.

**The takeover the Dev disclosed is genuinely closed (probes 6 + 7)** — both cookie-minting callers refuse to adopt a uuid that owns rooms, live.

### Mutation pass I ran independently

| # | Mutation | Result |
|---|---|---|
| M3c | delete ONLY the creator-side blank guard in `verifyCreatorClaim` | **KILLED** (Dev reported SURVIVED-equivalent — see NB-1) |
| hollow-1 | revert `resolveIdentity`'s fail-open to `return { uuid: candidate, ok: false }` | **KILLED** by the pre-existing *"fail-open: a throwing store never throws"* assertion → the hollowing-out declaration is **accurate**, the old assertion still discriminates |
| N1 | delete the `hasNoClaimMarker` check in the claim route | **KILLED** by e2e *"deliberate LOGOUT is not undone by auto-claim"* (1 failed / 6 passed) |
| N3 | logout no longer **sets** the marker | **KILLED** by the same e2e test |
| **N2** | **`POST /api/host/login` no longer clears the marker** | **SURVIVED — real gap.** 7/7 e2e green, 943/943 unit green → **B2** |

### Suites

- `npx jest` (full): **53 suites, 943 passed / 5 skipped / 948 total** — green.
- `PORT=3050 npx playwright test e2e/creator-reentry.spec.ts` in isolation: **7 passed**.
- `PORT=3050 npx playwright test` (full): **112 passed, 1 failed** — `creator-reentry.spec.ts:77` ("the creator reaches admin straight from creation, typing nothing"). The Dev reported 113/0; not reproducible here → **B1**.

---

## BLOCKERS

### B1 — The claim throttle denies the feature to legitimate creators on a shared IP. Measured, and it is a production defect, not a test flake.

**What I measured (probe 12).** Ten failed claims from one IP spend the `hostclaim:<ip>` budget (10 / 60s), and the *creator's own* claim then returns **429**. `AdminRoom.checkSession()` reads only `r.ok`, so a 429 is indistinguishable from a rejection and the creator lands on the code gate — the shown-once, unrecoverable code, i.e. exactly the HIGH-priority dead end this ticket exists to remove.

**Who spends the budget.** Not attackers — ordinary traffic. `AdminRoom` POSTs `/api/host/claim` on **every** session-less admin render, and `app/api/host/claim/route.ts` charges a failure even when the request carries **no identity cookie at all**. So ten session-less loads of `/<room>/admin` from one public IP inside a minute is enough. A venue behind one NAT, a bookmarked or shared admin URL, a staff phone and a tablet on the same wifi — all of it counts against the creator.

**Concrete failure scenario.** Bar's tablet and the owner's phone share the venue wifi. Someone has the admin URL in their history and opens it a few times; a couple of staff do the same. The owner opens `/<room>/admin`: 429 → code gate → they never wrote the code down → no way into their own room until the window rolls. Silent, and it looks exactly like the feature not working.

**Interventional evidence that this is really what is happening, not a coincidence** (same 3-spec combination, fresh dev server each run):

| Condition | Runs | Failures |
|---|---|---|
| claim throttle as shipped | 7 | **3** (incl. the full-suite run, and one run with 4 failures) |
| `CLAIM_THROTTLE_OPTS.max` raised to 100000, nothing else changed | 3 | **0** |

The failing test is always the headline acceptance criterion — "the creator reaches admin straight from creation, typing nothing". `contrast.spec.ts` generates roughly the volume of session-less admin renders that a handful of real patrons would; that is why the suite reproduces it.

The bucket **separation** from login is correct and does what it was designed to do (login stayed 200 throughout probe 12). The defect is the bucket's **scope**, not its separation.

**Directions (the choice is the Dev's):**
1. Do not charge the budget when the request carries **no valid identity cookie** — a caller without one learns nothing from a 401, so those requests are not guessing. This alone removes virtually every incidental charge.
2. Bucket on the identity uuid rather than the IP, so one device's probing cannot deny another device's claim.
3. Have `AdminRoom` attempt the claim only when `room-memory` says this device created the room. Good defence-in-depth, but not sufficient alone — an attacker controls their own client.
4. Whatever is chosen, `AdminRoom` should distinguish 429 from 401 rather than collapsing both into "gate".

Needs a regression test that pins the property: incidental session-less traffic must not be able to 429 a legitimate creator's claim.

### B2 — SURVIVED-real-gap: the "marker is not a one-way door" property is not asserted by anything.

Mutant **N2** — delete the marker-clearing block in `app/api/host/login/route.ts`:

```ts
res.cookies.set(hostNoClaimCookieName(roomId), "", { path: HOST_COOKIE_PATH, maxAge: 0 });
```

…leaves **all 7 `creator-reentry` tests green and all 943 unit tests green**. The suite cannot tell the fixed code from the broken code on this path.

**Root cause.** `e2e/creator-reentry.spec.ts:162` calls `context.clearCookies()` right after the code login, which destroys the `boraoke_noclaim_<room>` cookie *itself*. The test therefore cannot distinguish "the login cleared the marker" from "the test cleared it". Test 4 is named for the property and does not measure it.

The code is correct today (probe 10 proves the clearing works). The defect is in the test, which is precisely the failure class `prove-your-test-can-fail` exists for, and the severity floor makes a SURVIVED-real-gap blocking rather than a nit.

**Concrete failure scenario.** A later refactor touches the cookie path or drops that line — a `HOST_COOKIE_PATH` change, a tidy-up of the login response, a merge resolution. Nothing goes red. Every creator who has ever logged out of a room is then permanently at the code gate for that room: the marker lives 3 years, the host code is unrecoverable, and the ticket's dead end is back — silently, for the owner of the room.

**Fix, which I verified both ways.** Insert, after the code login and *before* the `clearCookies()`:

```ts
expect((await page.context().cookies()).map((c) => c.name)).not.toContain(
  `boraoke_noclaim_${id}`,
);
```

- With N2 applied: **FAILS** — `Received array: ["cantai_host", "boraoke_noclaim_bar-volta-por-cima", "cantai_host_bar-volta-por-cima", "boraoke_identity"]`.
- On the real code: **PASSES**.

So it kills the mutant rather than merely passing. (A path mismatch on the clear would also fail it, since the stale cookie would survive at its own path.)

Related reporting gap, worth fixing in the same pass: the Dev's 9-mutant table contains **no mutant at all** for the no-claim marker — the mechanism the Dev itself named as what it most wanted reviewed. I supplied N1/N2/N3; two of the three sides are covered, the third was not.

### B3 — Precondition: no App Tester gate and no Cyber Security gate exist for this ticket.

`find work -name "*104*"` returns only the ticket, the plan, the dev report and the event log. There is no `work/reports/test*/TICKET-104-*`, no `work/reports/security/TICKET-104-*`, and no evidence directory. The PR's own gate checklist leaves both unchecked, and the Dev explicitly asks for one of them: *"Cyber Security PASS — **please run this one; it is an authentication change**"*.

Evidence-free approval is forbidden for this role, and my own adversarial probe is not a substitute for the security gate on a change that turns an identity into a credential. This is for the Tech Manager to clear, not the Dev — but it blocks the merge either way.

---

## NON-BLOCKING findings

**NB-1 — M3c is KILLED, and the equivalence argument for it is unsound.** The Dev reports M3c (delete only the creator-side blank guard) as `SURVIVED-equivalent`. I applied that exact mutation and it **fails 2 tests**: *"rejects a room with NO creatorUuid on record…"* and *"rejects a room that does not exist"*, both with `TypeError: The "data" argument must be of type string… Received undefined` from `createHmac().update(b)` at `lib/host-auth.ts:153`.

The stated argument — *"with the identity-side guard present, a blank `creator` can never be compared because a blank `identityUuid` has already returned false"* — does not hold: the killing case is a **non-blank** identityUuid against an **absent** creator, which the identity-side guard does not touch. And the conclusion it invites is worse than the error: the creator-side guard is **not** belt-and-suspenders. It is the only thing standing between a creatorless room and an unhandled `TypeError` → **HTTP 500** on every claim against a legacy room. Please correct the report text and re-label M3c `KILLED`; the record is what a future writer will read before deciding the guard is redundant.

No code change needed. Not blocking because the suite already kills it — the defect is in the durable record's reasoning.

**NB-2 — "the ONLY case the guard fires on" is inaccurate; there is a second, and its cost is larger than stated.** The guard also fires whenever `store.listRooms` **throws** (the fail-closed `catch`), and then it refuses adoption for *every* asserted uuid, including patron-only uuids that own nothing. That path returns `ok: true` with a substitute uuid, and `PatronRoom.tsx:115-121` **writes the substitute into `cantai_patron_uuid`**, discarding the device's real uuid permanently. So a transient rooms-index error costs those patrons their own-row highlighting and their pending-submissions view, irreversibly — not the "best-effort continuity" the report describes.

The trigger set is narrow (only a device with a localStorage uuid and no valid identity cookie reaches the guard at all), which is why this is not a blocker. A clean refinement: on a lookup **error**, return `ok: false` instead of minting a substitute — no cookie is set, the client keeps its own uuid, the impersonation property is unchanged, and nothing is destroyed.

Also worth correcting in the record: the named case ("a device whose identity predates the cookie") cannot actually fire the guard, because `creatorUuid`/`addRoom` only began at TICKET-26, so a genuinely pre-cookie uuid owns no rooms. The real case is a *post*-TICKET-26 device that created rooms and lost the cookie while keeping localStorage. Same accepted cost, different population.

**NB-3 — The fail-open `clientKnown ?? candidate` reasoning is CONFIRMED, by a stronger argument than the report gives.** I traced every path that can set the identity cookie or write `creatorUuid`, with a fail-loud grep over `app/ lib/ components/`:

- `applyIdentityCookie` has exactly **two** callers: `app/api/identity/route.ts:39` (`if (resolved.ok)`) and `app/api/rooms/route.ts:162` (`if (identity.ok)`). **There is no third.**
- `creatorUuid` is written in exactly one place, `lib/rooms.ts:392`, from `createRoom(name, identity.ok ? identity.uuid : undefined, …)` — so `ok: false` cannot write it. `identityStore.addRoom` is likewise gated on `identity.ok`.

So the Dev's claim holds. The stronger reason it holds: `clientKnown` is **by construction** either the caller's own cookie or the uuid the caller itself just asserted — always data the client already had. The echo therefore cannot disclose anything, independently of the cookie/`creatorUuid` gating. Worth recording, because it is the invariant that keeps this safe if the gating is ever refactored.

**NB-4 — Report and PR gate numbers are stale relative to the merging tip.** Report and PR body say `939 passed / 944 total` and `creator-reentry: 5 passed`; the tip measures **943 / 948** (53 suites) and **7** creator-reentry tests. Consequently the (b) reverse-check block lists only the 5 pre-logout-fix e2e tests, so the **two logout tests have no (b) evidence** — the most security-relevant additions in the diff. Narrative evidence exists (the three `render-and-links` logout failures against the broken build), but not as verbatim output for the new tests. I supplied it: N1/N3 kill test 3; test 4 is blind, which is B2. TICKET-F23 currency.

**NB-5 — Logout is now a self-inflicted permanent lockout, and nothing warns the creator.** The confirm step (`AdminRoom.tsx:452-470`) is a bare `Confirmar` / `Cancelar`. After this PR the marker suppresses auto-claim for 3 years and the host code is the only way back — so two clicks put the room's owner into the ticket's HIGH-priority dead end, with no copy saying so. The security control is right and should stay; the gap is copy/product, and it is the most likely way a real user hits the dead end after this ships. Recommend a follow-up ticket and a TL call on the wording (e.g. "you'll need the host code to get back in"), plus possibly surfacing the state in `SavedRooms` via the existing `claimable` flag. Not blocking this PR.

**NB-6 — The e2e warm-up charges the claim budget, and `/api/host/claim` with no `room` resolves to `default`.** `warmModerationRoutes` calls `request.post("/api/host/claim")` with no `room`; `roomIdFromRequest` maps that to `DEFAULT_ROOM`, which `verifyCreatorClaim` refuses — so each warm-up spends one claim failure for the test IP. This feeds B1's saturation. Warming with a deliberately malformed id (`?room=!!`) returns 400 **before** the throttle is touched and compiles the route just the same. (Unrelated but worth knowing for anyone probing this by hand: warming is genuinely mandatory — my first live probe was invalidated when `/api/host/claim`'s first compile reset the in-process memory store and wiped the room mid-probe, exactly the hazard the Dev documented.)

---

## Assessments the brief asked for in my own right

**Mechanism — is option (ii) the right one at all? Yes, and the Dev's version of it is better than the ticket's.** The ticket proposed keying on `creatorUuid` "since the device already holds `cantai_patron_uuid`", i.e. on a localStorage mirror. The Dev checked and keyed it on `boraoke_identity` instead — httpOnly, root-path, 2-year, server-set, unreadable from JS, 24× the host session's window — so the credential is one an XSS cannot lift and the localStorage mirror is not an input anywhere (probe 5). That is strictly stronger than what was asked for. (i) is correctly rejected: a longer rolling window does nothing once the cookie is cleared, and nothing for the buried-hero half. (iii) is correctly refused **in writing**, with the right reason: it would overturn a documented invariant to buy less resilience than a cookie already provides. I would have made the same call.

**Is `room-memory.ts`'s never-store-the-host-code invariant really untouched? Yes.** `primaryCreatedRoom` is a pure `rooms.find(r => r.role === "created") ?? null` over the list `loadRooms` already returns. No new key, no new write, no new read of anything sensitive; `app/page.tsx` consumes it in an effect over the existing `cantai_rooms_v1` blob. The `SECURITY INVARIANT — never stores host code` suite is unchanged and green, and the defensive strip at L218-228 is untouched. The claim credential never passes through this module at all.

**Is the accepted cost correctly characterised, and is it the only case the guard fires on?** The cost is correctly characterised as the *safe* side of the ambiguity — refusing adoption of a uuid that owns rooms is right, and falling back to the host code is the right failure. But it is **not the only case the guard fires on** (NB-2: a `listRooms` error refuses adoption for everyone, and the client then persists the substitute uuid), and the population named for the primary case is wrong (NB-2 again: a genuinely pre-cookie uuid owns no rooms and so cannot trigger it).

**Two-devices-claiming.** Confirmed as pre-existing, not new: `sessionValue` is a deterministic HMAC of the room secret (`lib/host-auth.ts:145`), so two devices holding the code already hold byte-identical, indistinguishable, non-revocable sessions. Claim adds a second door to the same non-exclusive session. Accurate as reported.

**CSRF on the new POST.** Not a finding, recorded so the next reviewer need not re-derive it: the identity cookie is `SameSite=lax`, so a cross-site POST carries no cookie; and even if it did, the `Set-Cookie` would land in the victim's own browser granting them access to their own room. No gain.

**Scope / quality.** No unrequested features. The hero refactor keeps `id="landing-hero-title"` in both branches (the section's `aria-labelledby` target) and keeps exactly one `h1`; the generic branch is byte-identical apart from indentation. The 9 touched existing specs were fixed by making each spec *present as the device the gate actually serves* (`dropCreatorIdentity`) rather than by weakening an assertion — the right call, and each one carries a comment saying why. i18n parity is complete across the three message files. `lib/store/types.ts` untouched, no `cantai_*` key renamed.

**`ALLOW_SECRET_SCAN=1`.** Treated as settled per the TM's own verification; not re-litigated.

---

## What I verified by execution vs by reading

**By execution:** the full jest suite (943 green); the creator-reentry spec in isolation (7 green) and in the full suite (1 failure, reproduced); the 12-step live adversarial probe including the patron-with-room-id case, both takeover paths, and the whole logout/marker lifecycle; five mutants (M3c, hollow-1, N1, N2, N3); the proposed B2 assertion failing on the mutant and passing on real code; the throttle intervention (3 runs with the ceiling raised vs 7 as shipped).

**By reading:** the diff in full against `origin/ticket/104-creator-admin`; the ticket, plan, dev report and PR body; the grep-verified enumeration of identity-cookie setters and `creatorUuid` writers (NB-3); the CSRF reasoning; the i18n key parity; the Dev's M1/M2/M3b/M3d/M4/M5/M6/M7 results, which I did **not** re-run individually — each is directly asserted by a named test and I reproduced the only one I had reason to doubt.

**Not verified at all:** `npm run build` / the ES2019 + CSS-target checks (taken from the Dev's verbatim output); behaviour on the Upstash driver (memory driver only, the honest limit the Dev already states).

---

## Conditions for APPROVE

1. **B1** — bound the claim throttle so incidental session-less traffic cannot 429 a legitimate creator, with a regression test for that property. Distinguish 429 from 401 in `AdminRoom`. The full e2e suite must then be repeatably green (≥3 consecutive fresh-server runs).
2. **B2** — add the marker-clearing assertion (or equivalent) and show it **KILLS** N2, not merely that it passes.
3. **B3** — App Tester gate and Cyber Security gate recorded for TICKET-104. (Tech Manager's to clear.)
4. Report corrections for **NB-1**, **NB-2** and **NB-4**, since the dev report is the durable record for the next writer of this code.
5. NB-5 filed as a follow-up ticket; NB-3 and NB-6 at the Dev's discretion.

I re-review the deltas and confirm each item explicitly.

## Friction

- `prove-your-test-can-fail` was applied conscientiously here and still missed the one mechanism the Dev flagged as most in need of review, because the mutant table was built around the *original* design and never extended after the logout fix was added mid-ticket. Worth a line in the skill: **when a fix is added in response to a failing gate, the mutant table and the (b) reverse-check must be re-run against the final tip**, not left describing the state before the fix. The stale 939/5 counts in NB-4 are the same root cause showing up as a currency problem.
- A gate suite that is ~30-50% flaky on its headline acceptance test is indistinguishable from a broken feature, and the Dev's single green full-suite run was honestly reported. One green run is not evidence of a green gate for a test that depends on a rate limiter; N consecutive runs is. Worth considering as a house rule for any new spec that touches a throttle.
