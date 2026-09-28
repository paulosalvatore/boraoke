# TICKET-104 — Cyber Security RE-GATE (PR #81)

**PR:** #81 — `ticket/104-creator-admin` → `main`
**Audited tip:** `aaaf844093f98546a5cd947ccba7626757db4393` (== `origin/ticket/104-creator-admin`; base `dffe7c6001518b4fdeefaa30f3d24d2f558da8ce`)
**Worktree:** `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t104-creator-admin`
**Round audited:** round 4 + the rotation correction (the shipped re-send-the-held-token roll)
**Prior gate:** `work/reports/cyber/TICKET-104-security-gate.md` — REQUEST-CHANGES, 2 blockers
**App under test:** `next dev -p 3150`, every route and page warmed before any probe
**Verdict:** **APPROVE** — both blockers closed by execution. 0 blockers, 10 observations, none blocking.

---

## The one sentence that matters

The previous gate's central claim was that the credential could be lifted by page JS and replayed from another profile; I re-ran that chain against the new design with working positive controls at every step, and **the exfiltration path is gone at the root, not patched** — `creatorUuid` has zero authorization reads anywhere in `app/` or `lib/`, the new credential appears in nothing page JS can reach, and the owner's logout kills a copy of it server-side.

What I did **not** find closed, and what the Dev's own report asserts is closed, is **O1**: the claim throttle's bucket key is still client-choosable and a rotating-key flood still resets the host-code brute-force control. I measured the identical attack through the pre-existing login route at the same cost, so it is a `main` defect this PR neither introduces nor worsens — which is why it is an observation and not a blocker. But the code comment stating the opposite is the fourth instance on this PR of a confident sentence the code does not back, and that is the pattern, not the incident.

---

## BLOCKERS

**None.**

---

## B-S1 — the credential exfiltration chain. CLOSED.

**Re-run of the prior gate's exact chain, in real browsers** (`t104-regate-bs1.mjs`; the first two attempts were void on the documented dev-store reset and are discarded — the run below has `sessionProbe: authed=true` and a working positive control, so it is the valid measurement):

```
CREATE 201 body: {"id":"bar-exfil-regate-three",...}   contains a 43-char token? false
CLAIM COOKIE: len=43  httpOnly=true  sameSite=Lax  path=/api/host  secure=false(dev)  days=180

SCRAPE (everything page JS can see, from an admin page on the victim's own device):
  document.cookie : ""
  localStorage    : cantai_patron_uuid, cantai_last_room, cantai_rooms_v1
  sessionStorage  : {}
  /api/identity   : {"uuid":"e5b4f8d8-…","registered":true}
  /api/host/session, /api/host/claim : {"authed":true}

*** TOKEN PRESENT IN ANYTHING PAGE JS CAN SEE? ***  false
positive control (token includes itself):            true

ATTACKER replay, 3 scraped values x 4 cookie names, fresh browser context -> any non-401?  false
POSITIVE CONTROL (the real token, fresh profile)  -> 200 {"authed":true}
  and moderation with the session it issued       -> 200 {"ok":true,"moderation":true}

VICTIM same-origin logout            -> 200
COPIED token after victim logout     -> 401 {"authed":false}
```

The positive control is the part that makes the negative mean something: a fresh browser profile holding the *real* token does get a 200 claim and a 200 moderation, so the harness can detect success — and none of the 12 replayed scrape/name combinations reaches it.

**The old credential is inert.** Against a bare HTTP client, the round-2 credential now buys nothing:

| Attempt | Result |
|---|---|
| `Cookie: boraoke_identity=<the room's creatorUuid>` | `401` |
| the uuid in the query AND in the body (`uuid`, `patronUuid`, `legacyUuid`) | `401` |
| the real claim token under `boraoke_identity` / `cantai_patron_uuid` / `boraoke_claim` / `cantai_host_<room>` / `boraoke_claim_default` | `401` ×5 |
| nothing at all | `401` |
| the real token under its real name (control) | `200` |

