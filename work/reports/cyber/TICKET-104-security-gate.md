# TICKET-104 — Cyber Security gate (PR #81)

**PR:** #81 — `ticket/104-creator-admin` → `main`
**Audited tip:** `ae7496a2bdba3e165e7c2e241589b377353d76ae` (== `origin/ticket/104-creator-admin`; base `dffe7c6001518b4fdeefaa30f3d24d2f558da8ce`)
**Worktree:** `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t104-creator-admin`
**Round audited:** round 2 (post-review, includes the B1 throttle re-keying and the B2 test repair)
**App under test:** `next dev -p 3110`, all routes warmed before every probe
**Verdict:** **REQUEST-CHANGES** — 2 blockers, 6 observations.

This is the gate the Reviewer's B3 asked for, and the one the Dev explicitly requested ("please run this one; it is an authentication change").

---

## The one sentence that matters

The PR's security argument rests on the identity cookie being a credential the client cannot read — the claim route's own contract says so, the Dev's report says "blast radius if `cantai_patron_uuid` is copied off a device? For this feature, **zero**", and the Reviewer endorsed it as "a credential an XSS cannot lift".

**That property does not hold. I lifted the credential with page JS and used it, from a different browser profile, to take real host control of someone else's room** — and the victim's logout does not take it back. Everything in B-S1 below is measured, not reasoned.

---

## 1. The question asked first: is the claim throttle bypassable by rotating identity, and does it matter?

### Bypassable: yes, completely, and more cheaply than the question assumes

The attacker does not need `POST /api/identity` at all. `app/api/host/claim/route.ts:63` reads the uuid straight off the `Cookie` header and `lib/identity.ts:50-52` only checks that it *parses* as a uuid — so any non-browser client (and, per O5, any browser via `document.cookie`) supplies a fresh bucket key per request for free.

Measured against the round-2 tip:

| Probe | Result |
|---|---|
| 12 failed claims on **one** invented identity | `401 ×10` then **`429 {"throttled":true}`** — the bucket works as designed |
| 3 claims, each with a **fresh** invented uuid | `401 401 401` — every one un-charged and un-throttled |
| **1100 claims, one fresh uuid each** (`lru2.mjs`, 9.4 s single-threaded) | **`{"401": 1100}`** — zero 429s |
| the creator's own claim, during and after all of it | **`200`** — the B1 shared-fate defect is genuinely gone |

### Does it matter: the honest split answer

**As an anti-guessing control — no, and it never was one. The Dev's reasoning here is correct and I would have made the same call.** The route accepts no caller-supplied uuid *as data*; the only value it compares is the cookie, against a v4 `creatorUuid` the attacker cannot enumerate (122 bits). A rotated identity is a uuid that matches nothing, so spending 1100 requests buys exactly zero progress toward a claim. The bucket bounds one device's pointless retry loop, nothing more. The B1 re-keying from IP to identity is the right fix for a real availability defect, and identity-keying does not weaken any authentication property — I verified the creator is never collaterally throttled (row 4 above).

**As an abuse/cost bound — yes, it matters, because the IP key was the only abuse bound the route had and nothing replaced it.** Two measured consequences, both non-blocking:

- **O1 (MEDIUM, memory driver only):** flooding claim with >1000 distinct uuids evicts the *login* throttle's bucket from the shared in-process LRU (`lib/rate-limit-counter.ts:126,144`, `MAX_TRACKED_KEYS = 1000`). Measured: host-code login at `429` → 1100 rotating claims (9 s) → same login back to **`401`**. The M-1 brute-force control is now resettable at will by an unauthenticated caller. Detail and caveats in O1.
- **O2 (LOW):** per-request cost is now unbounded per caller — 1 counter read + 1 room-store read + 1 counter write, ~120 req/s from one client. Under the old per-IP key, charged writes were capped at 10/min/IP because a throttled caller short-circuits before `registerClaimFailure`.

### Resource-exhaustion / cost angle of the no-cookie short-circuit: it is an improvement, not a risk

