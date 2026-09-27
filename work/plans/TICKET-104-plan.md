# TICKET-104 — Plan: creator admin re-entry without the room code

**Status:** implemented and delivered as PR #81 (draft)
**APPROVED-BY:** auto-approved (no plan-gate escalation) — validated downstream by gates + TL merge of PR #81
**Worktree:** `.worktrees/t104-creator-admin`, branch `ticket/104-creator-admin`

## Mechanism chosen: (ii) creator-claim — but keyed on the httpOnly identity cookie, not on localStorage

The ticket proposed keying the claim on `creatorUuid` "since the device already holds `cantai_patron_uuid`". Verified against the code, and the picture is better than the ticket assumed:

- `room.creatorUuid` is the **registered identity uuid** (`lib/rooms.ts:81`, written at `lib/rooms.ts:392` from `app/api/rooms/route.ts:116,130`), never exposed to any client (`PublicRoom` at `lib/rooms.ts:85-87`; `__tests__/rooms.test.ts:172` already asserts the absence).
- The **authoritative** copy of that uuid on the device is **`boraoke_identity`** — an httpOnly, root-path, **2-year** cookie (`lib/identity.ts:30,40`), i.e. 24x the 30-day host session. `cantai_patron_uuid` in localStorage is only a *fallback mirror* of it.
- `identity:<uuid>:rooms` already indexes the creator's rooms (`lib/identity-store.ts:61`); `listRooms()` exists with zero callers — a ready-made reverse lookup.

So the claim proof is already a server-set, JS-unreadable, long-lived cookie. Nothing needs to be persisted in localStorage, and **`lib/room-memory.ts`'s never-store-the-host-code invariant is preserved untouched** — not weakened, not worked around.

Rejected: (i) alone (a longer host-cookie window does not survive the cookie being *cleared*, and does nothing for the buried-hero half of the ticket); (iii) localStorage token (makes every remembered room a standing XSS-readable credential, for strictly less resilience than a 2-year httpOnly cookie).

## The privilege-escalation path this creates, and the guard that closes it

`createIdentityResolver` (`lib/identity.ts:104-127`) adopts a **caller-supplied** uuid verbatim when no identity cookie is present, and both `POST /api/identity` and `POST /api/rooms` then *set the identity cookie to it*. Benign today (nothing authorizes off `creatorUuid`). The moment a claim endpoint exists it becomes: `POST /api/identity {legacyUuid: <victim uuid>}` → httpOnly cookie for the victim → claim their room.

Guard (`lib/identity.ts`): in the **legacy-uuid adoption branch only**, refuse a caller-supplied uuid that already owns rooms server-side (`store.listRooms(uuid).length > 0`, or the lookup throws) and mint a fresh uuid instead. Cookie-presented uuids are unaffected (server-set, never client-asserted). Accepted cost: a pre-TICKET-26 device that created rooms and lost its identity cookie can no longer re-adopt its old uuid by asserting it — it falls back to the host code. That is the safe side of the ambiguity, and it is exactly the case an attacker impersonates.

## Files

| File | Change |
|---|---|
| `lib/identity.ts` | adoption guard (above) |
| `lib/host-auth.ts` | `verifyCreatorClaim(roomId, identityUuid)` — constant-time compare against `room.creatorUuid`; refuses when the room has none |
| `app/api/host/claim/route.ts` | **new** `POST` — identity cookie only, no body/query uuid accepted ever; per-IP throttle reusing the login counter; on match `issueSession` + `hostCookieOptions()` |
| `app/(patron)/[room]/admin/AdminRoom.tsx` | `checkSession()` 401 → one claim attempt before falling back to the gate |
| `lib/room-memory.ts` | `primaryCreatedRoom(rooms)` pure helper (injectable storage style) |
| `app/page.tsx` | returning-creator hero when a created room is remembered; generic hero unchanged otherwise |
| `messages/{pt-BR,en,es}.json` | new `Landing.*` keys (parity gate `__tests__/i18n-completeness.test.ts`) |

No change to `lib/store/types.ts` (frozen). No `cantai_*` key renamed.

## Tests

- `__tests__/host-claim.test.ts` (new) — match/mismatch/absent-creatorUuid/no-cookie, and that a body-supplied uuid is ignored.
- `__tests__/identity.test.ts` — adoption guard: supplied uuid that owns rooms is NOT adopted; one that owns none still is.
- `__tests__/room-memory.test.ts` — `primaryCreatedRoom` ordering / joined-only / empty.
- `e2e/creator-reentry.spec.ts` (new) — create room, drop the host cookie via `context.clearCookies`, reload `/[room]/admin`, expect the dashboard with **zero typing**; plus the homepage returning-creator hero.

Jest is node-env only, so all new logic is pure/injectable; UI behaviour is proven only in Playwright.

## Risks

- Memory identity driver is per-process, so claim continuity is only real on Upstash (same honest limit as every other store here).
- Two devices claiming the same room both succeed — unchanged from today, because `sessionValue` is a deterministic HMAC of the room secret and host sessions are already non-unique and non-revocable.