**"Zero authorization reads of `creatorUuid`" — verified exhaustively, per `proof-by-absence`.** `/usr/bin/grep -ainr` over `app lib components middleware.ts` (94 files covered), with two positive controls in the same search space (`claimTokenHashes` → 9 hits, `requireHost` → 36 hits):

- 12 `creatorUuid` occurrences total: **8 are comments**, plus the type declaration (`lib/rooms.ts:85`), the `createRoom` parameter (`:479`) and the single write (`:513`). **No read, anywhere.**
- Alternative spellings (`creator_uuid`, `creator-uuid`, `.creator`, `creatorId`) — exit 1, none.
- The identity cookie is read in exactly one place, `lib/identity.ts:167` (the resolver). Not in the claim route, not in `middleware.ts`.

So B-S1 is structurally closed: there is no longer a value that is both client-readable and authorization-bearing.

**Revocation is real, and I measured its limit** (`t104-regate-revoke.mjs`, controls green):

```
attacker claim with a copied token     -> 200   (attacker now holds a host session)
owner logout                           -> 200
attacker claim after logout            -> 401   <- the claim credential IS revoked
attacker MODERATION after logout       -> 200   <- the session it already minted is NOT
attacker session probe after logout    -> 200   + a fresh 30-day Set-Cookie
CONTROL bogus session                  -> 401
```

That residual is **O-A** below. It is real, it is pre-existing on `main`, and it is not a reason to block this PR — reasoning there.

---

## B-S2 — unauthenticated cross-site logout lockout. CLOSED.

**The prior gate's exploit, re-run in a real browser across two origins** (attacker page served from `http://127.0.0.1:3153`/`:3151`, target `http://localhost:3150` — different sites for cookie purposes; auto-submitting form, no click):

```
owner claim (baseline)                              -> 200
cross-site top-level form POST to /api/host/session -> landed on the target, page said {"error":"Unauthorized"}
OWNER claim afterwards                              -> 200
owner still holds claim cookie: true | session cookie: true
```

Nothing planted, nothing revoked, owner unaffected.

**The second layer is live and is not decorative.** A caller presenting the owner's genuinely valid session cookie:

| Provenance | Result |
|---|---|
| `Sec-Fetch-Site: cross-site` | `401 {"error":"Unauthorized"}` |
| `Sec-Fetch-Site: none` | `401` |
| `Origin: http://evil.test` | `401` |
| `Origin: null` | `401` |
| `Origin: http://localhost:3150.evil.test` (suffix trick) | `401` |
| `Sec-Fetch-Site: same-site` | `200 {"ok":true}` (control) |
| `Sec-Fetch-Site: same-origin` | `200` (control) |
| neither header (the fail-open case) | `200` |

**No room-existence oracle**, measured rather than assumed: real room cross-site, made-up room cross-site and real room with no cookie all return byte-identical `401 {"error":"Unauthorized"}`.

**The fail-open on absent provenance is safe, and I checked the reasoning rather than accepting it.** For the fail-open to matter, a client would have to both omit `Sec-Fetch-Site` *and* `Origin` **and** still send the session cookie on a cross-site POST. The cookie carries an explicit `SameSite=lax` attribute (not a default), so a browser old enough to lack `Sec-Fetch-Site` still honours it and sends nothing; `requireHost` then refuses. The degraded case falls back exactly onto the layer that already holds. The one future hazard is the one the code names itself: if `SameSite` ever moves to `None`, this layer stops covering header-less clients.

**The claim route itself is CSRF-safe too** — I tested it rather than reasoning from the logout result. A cross-site top-level form POST to `/api/host/claim` returns `{"authed":false}` (the Lax cookie is not sent), while the same POST same-origin from the app's own page returns `{"authed":true}`.

---

## The roll mechanism — no write on the authentication path, no race. CLOSED.

This is the part the Dev asked to be looked at hardest, and it is correct as shipped.

