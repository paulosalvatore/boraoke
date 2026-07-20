# TICKET-26 — Anonymous identity registry (Layer 1 of accounts-and-identity)

- **Product:** boraoke
- **Status:** draft → in progress
- **Priority:** P0 (roadmap reconciliation P0-4, `work/planning/boraoke-roadmap-reconciliation.md`)
- **Spec:** `work/planning/accounts-and-identity.md` — "Layer 1 — Anonymous identity registry (TICKET-26, wave 4)"
- **TL directive (verbatim intent, binding):** "register anonymous users from the start" — every day without it is permanently unclaimable history. This ticket is the foundation TICKET-28 (Google OAuth + retroactive claim) will build on; do not require login here.

## What to build

A server-side anonymous identity registry, wired into the patron join flow, without requiring login or collecting PII.

1. **Server-issued identity.** On first touch (no valid identity cookie), the server mints a uuid, writes a durable identity record (`identity:{uuid}`: `createdAt`, `lastSeenAt`, coarse `userAgentClass` only — no fingerprinting, no IP, no PII), and sets it as an **httpOnly cookie**. localStorage keeps a copy as a fallback; the cookie is authoritative.
2. **Continuity with the existing client-minted `patronUuid`.** The join flow already mints a client-side `patronUuid` (see `app/(patron)/[room]/PatronRoom.tsx`, `lib/store/types.ts` `QueueEntry.patronUuid`). The registration call must accept a pre-existing legacy uuid and adopt it as the identity's uuid (or record it as an alias) so existing patrons keep their own-row highlighting and no duplicate identity is created.
3. **Everything gets stamped.** Room creation persists `creatorUuid` (rooms currently don't durably record who created them — verify via `app/api/rooms/route.ts`). Queue entries already carry `patronUuid` — no schema break needed there, but the uuid should now be a *registered* identity's uuid. New index: `identity:{uuid}:rooms` (list of room ids created by that identity) — the O(1) hook TICKET-28's claim will read.
4. **No PII at this layer.** Identity record has zero personal-data fields. Add a schema comment stating this invariant explicitly (mirrors `lib/store/types.ts`'s existing comment conventions).
5. **Fail-open.** If the durable store is down, the client falls back to a local-only uuid and the join flow still works; registration retries on next touch. Do not block or break joining a room if identity registration fails.
6. **Design for future claim/merge (TICKET-28), without building it now.** The identity record shape and the `identity:{uuid}:rooms` index must be shaped so TICKET-28 can add `accountId` (nullable) to the identity record and link/merge without a data migration — a link write, not a rewrite. Do not build OAuth, accounts, or claim endpoints in this ticket.

## Acceptance criteria (from the spec, binding)

1. A fresh device's first page load produces exactly one durable identity record; repeat loads reuse it (cookie survives browser restart; localStorage fallback covers cookie-cleared-but-storage-intact).
2. A device with a pre-existing `patronUuid` continues under that uuid with no visible change (own-row highlighting still works; no duplicate identity created).
3. Room creation persists `creatorUuid`, and `identity:{uuid}:rooms` lists it.
4. Identity issuance is fail-open: if the store is down, the client falls back to a local-only uuid and the flow works (registration retries on next touch).
5. Zero PII fields exist in the identity schema; a schema comment states this invariant.

## Where to build it (follow existing conventions)

- Follow the `lib/store.ts` / `lib/store/types.ts` / `lib/store/memory.ts` / `lib/store/upstash.ts` driver-swap pattern (TICKET-6) for the identity registry — do not introduce a second storage abstraction. New keys (`identity:{uuid}`, `identity:{uuid}:rooms`) belong in the same `QueueStore`-family driver split (memory for local/CI, Upstash for prod), so it inherits the existing STORE_DRIVER env behavior and the existing test doubles.
- Wire registration into the patron join flow (`app/(patron)/[room]/PatronRoom.tsx` and/or a new `app/api/identity/route.ts`), and into room creation (`app/api/rooms/route.ts`) for `creatorUuid`.
- httpOnly cookie set via a Next.js Route Handler / Server Action — not readable from client JS (that's the point vs. the current localStorage-only `patronUuid`).

## Explicitly out of scope

- Google OAuth, sign-in, account records, claim/merge endpoints (TICKET-28).
- Bot prevention / Turnstile (TICKET-27).
- Admin dashboard / analytics UI (TICKET-31).
- Any PII collection.

## Tests required

- Unit tests for the identity store driver (memory + the interface contract), covering: first-touch mint, cookie-reuse on repeat, legacy-patronUuid adoption, `identity:{uuid}:rooms` population on room creation, fail-open behavior when the store throws.
- Playwright/App Tester coverage of the patron join flow end-to-end: fresh device gets an identity cookie; repeat visit reuses it; own-row highlighting still works.

## Gate chain

Dev → App Tester (join flow) → Cyber Security (identity/data, PII-zero invariant, cookie flags) → Reviewer. Deliver as a draft PR — **do NOT auto-merge** (every boraoke `main` merge is a live prod deploy, per the roadmap reconciliation's ops note). Hand off to the Tech Lead for merge confirmation.
