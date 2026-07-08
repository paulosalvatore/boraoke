# Spec — Accounts & identity (anon-first)

- **Product:** cantai (name-agnostic — no product name in schema keys or copy specced here)
- **Author:** Product Owner (TICKET-22)
- **Date:** 2026-07-07
- **Status:** proposed — feeds TICKET-26 (anonymous identity registry, wave 4) and TICKET-28 (host accounts, wave 5)
- **TL directive (verbatim intent, binding):** room creators can start anonymous, then sign up and everything gets retroactively registered — register anonymous users from the start; admins get login + their stats/history (all karaoke days, songs played, what's happening now).

## The model in one paragraph

Every visitor is a **real user from first touch** — an anonymous one. The server issues and records an identity the moment a device shows up; every room created, song queued, and feedback sent is keyed to it. Signing up (Google OAuth) never creates a "new" user: it **claims** an existing anonymous identity and everything attached to it, retroactively. Login is therefore always optional for singing and always worth it for hosting — the product's zero-friction promise and the admin's ownership needs stop being in tension.

## Layer 1 — Anonymous identity registry (TICKET-26, wave 4)

### What exists today (honest baseline)

A client-generated `patronUuid` lives in localStorage and rides along on submissions and feedback. It is client-minted, unregistered server-side, and rooms don't durably record who created them. That is an identifier, not an identity — nothing can be claimed against it later.

### What changes

1. **Server-issued identity.** On first touch (any page load without a valid identity cookie), the server mints a uuid, writes an identity record to the durable store (`identity:{uuid}`: createdAt, lastSeenAt, userAgent-class only — no fingerprinting), and sets it as an httpOnly cookie. localStorage keeps a copy for resilience; the cookie is authoritative.
2. **Continuity with the existing patronUuid.** If a device already has a legacy localStorage patronUuid, the registration call sends it and the server adopts it as the identity's uuid (or records it as an alias) — existing patrons keep their history and their own-row highlighting.
3. **Everything gets stamped.** Room creation writes `creatorUuid`; queue entries, feedback, and telemetry already carry the uuid — they now carry a *registered* one. New index: `identity:{uuid}:rooms` (rooms created), enabling the later claim in O(1).
4. **No PII at this layer.** The anonymous record contains zero personal data; nickname stays room-scoped and ephemeral as today. This keeps the LGPD surface of the free flow as small as it is now.

### Acceptance criteria (TICKET-26)

1. A fresh device's first page load produces exactly one durable identity record, and repeat loads reuse it (cookie survives browser restart; localStorage fallback covers cookie-cleared-but-storage-intact).
2. A device with a pre-existing patronUuid continues under that uuid with no visible change (own-row highlighting still works; no duplicate identity created).
3. Room creation persists `creatorUuid`, and `identity:{uuid}:rooms` lists it.
4. Identity issuance is fail-open: if the store is down, the client falls back to local-only uuid and the flow works (registration retries on next touch).
5. Zero PII fields exist in the identity schema; a schema comment states this invariant.

## Layer 2 — Host accounts: Google OAuth + retroactive claim (TICKET-28, wave 5)

### Sign-in

- **Auth.js (NextAuth) with the existing Google OAuth client** — the client already exists, no new provider setup. Google-only at launch (one button, no password ops, no email flows); provider list can grow later behind the same account model.
- Sessions via Auth.js JWT/cookie; account records in the same durable store family (`account:{id}`: provider, providerAccountId, email, displayName, avatarUrl, createdAt).

### The claim (the heart of the model)

- On first sign-in from a device, the server links the device's anonymous uuid to the account: `account:{id}:uuids += uuid`, `identity:{uuid}.accountId = id`.
- **Retroactive registration:** everything already keyed to that uuid — rooms created, songs queued, stats — is now the account's, with no data migration: ownership resolves through the uuid→account link at read time. The claim is a link write, idempotent, reversible.
- **Multi-device merge:** signing in on a second device links that device's uuid to the same account; the account's history is the union of its uuids' histories. Collision rule: a uuid already linked to a *different* account never silently re-links (surface an explicit "this device was linked to another account" path).
- **Guests can claim too** (same mechanism, zero extra build): a patron who signs up owns their song history across venues — the seed of a future guest-side profile, at no additional cost now.

### Migration of pre-auth rooms (rooms created before TICKET-26)

- Legacy rooms have no `creatorUuid` — the uuid-claim can't reach them. Claim path: **host-token proof** — whoever presents the room's host token (the existing admin credential) may attach the room to their account, once (`room.claimedBy` set; subsequent claims rejected).
- One-time backfill: rooms created between TICKET-26 and TICKET-28 already carry `creatorUuid` and claim automatically; only pre-26 rooms need the token path. Sunset: after N weeks (TL sets; propose 8), unclaimed legacy rooms simply remain anonymous — no forced migration, nothing breaks.

### What an account gets (admin value, TL directive)

- **My karaoke days:** list of rooms/sessions they own, with date, venue name, songs played, patron count.
- **Per-day drill-in:** full played-song history, mode used, host actions.
- **Live now:** owned rooms currently active, one tap to the admin page, patron page, and TV page. (The rich dashboard UX itself is TICKET-31; TICKET-28 ships the ownership + a functional account page skeleton.)
- Room ownership survives host-token loss: a signed-in owner can re-issue the host token for their room — today's "token lost = room orphaned" failure disappears.

### Acceptance criteria (TICKET-28)

1. Google sign-in creates an account, links the current device uuid, and the account page lists every room previously created anonymously on that device — with zero user action beyond the OAuth consent.
2. Sign-in on a second device merges its uuid into the account (history union visible); a uuid owned by another account is never silently re-linked.
3. A pre-TICKET-26 room is claimable exactly once via host-token proof, and rejects a second claim.
4. Signing out returns the device to a working anonymous state (singing/joining unaffected).
5. Account deletion works end-to-end: PII record erased, uuids unlinked and returned to anonymous status, rooms/stats remain but ownerless (see LGPD below).
6. All auth surfaces sit behind the TICKET-27 bot guards.

## Privacy & LGPD (PII enters the system here — this section is load-bearing)

Until now the product held no personal data by design. Accounts change that: email, name, and avatar from Google are **dados pessoais** under LGPD. Posture:

- **Minimization:** store only what Google's basic profile returns and we display (email, name, avatar). No phone, no address, no contacts scopes — ever, until a feature demonstrably needs it and the TL approves.
- **Purpose limitation:** account data exists to attribute ownership and show the owner their history; it is never sold, never used for ads (consistent with the no-ads recommendation in `early-access-monetization.md`), never joined onto guest telemetry (telemetry stays anonymous-uuid-keyed; account resolution happens only in the owner's own views).
- **Legal basis:** contract performance (LGPD art. 7º V) for account features; telemetry remains anonymous/legitimate-interest as today.
- **Deletion (art. 18):** self-service account deletion in TICKET-28 v1 — erase the account record, unlink uuids, anonymize ownership. Not a support-ticket flow; a button.
- **Transparency:** a plain-language privacy page (pt-BR + en) ships in the same PR as sign-in — "what we store, why, and how to delete it" — because trust is part of the product. The existing "anonymous, no ads" telemetry note extends to cover accounts.
- **Cross-border note:** data sits on Upstash/Vercel (US regions) — the privacy page discloses international transfer per art. 33.
- Full ToS/DPO formalization is Phase 5 (1.0) ops-hardening scope; this ticket ships the honest minimum viable privacy posture, not a legal department.

## Explicitly out of scope (this spec)

- Email/password or magic-link auth (Google-only at launch).
- Guest-facing profile pages / social features (the claim mechanism enables them later; nothing UI ships now).
- Roles/teams (multiple admins per venue) — future; the schema keeps `room.ownerAccountId` singular but not structurally exclusive.
- Payments identity (MP buyer/seller linkage) — `platform-aggregation.md`, wave 7+.

## Key decisions for the record (PO proposes, TL confirms)

| # | Decision | Rationale |
|---|---|---|
| I-1 | Server-registered anonymous identity from first touch (not signup-time creation) | TL directive; makes retroactive claim a link, not a migration |
| I-2 | Claim = uuid→account link, resolved at read time; no data rewrite | Idempotent, reversible, O(1); avoids a migration class of bugs |
| I-3 | Google OAuth only at launch, via Auth.js + existing client | Zero new provider ops; one-tap on Android-heavy BR market |
| I-4 | Legacy pre-26 rooms claim via host-token proof, once | Only credible ownership proof that exists for them |
| I-5 | Telemetry stays anonymous-keyed; account joins only in owner-facing views | Keeps the LGPD surface minimal and the telemetry promise honest |
| I-6 | Self-service deletion ships with sign-in, not after | LGPD art. 18; trust posture; cheap now, expensive retrofitted |
