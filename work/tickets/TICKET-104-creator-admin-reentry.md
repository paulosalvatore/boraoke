# TICKET-104 — The room creator never types the room code: device-persisted admin re-entry + returning-creator homepage

**Filed:** 2026-09-27, from the Tech Lead's live test of 2026-09-26 (brief items 5-6)
**Priority:** HIGH — a creator who loses admin access has no recovery path at all.
**Type:** UX / auth
**Size:** M

## What the TL asked for

5. **The room creator should never have to type the room code.** Nobody hands the creator a code, so requiring them to type it to get back into admin is a dead end. Persist the creator's room + admin identity on their device and **keep the admin screen always reachable** for whoever created the room — auto-restore the admin view on return.
6. **The homepage adapts for a returning creator.** If the device has a created room, the **hero becomes their room(s)** with a clear "open admin / resume" CTA, instead of the generic create-a-room hero.

## What exists today (recon, 2026-09-27) — most of the machinery is already here

- **Creation** issues the raw `hostCode` **exactly once** in the `POST /api/rooms` response (`app/api/rooms/route.ts:150-162`); only `hashHostCode(code)` is stored (`lib/rooms.ts:101, 377-381`). It is displayed once in the UI (`app/new/page.tsx:136-147`, `data-testid="host-code"`). The room record also stores `creatorUuid`.
- **Admin auth is an httpOnly cookie, not a localStorage token** (`lib/host-auth.ts`): `cantai_host_<roomId>` (or `cantai_host` for `default`), value an HMAC-derived session over the room secret (`issueSession`/`verifySessionValue`, L173-183), **path-scoped to `/api/host`** (L192), on a **30-day rolling** window re-issued by a successful `GET /api/host/session` (`app/api/host/session/route.ts:41-43`).
- **The client already auto-restores** when that cookie is alive: `checkSession()` (`app/(patron)/[room]/admin/AdminRoom.tsx:92-101`) drives `auth: "checking" | "gate" | "authed"`, and only falls back to the code gate (L336-371) when the session check fails.
- **Created rooms are already remembered on the device**: `lib/room-memory.ts`, key `cantai_rooms_v1`, `RememberedRoom {id, name, role: "created" | "joined", lastTouched, claimable}`, written by `app/new/page.tsx:84` (`rememberCreatedRoom`).
- **A returning-creator UI already exists but is buried**: `components/SavedRooms.tsx` (`data-testid="saved-rooms"`) probes `GET /api/host/session?room=` for the top 3 created rooms and routes each admin link either straight in or to `?expired=1`. It renders **below** the hero and the feature bullets (`app/page.tsx:198`).

**So the real gap is narrower than it first looks, and it is worth stating precisely:** the creator is covered for 30 rolling days on the same browser. They fall off a cliff when the cookie is gone — expired past 30 days of not visiting, cleared, or a different browser/device — and at that moment the ONLY recovery is typing a `hostCode` they were shown once and almost certainly did not keep. That is the dead end. Item 6 is separately real: the affordance that would rescue them is rendered below the fold behind a generic hero.

## The security question this ticket must answer honestly, not route around

`lib/room-memory.ts:11-17` carries a deliberate invariant — **it never stores the host code**, with a defensive strip at L218-228. Item 5 as literally worded ("persist an admin token/secret on the device") asks to weaken exactly that invariant. Do not silently overturn it and do not silently refuse it either. The options, to be weighed and the choice recorded in the PR:

- **(i) Extend the cookie's reach** — longer/renewed rolling window, or re-issue on any visit to the room rather than only on an `/api/host` call. Keeps the secret httpOnly and out of JS. Does not help a new device.
- **(ii) A creator-claim path keyed on `creatorUuid`** — the room already stores it and the device already holds `cantai_patron_uuid`; `RememberedRoom` already has a `claimable` flag, which suggests this was anticipated. Lets a returning creator re-authenticate without the code, on that device, without persisting a secret in localStorage. **This looks like the intended design; prefer it unless it fails on inspection.**
- **(iii) Persist a token in localStorage** — literally what was asked, and the weakest: XSS-readable, and it makes every remembered room a standing credential. If chosen, it needs an explicit written justification.