**Code path audit.** `POST /api/host/claim` = `verifyClaim` (read) → `issueSession` (read) → `rollClaimCookie` (**no store write**). `GET /api/host/session` = `requireHost` (read) → `verifyClaim` (read) → `rollClaimCookie` (**no store write**). The only writes are `issueRoomClaimToken` at room creation and at a successful host-code login, and `revokeRoomClaimTokens` at logout — none of them on the path a returning device takes.

**Measured, against the two failure modes the previous two attempts had:**

```
12 CONCURRENT claims, same held token   -> 200 x12 ; token still live afterwards -> 200
12 CONCURRENT authenticated probes      -> 200 x12 ; token still live afterwards -> 200
```

Neither the round-1/3 eviction (an active device pushing another device's hash off the cap) nor the round-4 lost-update race (`aLives=false`) reproduces, because there is nothing written to lose. The one path that does write behaves as designed: 5 concurrent host-code logins minted 5 tokens, all 5 live, and the room's original creation token was evicted — correct `MAX_CLAIM_TOKENS` behaviour, not a race.

---

## Assessed in my own right (the redesign moved the surface)

**Token generation and entropy — good.** `nodeRandomBytes(32).toString("base64url")` = 256 CSPRNG bits. Measured over 30 mints: 30/30 distinct, all length 43, zero characters outside the base64url alphabet.

**Cookie attributes — correct.** Measured in a real browser: `httpOnly=true`, `SameSite=Lax`, `path=/api/host` (least privilege — it is not sent to any page route, so it never reaches a rendered document), `secure` gated on `NODE_ENV === "production"` (absent in dev, as expected), effective lifetime 180 days rolling. No `Domain` attribute, so the cookie is host-only and a sibling subdomain cannot send it.

**Hash at rest — sound for this input.** `hashClaimToken` is an HMAC with a hard-coded, in-source key, which for a 256-bit random input is equivalent to a plain hash and is fine: there is nothing to brute-force. See O-E for what that does *not* cover.

**Cookie-name injection — not possible.** Every cookie name and counter key is built from a room id that passed `isValidRoomId` (`/^[a-z0-9-]{1,64}$/`) inside `roomIdFromRequest`. Measured: `room=a;evil=1` → `400`, `room=../../etc/passwd` → `400`, a 200-character room id → `400`.

**Malformed / absent token — handled.** Empty cookie value → `401` (short-circuits before any store read). A 64 KB token → `431` at the HTTP layer, never reaching the handler. `room=default` → `401`/`429`, never claimable.

**Room-existence oracle on the claim route — none.** A real room, a made-up room and `default` all return `401 {"authed":false}` with identical bodies; over 20 samples each the medians were 11.9 ms (real) vs 11.3 ms (made-up), indistinguishable.

**Abuse bound on the new credential — re-checked against the prior gate's judgement, which still holds but for a different reason.** The prior gate measured 1100 rotating-identity claims with zero 429s and called it harmless because there was no secret to guess. With a 256-bit token the target is different but the conclusion survives on stronger ground: the route verifies before charging, so a valid token can never be denied (measured: a valid holder gets `200` while the IP's budget is fully spent, and a cookie-less patron gets a free `401`), and 2^256 is not a guessing target. The failure budget still works per key (`401 ×9` then `429`). What does *not* hold is the Dev's claim about the key itself — O-B.

**No new dependencies** (zero diff lines in `package.json`/`package-lock.json`). **Nothing sensitive logged**: no `console.*` at all in the seven changed auth/route files (fail-loud grep, control present), and the only 43-character string in 3108 lines of server log was my own over-length room-id probe.

---

## Observations (non-blocking)