The short-circuit at `claim/route.ts:68` returns 401 **before** the throttle, before `hasNoClaimMarker` and before any store read, so the ordinary patron path (every session-less `/<room>/admin` render, which `AdminRoom.checkSession` now always claims on) costs nothing at all. The exhaustion vector in O2 is the *cookie-bearing* path, not this one. No unbounded `listRooms` was reachable from the claim route: `verifyCreatorClaim` calls `getRoom` only (`lib/host-auth.ts:262`), a single keyed read; `listRooms` is reached only from the adoption guard on `POST /api/identity` / `POST /api/rooms`, which is one keyed read per call and unchanged in shape by this PR.

---

## BLOCKERS

### B-S1 — The claim credential is published to page JS, is a portable bearer token, and cannot be revoked. The PR's central security claim is false.

**What the code claims.** `app/api/host/claim/route.ts:25-33`, `lib/host-auth.ts:230-245` and the Dev report all rest on the same premise: the credential "travels as a cookie the client cannot read", so `cantai_patron_uuid` is "not a credential for anything here" and copying it off a device is worth "zero".

**What is actually true.** The room's `creatorUuid` *is* the device's identity uuid, and that exact string is available to page JS through **two** independent channels, then accepted as a bearer credential by the claim route:

1. **`POST /api/identity` echoes the httpOnly cookie's value back in the response body** (`app/api/identity/route.ts:38`, `{ uuid: resolved.uuid, registered }`, where `resolved.uuid` is the cookie value when a cookie exists). Any same-origin JS reads the "unreadable" cookie with one `fetch`. Measured: cookie `ca3b12e1-…`, echo `ca3b12e1-…`.
2. **localStorage holds the same value in the mainstream creator path.** `PatronRoom.tsx:93-120` writes the identity uuid to `cantai_patron_uuid` on any room visit, and `app/new/page.tsx:66` sends that value as `patronUuid` so the server adopts it *as* `creatorUuid`. A host who ever opened their own room as a patron — the normal case, they scan their own QR — has their room's admin credential sitting in localStorage in plaintext.

**Full chain, executed in real browsers** (`chain.mjs`, all routes pre-warmed; the first attempt returned 401 purely from the documented first-compile memory-store reset, and passed on the warm re-run):

```
[victim]   room created: bar-cadeia
[victim]   baseline no-typing claim -> 200
[exfil]    {"fromLocalStorage":"7f3c9a10-…","fromIdentityEcho":"7f3c9a10-…","identityCookieReadableByJs":false}
[attacker] claim with stolen uuid (fresh browser profile, document.cookie) -> 200
[attacker] GET /api/host/session -> 200
[victim]   after logout, own claim -> 401
[attacker] after victim logout, claim -> 200
```

And the stolen session is real host authority, not just a 200:

```
POST /api/host/moderation?room=bar-cadeia  (stolen session cookie) -> {"ok":true,"moderation":true} [200]
POST /api/host/moderation?room=bar-cadeia  (no cookie, control)    -> {"error":"Unauthorized"} [401]
```

**Concrete attack, needing no XSS at all — and it is this product's own deployment model.** The venue tablet sits on the bar. Anyone with one unattended minute opens devtools and reads `localStorage.cantai_patron_uuid` (or runs the one-line `fetch('/api/identity')`). They walk away with a string that grants host control of that venue's room **from their own phone, indefinitely**. The owner's only revocation control — logout — provably does not touch them (last two lines above): the no-claim marker is a cookie in the *victim's* jar, not server state, so it suppresses the owner's own re-entry while leaving the attacker's claim at 200.

**Why this is a real escalation and not "device access was already game over".** Before this PR, a minute at the tablet also yielded admin — but that admin was **non-portable and expiring**: the host session cookie is httpOnly, path-scoped to `/api/host`, unreadable by JS, and dies on logout or after 30 idle days. After this PR the same minute yields a **portable, remote, ~400-day rolling, unrevokable** credential covering *every* room that device created. That is the delta, and it is the part the threat model never assessed.

**With XSS the same exfil is remote and silent**, and it upgrades XSS from "act inside the victim's session while it lasts" to "hold durable off-device admin over all of that creator's rooms".

**Root cause, which is why this is a design blocker rather than a patch.** The same value is *required to be client-readable* (own-row highlighting, and `PatronRoom.tsx:178` puts it in a URL query string on the `/api/queue/pending?uuid=` poll) and *required to be secret* (the claim). One value cannot be both. Suppressing the echo alone is not sufficient while the localStorage mirror exists on every device already, and removing the mirror breaks the patron features that need it.

