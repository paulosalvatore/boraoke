# TICKET-132 — A stranger can spend a patron's 10 daily live searches, because the identity cookie is the public patron uuid

**Filed:** 2026-10-15, by the TICKET-126 Dev, from Cyber Security finding L-2 on PR #90 (`work/reports/security/TICKET-126-security.md`). Not fixed in TICKET-126.
**Priority:** LOW
**Type:** Security / abuse (per-device search share)
**Size:** S

## What

TICKET-126 charges each billed search to a per-device daily share of 10. The device key (`deviceKey` in `app/api/search/route.ts`) prefers the `boraoke_identity` cookie, and that cookie's value is the patron uuid (`lib/identity.ts`).

The patron uuid is not secret: `GET /api/queue` returns the raw queue entries, including `patronUuid`, to anyone who can open the room.

## Repro

1. Read a room's queue (`GET /api/queue?room=<id>`) and pick a patron's `patronUuid`.
2. Send 10 live searches with `Cookie: boraoke_identity=<that uuid>` and 10 distinct queries. (With no cookie, `&uuid=<that uuid>` reaches the same victim through the `u:<uuid>` fallback key.)
3. The victim now gets `personal-limit` on live search for the rest of the day.

Cost to the attacker: 10 of their own IP's 45 daily searches. The victim keeps the karaoke index, the cache and paste-a-link; only their live search is gone.

## Why it matters

TICKET-126's plan describes the device key as "client-minted and rotatable", which covers an attacker evading their own cap. It does not cover the opposite direction: charging someone else. In a bar, a prank on a known patron costs nothing to set up.

## What's needed

Pick one:

- **Sign the identity cookie** (HMAC over the uuid with a server secret), and key the device share only on a cookie that verifies. Note the second door: the fallback key `u:<uuid>` comes from the `uuid` query parameter, which is the same public uuid, so a forged cookie must NOT fall through to `u:<uuid>` either (fall through to `anon@<ip>`, or drop the `u:` key). Check what else reads `boraoke_identity` (`lib/host-auth.ts`, `lib/identity.ts`) before changing its format, and keep existing unsigned cookies working (treat them as unsigned, re-issue signed).
- **Stop exposing `patronUuid`** in `GET /api/queue` (return a per-room opaque id instead), if nothing on the client needs the raw uuid.
- **Accept and document** the residual, if the TL judges it not worth the change.

## Constraints

- Read **`prove-your-test-can-fail`**: the regression test must spend a victim's share using only the uuid read from `GET /api/queue`, and must FAIL against today's code.
- Read the `handle-secret` skill before adding a signing secret.
