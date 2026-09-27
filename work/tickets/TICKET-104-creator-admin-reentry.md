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