**O-A (HIGH — pre-existing on `main`, but it caps what this PR's revocation buys). A host session, once minted, can never be revoked, so a compromised room has no recovery path.** Measured above: after the owner's logout the attacker's claim dies but their session keeps moderating and keeps rolling itself a fresh 30-day cookie on every probe. Re-entering the host code does not help either, and I verified why by execution rather than by reading: `sessionValue` is a deterministic HMAC over `room.hostCodeHash`, so two separate logins minutes apart returned the **byte-identical** session value (`7da5334c7782323f…` both times). There is no rotation lever anywhere in the app.

Why this is not a blocker, stated so it can be argued with: the mechanism predates this ticket (`lib/host-auth.ts`'s own 30-day note says host sessions were never per-device or revocable), and on `main` the pre-PR logout only cleared the caller's own cookie, so a copied session was equally permanent there. The PR does raise the *likelihood* of the precondition — a creator's device now always carries a claim credential, and the claim route converts it to a session automatically — but at a venue the admin device is also the device that has logged in, so the copyable permanent session was already sitting in that jar. The delta is real and small; the defect is `main`'s. **File it as its own ticket** (per-device session values, or a room-secret rotation that logout performs), and until then do not describe logout to anyone as "recovering a compromised room" — it recovers the claim credential only.

**O-B (MEDIUM — the round-3 report asserts this is fixed; it is not). The claim throttle's bucket key is still client-choosable, and a rotating-key flood still resets the host-code brute-force control.** `clientIpFrom` reads `TRUSTED_CLIENT_IP_HEADER` / `x-real-ip` / `x-forwarded-for` off the request, all of which a direct client can set. Measured: 14 failed claims with a rotating `X-Forwarded-For` → `401 ×14`, never a `429`; same with `X-Real-IP`. Then the full O1 reproduction:

```
1200 rotating-identity claims in 14.3s -> {"401": 1200}
login from the throttled ip afterwards -> 401   (was 429; the brute-force control was RESET)
```

The code comment at `lib/host-auth.ts:~390` says "The key is **server-derived** (the edge-set client IP), never a value the caller chose … a claim flood can no longer evict anything that a login flood could not already." The first half is false off a trusted edge; **the second half is true, and it is what saves this from being a blocker** — I measured the identical LRU reset through the pre-existing login route alone, with the new route untouched:

```
1200 rotating-ip LOGIN failures in 15.2s -> {"401": 1200}
victim ip after the LOGIN-ONLY flood     -> 401
```

Same attack, same cost, present on `main`. So O1 is neither introduced nor worsened here — but it is **not fixed**, and the sentence saying it is should be corrected before it propagates the way B-S1's contract line did. Scope caveat I did not verify: on Vercel the edge is believed to overwrite these headers, which would make the key genuinely server-derived in production; I had no way to test that here, so treat it as unverified either way. The LRU is also memory-driver-only (`MAX_TRACKED_KEYS = 1000`); Upstash has TTLs and no eviction.

**O-C (MEDIUM). `MAX_CLAIM_TOKENS` counts issues, not devices, on the login path — contradicting its own docblock.** `lib/rooms.ts` says "'Devices', not 'issues', and that distinction is what keeps this cap safe to hold small", and it is right about the *roll* path (the shipped roll writes nothing, so a device re-entering never consumes a slot — verified above). It is wrong about the *login* path, where every successful host-code login mints a fresh token into a new slot. Measured from a single client: 30 sequential logins left exactly the last 5 live, the 1st dead and the 26th live; 5 concurrent logins evicted the room's original creation token. Practical consequence for the ticket's own acceptance criterion: five staff phones each typing the code, or one tablet that clears cookies five times, silently evicts the owner's phone back onto a code they do not have. Not a security hole (nothing gains access; a device loses it) and it needs the host code, so no unauthenticated party can drive it. Fix direction if it is worth one: only mint at login when the device does not already present a live token.

**O-D (LOW). Verify-before-throttle means the failure budget no longer bounds store reads.** Because `verifyClaim` (and its `getRoom`) runs before `isClaimThrottled`, a caller that is already `429` still costs one keyed store read per request. Measured: 300 throttled requests served in 8 s sequentially from one client (~37/s, curl-bound, not server-bound). This is the correct trade — it is exactly what stops a spent budget from locking out the legitimate holder — but the cost bound the prior gate flagged as O2 is now strictly weaker, and on Upstash each of those is a network round trip. Cheapest mitigation if it ever matters: a coarse ceiling far above legitimate traffic, checked before the read.

**O-E (LOW — pre-existing, and it bounds what "hashes at rest" buys). `hostCodeHash` is an unsalted HMAC with an in-source key over a ~40-bit secret, and it doubles as the room's session secret.** `generateHostCode()` is 8 Crockford-base32 characters. A store leak therefore yields, by offline brute force, every room's host code *and* — since `resolveRoomToken` returns `hostCodeHash` and `sessionValue` is an HMAC of it — every room's session value directly, with no brute force at all. The new claim-token hashing is genuinely leak-proof; it just is not the weakest thing in that record. Outside this diff; worth its own ticket.

**O-F (INFO). The provenance check is on logout only.** `/api/host/moderation` and the other state-changing host routes rely on `requireHost` + `SameSite=Lax` alone, which is the same single mechanism the round-4 argument declines to rely on for logout. Defensible (logout is the one with a permanent, un-undoable effect) but worth being deliberate about rather than incidental.

**O-G (INFO). `isCrossSiteRequest` compares `new URL(origin).host` against the raw `Host` header.** Behind a proxy that rewrites `Host`, a legitimate same-origin logout would be refused. Fails closed (availability, not security), and does not apply to the Vercel path.

**O-H (INFO). The prior gate's O6 improves for free.** `PatronRoom.tsx:178` still puts the identity uuid in a query string (`/api/queue/pending?uuid=`), which platform access logs record — but that uuid now authorizes nothing, so it is back to the pre-existing patron-data exposure it always was rather than a credential in logs.

**O-I (INFO). `issueRoomClaimToken` / `revokeRoomClaimTokens` do a full-record read-modify-write**, matching the pre-existing pattern of `setRoomMode` / `setRoomLanguage`. Under a real Redis driver, concurrent mints (or a mint concurrent with a settings change) can lose an update. Not on the authentication path, so it cannot recreate the round-4 lockout; noted because the pattern is now used by auth-adjacent code.

**O-J (INFO). Logout requires a host session, so a creator holding only a claim token must claim before they can log out.** `AdminRoom.checkSession` does this automatically, so the real flow is unaffected — I only hit it by driving the API directly (a creator who has never claimed gets `401` on logout, which reads as a bug and is not one).

---

## Gate status

| Gate | Result |
|---|---|
| `npx jest` (full), run by me on `aaaf844` | **53 suites passed, 961 passed / 5 skipped / 966 total**, exit 0 — matches the Dev's round-4 report exactly |
| `CI=1 PORT=3152 npx playwright test e2e/creator-reentry.spec.ts`, run by me | **10 passed (39.3 s)** — the changed spec, including the two blocker regression tests, on a cold server of its own |
| Full Playwright suite | **not re-run by me** (taken from the Dev's 10-run distribution: 5/5 valid full runs, 4 clean, 1 unrelated timing failure in `render-and-links.spec.ts:262`) |
| `scripts/verify-green-local.sh` | **not applicable** — that is the framework repo's gate script; boraoke has no equivalent. The product's authoritative gates are jest + Playwright, above |
| Live adversarial probe | port 3150, every route and page warmed, 9 probe scripts, every conclusion below tied to captured output with a positive control |

Per the role's CI-verified-green rule this is not a `blocked-on-CI` verdict: the product's authoritative unit gate is green and I ran it myself.

---

## What I verified by EXECUTION vs by READING

The previous round's "verified" claim was scoped too narrowly, which is how B-S1 survived to a gate, so this split is deliberately literal.

**By execution:** the full jest suite and the changed e2e spec; room creation returning no token in its body; the claim cookie's real attributes in a live browser jar; the full page-JS scrape (document.cookie, every localStorage and sessionStorage key, the `/api/identity` echo, both host probes) with a positive control proving the check can detect the token; a 12-combination replay from a second browser profile; the real-token positive control succeeding at claim *and* moderation from that same second profile; the old identity-uuid credential failing from a bare client in cookie, query and body form; the token under four wrong cookie names; server-side revocation killing a copied token; the attacker's already-minted session surviving that logout and rolling itself; two separate logins producing a byte-identical session value; the cross-site top-level form POST to logout in a real two-origin browser setup; five foreign-provenance variants against a genuinely valid session, with same-origin/same-site/absent controls; the logout no-oracle triple; the cross-site form POST to the claim route with a same-origin control; 12 concurrent claims and 12 concurrent authenticated probes with survival re-checks; 5 concurrent logins; 30 sequential logins and the resulting cap eviction; 30-token distinctness/length/charset; the failure budget reaching 429 and a valid holder bypassing a spent budget; 1200 rotating-key claims resetting the login throttle, and the same reset through the login route alone; the store-read cost of a throttled caller; the claim-route oracle test with 20-sample timing; malformed tokens and hostile room ids; the absence of `console.*` and of any token-shaped string in 3108 lines of server log.

**By reading:** the full diff against the merge base; the ticket, the prior cyber gate, the reviewer report and all four rounds of the dev report; the grep-verified enumerations of `creatorUuid`, its alternative spellings and the identity-cookie readers (fail-loud `/usr/bin/grep -ainr`, positive control in every invocation, 94 files covered, per `proof-by-absence`); `clientIpFrom`'s header precedence; `resolveRoomToken` returning `hostCodeHash`; `generateHostCode`'s 8-character base32; the room-mutator write pattern; `verifyRoomClaimToken`'s non-short-circuiting comparison loop; `claimCookieOptions`' absent `Domain`.

**Not verified at all:** behaviour on the Upstash driver (memory driver only throughout); whether Vercel's edge overwrites `x-real-ip` / `x-forwarded-for`, which is the whole question of whether O-B applies in production; the full Playwright suite; `npm run build` and the ES2019/CSS-target checks.

---

## Verdict

**APPROVE.** Both blockers are closed, and closed in the right shape: B-S1 by removing the conflict rather than hiding the value (`creatorUuid` has no authorization reads left, and the new credential is measurably unreachable from page JS with the harness proven able to see it), and B-S2 by two independent refusals that I separated with a valid-session probe so neither could be standing in for the other. The roll mechanism — the thing the Dev flagged as twice-wrong — is right: it writes nothing on the authentication path, and neither the eviction nor the lost-update race reproduces under concurrency.

The observations are worth reading in the order they are written, but none of them justifies holding this PR. O-A and O-B are the two that matter, and both are defects of `main` that I demonstrated are reachable without any code from this branch. Blocking a fourth round on them would be blocking this PR for someone else's bug.

Two things I want on the record for the merge decision rather than buried in a list: **logout revokes the claim credential, not host access** (O-A), so nobody should describe this feature as giving a compromised venue a recovery path; and **O1 is not fixed**, contrary to the round-3 report and to a code comment that states it as a property (O-B). The second is the more important of the two, not for its severity but for its shape — this is the fourth time on this PR that a confidently-worded sentence has outrun the code, after the B-S1 contract line, the O4 over-credit, and the `MAX_CLAIM_TOKENS` "devices, not issues" docblock, which O-C shows is also still wrong on the login path. The code got better every round. The habit of asserting a property in prose before pinning it in something that can fail has not.

## Friction

- The dev server's in-process room store is dropped whenever a route or page compiles for the first time, and it took me three runs of the B-S1 chain to get a valid one — the two void runs looked exactly like a *passing* security test (attacker 401) while the positive control was also 401. **A security probe whose negative and whose broken-harness state are the same output is not a probe.** Every conclusion here therefore carries a positive control in the same run; that is what separated the void runs from the real one, and it is worth being explicit in the cyber role doc: warm every page route too, not just the API routes, and treat a failing positive control as a void run rather than re-reasoning about the negative.
- The prior gate's Friction item asked for "one probe from a second browser profile and one from a bare HTTP client" on any authentication change. That is exactly what found both blockers last round and exactly what confirmed them closed this round, at a cost of about an hour. It should be a written step in the cyber role doc rather than a lesson each gate re-learns.