A `creatorUuid`-based claim is an **authentication** path, so it gets adversarial attention: what stops a patron who learns a room id from claiming it, what happens when two devices claim, and what the blast radius is if `cantai_patron_uuid` is copied. Answer those in the PR body.

## Acceptance

- A creator returning to their room reaches the admin view **without typing anything**, on the same device, including after the current cookie window would have lapsed.
- The chosen mechanism is stated in the PR with its trade-off, and `room-memory`'s never-store-the-host-code invariant is either preserved or its weakening is explicitly justified.
- The homepage hero, on a device with a created room, leads with that room and a resume/open-admin CTA instead of the generic create hero; a device with no created room sees today's hero unchanged.
- The existing `cantai_`-prefixed keys are **not renamed** — renaming drops live user state (`lib/room-memory.ts:18-22`).
- `__tests__/room-memory.test.ts` still green; new logic lands in pure injectable-storage helpers matching that file's existing style (jest here is node-env only, no jsdom).

## 2026-09-28 CLOSE — security re-gate APPROVED (0 blockers). Merged with three follow-ups filed.

The first security gate **failed** this PR with two blockers. After two redesign rounds the re-gate **APPROVED** it with **0 blockers and 10 observations**, verifying both original attack chains **by execution, with a positive control in every run**.

- **B-S1 (credential exfiltration) — closed at the root, not patched.** Everything page JS can reach (`document.cookie`, every storage key, the `/api/identity` echo, both host probes) contains no trace of the token; 12 replay combinations from a fresh browser profile all 401, while the **real** token in a fresh profile does reach claim 200 + moderation 200 — so the harness could detect success and didn't. The old credential is inert: `creatorUuid` in a cookie, in the query and in the body all 401. "Zero authorization reads" was verified exhaustively (94 files, two positive controls firing): of 12 `creatorUuid` occurrences, 8 are comments and the rest are the type, the parameter and the single write.
- **B-S2 (cross-site logout lockout) — closed, both layers live and separable.** The exact exploit returns 401 and changes nothing. Five foreign-provenance variants against a genuinely valid session all 401, with same-origin / same-site / absent controls returning 200 — so neither guard is standing in for the other. No room-existence oracle (identical bodies, measured).
- **The roll mechanism — right as shipped.** No store write on the authentication path. 12 concurrent claims and 12 concurrent authenticated probes all 200 with the token still live. Neither the eviction defect nor the lost-update race reproduces, **because nothing is written to lose**.

### The lesson this ticket should be remembered for

**Every mechanism that WRITES on the authentication path recreated the lockout this ticket exists to remove — three times.** Round 3's capped token list evicted another device's credential; round 4's first rotation let two concurrent rolls each delete the presented hash, so a device could be **locked out by its own successful re-entry**; and the surviving `MAX_CLAIM_TOKENS` behaviour evicts the owner via other people's ordinary logins (TICKET-120). The shipped design writes nothing at all. **Rotation was never what secured this credential — server-side revocation is.**

A second, separate lesson: **a confidently-worded sentence outran the code four times** on this PR — the "cookie page JS cannot read" contract line, the O4 over-credit, the "server-derived" throttle key, and the "devices, not issues" docblock. The code improved every round; that habit did not. Two of those claims were corrected in the PR body at merge time rather than being left to propagate, which is the only reason they are not still believed.

### Filed, not fixed here (all pre-existing or not-worsened)

- **TICKET-118 (HIGH)** — logout revokes the claim credential but **not a host session already minted from it**, and the session value is a deterministic HMAC with **no rotation lever**, so a compromised venue has **no recovery path**. Do not describe this feature as providing one.
- **TICKET-119 (MED)** — the throttle key is **client-controlled** (`x-real-ip` / `x-forwarded-for`), so the host-code brute-force bound is resettable; reachable through the pre-existing login route alone. Whether Vercel's edge overwrites those headers in production is unverified and decides the severity.
- **TICKET-120 (MED-HIGH)** — the claim-token cap counts **issues, not devices**, on the login path: five staff logins evict the owner's phone back onto a code they were shown once.

Gates at merge: jest **55 suites / 996 passed / 5 skipped**, ES2019 and Chrome-68 floors OK, full-suite distribution **10 of 10 runs valid** (4 of 5 clean, changed spec 50/50), with the single failure cleared by file-order proof rather than assertion.