**Directions (the choice is the Dev's):**
1. Give the claim its **own** credential: at room creation issue a random per-room secret in an httpOnly cookie (`/api/host`-scoped), store only its hash on the room record, and never return it in any response body. Then the claim proves possession of something no page JS has ever seen, and `creatorUuid` goes back to being bookkeeping.
2. Whatever the credential is, make logout an actual **server-side revocation** for the claim path (a revoked-claim flag on the room record, or a claim epoch the cookie must match) rather than a marker in the victim's own cookie jar. Today a compromised creator has no recovery at all.
3. If the identity uuid is kept as the credential despite the above, `POST /api/identity` must stop echoing an existing cookie's value (return `{ registered }` only), and the `?uuid=` query-string poll needs to move off the URL — but this only narrows the window, it does not fix the structural conflict.

**Reproduce:** `dev` on 3110 → warm every route → create a room in a browser with `cantai_patron_uuid` preset → `fetch('/api/identity',{method:'POST'})` and read `.uuid` → in a fresh profile set that value as `boraoke_identity` → `POST /api/host/claim?room=<id>` → 200 → `POST /api/host/moderation?room=<id>` with `{"moderation":true}` → 200.

### B-S2 — `POST /api/host/session` (logout) is unauthenticated, so any third-party page can permanently lock the creator out of the feature. Proved cross-site in a real browser.

**The route sets the 3-year no-claim marker for any caller, with no auth check at all** (`app/api/host/session/route.ts:71-79` — no `requireHost`, no origin check, no session required). Pre-PR that was harmless: an unauthenticated logout only cleared your own cookie. Post-PR the same request plants `boraoke_noclaim_<room>` with `maxAge` 3 years, and the claim route refuses while it is present.

**Measured, genuinely cross-site** (attacker page served from `http://127.0.0.1:3111`, target `http://localhost:3110` — different sites for cookie purposes; the page just auto-submits a form, no click needed):

```
BASELINE creator claim -> 200
landed on: http://localhost:3110/api/host/session?room=bar-csrf-alvo
MARKER PLANTED: boraoke_noclaim_bar-csrf-alvo = 1 (expires 2027-11-01)
AFTER CSRF creator claim -> 401
```

SameSite=lax does not help: it governs *sending* cookies, and this attack needs none sent — the response of a top-level cross-site POST navigation is first-party for the target site, so its `Set-Cookie` is stored.

**Concrete failure scenario.** Room ids are public slugs of the venue name (`bar-seguranca`) and are printed on every QR/join link, so the attacker knows them. Any page the owner visits — a link in a DM, a compromised page, a competitor's "check your room" page — silently plants the marker. The owner then opens `/<room>/admin`, gets the code gate, and the code was shown once at `/new` and is unrecoverable by design. **That is precisely the HIGH-priority dead end this ticket was filed to remove, now inducible remotely by a stranger, for ~400 days, with no authentication.** The victim sees a `{"ok":true}` JSON page for a moment and has no idea what it did.

It is also spammable: one page can chain top-level navigations across several of a venue's rooms.

**Directions:** require a valid host session before setting the marker (an unauthenticated logout has nothing to log out of, and `requireHost` + SameSite=lax then makes the cross-site POST a 401); and/or reject the state change when `Sec-Fetch-Site`/`Origin` is cross-site. A regression test should pin "a cookie-less POST to logout does not plant a marker".

**Reproduce:** the `evil2.html` + `csrf2.mjs` pair in this audit's scratch dir, or simply `curl -X POST 'http://localhost:3110/api/host/session?room=<id>'` with no cookies and observe the `Set-Cookie: boraoke_noclaim_<id>=1; … Max-Age=94608000` in the response.

---

## Observations (non-blocking)

**O1 (MEDIUM) — a claim flood resets the host-login brute-force throttle. Memory driver only.** `lib/rate-limit-counter.ts` keeps one process-wide `Map` for every counter (`login:<ip>`, `hostclaim:<identity>`, …) capped at `MAX_TRACKED_KEYS = 1000` with oldest-inserted eviction. Because claim now lets an unauthenticated caller create unbounded distinct keys, 1100 rotating-uuid claims evict the login bucket. Measured: `12 wrong-code logins: 401×10 429 429` → `login now: 429` → 1100 claims → **`login AFTER the flood: 401`**. Interleaving 1000 claims per 10 guesses restores unlimited online guessing against the host code. Not a blocker: the code keyspace (8 chars) still makes exhaustion infeasible, and on Upstash (the production path per the file's own header) there is no LRU and keys carry TTLs, so this is confined to the memory driver — which the `ephemeral` flag in `POST /api/rooms` shows can be a production configuration. Cheapest fixes: keep a *coarse* IP ceiling on claim far above legitimate traffic (in addition to the identity key — it costs nothing against B1 because a creator makes one claim), or only track a bucket for an identity the store already knows, or give claim its own Map.

**O2 (LOW) — the route's only abuse bound was removed, not replaced.** ~120 req/s from one client, each costing a counter read, a keyed room read and a counter write, with attacker-chosen Redis key cardinality (TTL-bounded on the Upstash path, LRU-bounded on memory — see O1 for why that bound is itself the problem). Same fix as O1.

**O3 (LOW) — the "the marker must outlive the identity cookie" invariant does not hold in a real browser.** `lib/host-auth.ts:205-210` sets the marker to 3 years specifically so it cannot expire back into auto-claim before the 2-year identity cookie. Chromium caps cookie lifetime at 400 days, so both land on the same ceiling — measured in-browser: `boraoke_noclaim_… days_left=400`, `boraoke_identity days_left=400`. The identity cookie is **re-set on every `POST /api/identity`** (`identity/route.ts:39`, i.e. every patron page mount) so it rolls forward indefinitely, while the marker is written once and never refreshed. Net effect: about 13 months after a logout, the shared-venue tablet silently starts auto-claiming again — the exact failure the 3-year value was chosen to prevent. Fix direction: refresh the marker on each claim refusal, or hold the opt-out server-side (which B-S1 direction 2 wants anyway).

**O4 (INFO) — the adoption guard's marginal value is smaller than the durable record claims, and the record should say so.** The takeover it closes (`POST /api/identity {legacyUuid: <victim>}` → cookie → claim) required knowing the victim's uuid; and knowing the victim's uuid is *by itself sufficient* without adoption, since the claim route accepts the uuid straight from the `Cookie` header (measured: `401` for a wrong uuid, `200` for the real one, from a bare client with no jar). So the guard is not "what keeps the answer zero" — the secrecy of the uuid is, and per B-S1 the uuid is not secret. The guard is still worth keeping: it stops an attacker obtaining a *legitimately issued*, durable identity cookie and stops store pollution. But it carries a real cost (patron continuity loss) and the record currently over-credits it, which is the kind of reasoning a future writer deletes a guard on the strength of.

**O5 (INFO) — page JS can *plant* the marker, and cannot clear a server-set one.** `document.cookie = 'boraoke_noclaim_<room>=1; path=/api/host'` succeeds when no httpOnly cookie of that name exists, and the next claim returns 401 (measured). Attempting to clear a server-set httpOnly marker the same way fails — the cookie survives with `httpOnly=true` (measured), so tampering fails **closed**, in the right direction. Minor next to B-S1, and fixed for free by holding the opt-out server-side.

**O6 (INFO) — nothing sensitive is logged by the changed code, but the credential does travel in a URL.** Fail-loud grep over `app/api/host/claim/route.ts`, `lib/host-auth.ts`, `lib/identity.ts`, `app/api/host/{login,session}/route.ts` with a positive control: **no `console.*` at all**; no host code, session value or uuid is ever logged or returned (the claim route's 401 is deliberately undifferentiated, which I confirmed — no cookie, wrong uuid, no creator on record and logged-out are byte-identical responses). Separately, `PatronRoom.tsx:178` puts the identity uuid in a query string (`/api/queue/pending?uuid=`), which platform access logs record — pre-existing and harmless before this PR, a credential-in-logs problem after it. Worth folding into whatever B-S1 becomes.

---

## Round-1 findings re-verified on the round-2 code

The Reviewer's NB-3 enumeration was done on the round-1 tip; a refactor is exactly when a third path appears, so I re-ran it against `ae7496a` with fail-loud `/usr/bin/grep` and the definition lines as positive controls.

- **`applyIdentityCookie` — still exactly two callers, both `ok`-gated.** `app/api/identity/route.ts:39` (`if (resolved.ok)`) and `app/api/rooms/route.ts:163` (`if (identity.ok)`). Definition at `lib/identity.ts:193` matched (control). No third path.
- **`creatorUuid` — still exactly one write.** `lib/rooms.ts:392` (`...(creatorUuid ? { creatorUuid } : {})`), fed by `createRoom(name, identity.ok ? identity.uuid : undefined, …)` at `app/api/rooms/route.ts:127-131`, so `ok: false` cannot write it. `identityStore.addRoom` likewise gated (`route.ts:145-148`). Every other hit in the tree is a comment or the type declaration at `lib/rooms.ts:81`.
- **`IDENTITY_COOKIE` readers — two.** `lib/identity.ts:155` (the resolver) and `app/api/host/claim/route.ts:63`. Nothing reads it from a body or query anywhere; `middleware.ts` does not touch it.
- **The claim route reads no caller-supplied uuid.** Re-confirmed by reading (`roomIdFromRequest` is the only input) and by execution — a wrong uuid in the cookie is 401, and the earlier round's body/query injections have no code path to read them.
- **`listRooms`-error path (NB-2) — fixed as described.** `lib/identity.ts:143-149` returns the tri-state and `:168` returns `{ uuid: asserted, ok: false }` on `"unknown"`, so no cookie is set and nothing is registered; `PatronRoom.tsx:116` only overwrites `cantai_patron_uuid` when `data.registered` is true, so the device's real uuid is no longer destroyed. Asserted by `__tests__/identity.test.ts` ("refuses adoption when the ownership lookup FAILS — without DESTROYING the device's uuid"), green.
- **No-claim marker lifecycle — correct apart from B-S2 and O3/O5.** Measured: cross-site/unauth logout sets it; a **wrong** host code does **not** clear it (`401`, marker still present, claim `401`); the **correct** code clears it (`200`, 0 marker rows, claim `200`); it is per-room (another room's claim unaffected); any non-empty value counts, so tampering refuses rather than admits.
- **`room-memory.ts`'s never-store-the-host-code invariant — untouched.** The only addition is the pure `primaryCreatedRoom` filter over the existing `cantai_rooms_v1` list; no new key, no new write, no secret.
- **Cookie attributes — correct, with one caveat that is B-S1's.** Measured in-browser: `boraoke_identity` httpOnly, SameSite=Lax, `path=/`, prod-`secure`, 400-day effective; `boraoke_noclaim_<room>` httpOnly, Lax, `path=/api/host`, prod-`secure`; `cantai_host_<room>` httpOnly, Lax, `path=/api/host`, 30-day rolling. The host session's least-privilege path scoping is right. The identity cookie's root path is unavoidable (three endpoints on two path prefixes need it) and is not the problem — the problem is that its *value* is handed to JS anyway (B-S1), which makes httpOnly and path scoping decorative for this credential.
- **Timing safety — adequate and not load-bearing.** `timingSafeHexEqual` (`lib/host-auth.ts:149-155`) HMACs both sides to a fixed length before `timingSafeEqual`, so neither content nor length leaks. Nothing here depends on it: a v4 uuid is not timing-guessable at internet latency. No `===` on identity material anywhere in the diff.
- **No injection surface.** `isValidRoomId` is `/^[a-z0-9-]{1,64}$/` (`lib/rooms.ts:113`), and every cookie name built from a room id (`cantai_host_<id>`, `boraoke_noclaim_<id>`) and every counter key goes through it, so no `;`/whitespace can inject a cookie attribute or a Redis key separator. No `dangerouslySetInnerHTML` in the changed UI (fail-loud grep with a `className` control). No new dependency in `package.json`.
- **CSRF on the new POST** — nothing to add to the Reviewer's reasoning for `/api/host/claim` itself: a cross-site POST carries no Lax cookie, and a forged claim would only grant the victim their own room. The CSRF problem is on the *logout* route, which is B-S2.

---

## Gate status

| Gate | Result |
|---|---|
| `npx jest` (full), run by me on `ae7496a` | **53 suites passed, 948 passed / 5 skipped / 953 total**, exit 0 — matches the Dev's report exactly |
| Playwright full suite | **not re-run by me** (taken from the Dev's 3 consecutive fresh-server runs, 113 passed each). The throttle-flake condition the Reviewer measured did not recur in any of my probes: the creator's claim stayed 200 through a 1100-request flood |
| `scripts/verify-green-local.sh` | **not applicable** — that is the framework repo's gate script; boraoke has no equivalent. The product's gate suites are jest + Playwright, above |
| Live adversarial probe | 3110, all routes warmed, 9 probe scripts, every conclusion below tied to captured output |

Per the role's CI-verified-green rule this is not a `blocked-on-CI` verdict: the product's authoritative unit gate is green and I ran it. The verdict is **FAIL / REQUEST-CHANGES on security grounds**, which is independent of CI.

---

## What I verified by execution vs by reading

**By execution:** the full jest suite; the creator create→claim→host-API flow; the `/api/identity` cookie-value echo; the localStorage mirror equalling `creatorUuid` through `/new`; the full exfil→fresh-profile→claim→`/api/host/moderation` chain in real browsers; the stolen credential surviving the victim's logout; the cross-site marker-planting CSRF in a real browser across two sites; the whole marker lifecycle (unauth set, wrong-code no-clear, correct-code clear, per-room scoping, JS plant, JS cannot clear); the throttle's single-identity 429 and its rotation bypass at 1100 requests; the shared-LRU eviction resetting the login throttle from 429 to 401; the 400-day browser cap on both long-lived cookies; the wrong-uuid 401 control alongside every positive.

**By reading:** the full diff against the merge base; the ticket, the round-1 Reviewer report and the round-2 Dev report; the grep-verified enumerations above (fail-loud `/usr/bin/grep`, positive control in every invocation, per `proof-by-absence`); `rate-limit-counter`'s Redis path; the identity-cookie refresh on every `/api/identity` (which makes O3 bite); `isValidRoomId`'s use at every cookie-name/key construction site.

**Not verified at all — out of scope or not reachable here:** behaviour on the Upstash driver (memory driver only, so O1's production applicability depends on the deployment's `STORE_DRIVER`, which I did not inspect); whether any real deployment runs the memory driver in production; the Playwright suite's flake rate; `npm run build` and the ES2019/CSS-target checks.

---

## Verdict

**REQUEST-CHANGES** (security FAIL). Two blockers:

1. **B-S1** — the claim credential is published to page JS (twice over) and works as a portable, unrevokable bearer token; the PR's threat model assumed the opposite. Needs a credential that is never returned to a client, and a real revocation path.
2. **B-S2** — unauthenticated, cross-site-triggerable permanent lockout via `POST /api/host/session`, landing the room's owner in the exact dead end this ticket exists to remove.

Everything else about the change is sound and I want that on the record, because the mechanism choice is not the problem: option (ii) over (iii) is the right call, `room-memory`'s never-store-the-host-code invariant is genuinely untouched, the adoption guard is correct as far as it goes, the B1 re-keying fixes a real availability defect without weakening authentication, the round-2 `"unknown"` tri-state is a proper fix for NB-2, no secret is logged, and the injection/XSS/timing/dependency surface is clean. The two blockers are both about the same thing the ticket itself flagged as needing adversarial attention and the dev report answered too confidently: **what the blast radius is when the identity value leaves the device, and who is allowed to switch the feature off.**

## Friction

- The house's `prove-your-test-can-fail` discipline caught the test-side gap (B2) but neither round produced a test that pins a *negative authorization* property end-to-end ("a caller who is not the creator, in any shape, cannot obtain a host session"). Both blockers here are invisible to unit tests and to the existing e2e suite, and both fell out of a 20-minute live probe. Worth a line in the reviewer/cyber role docs: **an authentication change gets at least one probe from a second browser profile and one from a bare HTTP client, because the interesting attacker is neither the victim's page nor the test's own context.**
- The claim route's five-line "SECURITY CONTRACT" comment is good practice and I want more of it — but line 1 ("the localStorage mirror is not a credential for anything here") is the exact claim that is false, and it reads as verified because it is written as a contract. A contract comment should name the property's *evidence* or be marked as an assumption, or it hardens a wrong belief for the next reader.
