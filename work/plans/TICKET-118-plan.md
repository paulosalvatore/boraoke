# TICKET-118 — Plan: revoke outstanding host sessions

**Status:** written 2026-10-02. Worktree `.worktrees/t118-session-revocation`, branch `ticket/118-session-revocation`.

## 1. The three options, weighed

### C — re-derive from a rotated host code. REJECTED.
The code is shown exactly once at `/new` and only its hash is stored (`lib/rooms.ts:120-126`, `hashHostCode`'s key is frozen); it is unrecoverable by design. Rotating it means the venue must redistribute a new code to every staff device — and a venue that cannot produce the old code cannot be handed the new one either. It also conflates the human-facing credential with the session secret, which is what makes the current design unrotatable in the first place. Rotating it would *be* the shown-once-unrecoverable dead end TICKET-104 exists to remove.

### B — server-side session records. REJECTED (for this ticket).
It buys per-session revocation, which nothing in the ticket asks for. The cost is exactly the thing that has bitten three times: it turns `requireHost` — today a pure read on every host API call — into a stateful path, and a per-session record has to be *written* (at mint, and on every rolling refresh, which is every `GET /api/host/session`). The shipped TICKET-104 design works precisely because it writes nothing on the authentication path. Adding a write to the hottest auth path to gain a granularity nobody requested is the wrong trade.

### A — a rotatable per-room session epoch mixed into the derivation. CHOSEN.
It is additive (`Room.sessionEpoch?: number`, same optional-field-no-migration contract as `settings.language` / `settings.moderation`), it needs **no new store read** on the auth path (both derivation sites already `getRoom` via `resolveRoomToken`), and it needs **no write** on the auth path at all. The only write is on the revocation route itself, fired by one explicit owner action.

## 2. How the lockout class is ruled out — structurally, not by care

This is the part the ticket says must be answered explicitly. Three distinct properties:

**P1 — zero writes on the authentication path.** `issueSession`, `verifySessionValue`, `requireHost`, `verifyClaim`, `rollClaimCookie` stay pure reads. The epoch is *read* from the same `getRoom` that already fetches `hostCodeHash`; I refactor `resolveRoomToken` into `resolveRoomSecret(roomId) -> {token, epoch} | null` so the read count is unchanged (one `getRoom`, as today). Nothing a returning device does writes anything. The round-1 eviction and the round-4 lost-update race both needed a write on that path; there is none to lose.

**P2 — the acting device never depends on a write landing, and never depends on the response arriving.** This is the design's load-bearing choice. The revoke does NOT clear every claim token and re-mint one for the caller. It **keeps exactly the acting device's own claim-token hash** and drops the rest, in the *same single* read-modify-write that bumps the epoch. Consequences:
- the acting device's `boraoke_claim_<room>` cookie is untouched and still live, so no new cookie has to reach the browser for it to retain access;
- if the response is lost entirely (network drop after the write commits), the acting device's next admin mount auto-claims with that surviving token and gets a fresh session at the new epoch. **There is no response-delivery lockout window.**
- the response does also carry a freshly derived session cookie, as a convenience, so the open dashboard keeps working without a round trip.

**P3 — a lost update degrades to "revocation did not take", never to "owner locked out".** There is no CAS for room records (`RoomBackend` is get/create/update/count; Upstash `update` is a plain `SET`), so a concurrent `issueRoomClaimToken` / `setRoomMode` can clobber the bump (the pre-existing O-I pattern). Mitigation: after the update, re-read and confirm the epoch advanced; retry a bounded number of times. And critically, the acting device's replacement session is derived by calling the ordinary `issueSession(roomId)` **after** the write, which re-reads the room — so it is always derived from the epoch that is *actually stored*. There is no code path on which the caller is handed a session cookie that will not verify.

**Concurrency probe (required, since a probe is what caught the round-4 race):** N concurrent revokes from the acting device; N concurrent revokes interleaved with `issueRoomClaimToken`; N concurrent authenticated session probes during a revoke. Assert in every case: the acting device's claim token is still live, a fresh claim still yields a working session, and a pre-revoke session is dead.

## 3. Deliberate scope choice — logout is NOT changed

Today `POST /api/host/session` (logout) already calls `revokeRoomClaimTokens`, which clears **every** device's claim hash. I am not adding an epoch bump to it. Reason: logout's normal meaning is "get me off this shared tablet", and making it also kill the owner's own phone's live session would be a behaviour regression on the ordinary path — exactly the dead end this family removes. The venue-facing lever the ticket asks for is a *separate, explicitly labelled* action.

Not escalating this as a product decision for the Tech Lead, and the reason is that the design removes the fork rather than answering it: "does revoking sessions force re-entry of the host code?" is **no for the acting device** (its claim token survives, P2) and **yes for every other device** (which is the literal meaning of the affordance, and is already what today's logout does to every other device's claim credential). No new product cost is introduced over shipped behaviour. The residual — other legitimate staff devices need the shown-once code — is the pre-existing TICKET-104/120 surface, and it goes in the confirm copy in plain language rather than being hidden.

## 4. Files touched

| File | Change |
|---|---|
| `lib/rooms.ts` | `Room.sessionEpoch?: number` (+ docblock, kept out of `PublicRoom`); `normaliseSessionEpoch` (pure); `getRoomSessionEpoch`; `revokeRoomHostSessions(roomId, {presentedClaimToken})` — one RMW: bump epoch + prune claim hashes to the presented one, with verify-and-retry |
| `lib/host-auth.ts` | `sessionValue(token, epoch)` — epoch 0 keeps the byte-identical legacy HMAC message; `resolveRoomSecret` (one `getRoom`, returns token+epoch); `issueSession` / `verifySessionValue` derive through it; `resolveRoomToken` kept as a delegating export |
| `app/api/host/revoke-sessions/route.ts` | NEW. Same two independent refusals as logout (`isCrossSiteRequest` ‖ `!requireHost`), same undifferentiated 401, no room-existence oracle. Then one revoke write, then re-derive the caller's session cookie and roll its claim cookie |
| `app/(patron)/[room]/admin/AdminRoom.tsx` | "Sign out all other devices" trigger in the header, inline two-step confirm (house pattern), own `data-testid`s, own distinct confirm label so no existing `name: "Confirmar"` locator becomes ambiguous |
| `app/(patron)/[room]/admin/admin.module.css` | styling for the destructive trigger + the warning line |
| `messages/pt-BR.json`, `en.json`, `es.json` | new `Admin.*` keys in all three (pt-BR authored first; `i18n-completeness` requires identical leaf keys) |
| `__tests__/host-session-revocation.test.ts` | NEW — the regression suite |
| `e2e/creator-reentry.spec.ts` | new describe: a session another browser context already holds stops working after the owner signs out all devices |

## 5. Test strategy (and how it is proven able to fail)

The hollow shape to avoid: a test that only checks the acting device still works, or one that passes because the stolen *claim token* died (claim revocation already works on `main` — it is not what this ticket fixes). So the core assertion uses a session value **minted directly, with no claim token in play**:

1. mint session S for the room (`issueSession`) — assert a real host route accepts it (200 positive control);
2. owner revokes;
3. assert S → `verifySessionValue` false, `POST /api/host/moderation` with S → 401, and `GET /api/host/session` with S → 401 **setting no cookie** (the re-gate's exact finding was that it rolled itself a fresh 30-day cookie).

Reverse-check, two parts, both with verbatim output in the dev report:
- revert only the derivation change (`sessionValue` back to the epoch-free HMAC), keep everything else → the revocation assertions must FAIL;
- make the epoch bump a no-op, keep the claim pruning → the revocation assertions must still FAIL (proves the suite is not being carried by the pre-existing claim revocation).

Plus: back-compat pin (a legacy record with no `sessionEpoch` derives the byte-identical pre-fix session value, so deploying logs nobody out); epoch monotonicity across repeated revokes; the full guard matrix copied from the logout tests (cookie-less, wrong session, cross-site, foreign Origin, another room's session, no oracle); `default` room not revocable; `PublicRoom` never carries the epoch; the concurrency probe in §2; and a mutation pass on `normaliseSessionEpoch` (a new pure normalisation function on an auth/identity path — triggered).

## 6. Gates

`npm test`; `npm run test:e2e` reported as a distribution with its condition stated; `npm run build` (which runs the ES2019 bundle check and `check-css-target.mjs`). Ports 3180-3189. One suite at a time, never concurrently.

## 7. Risks

- **R1** lost update clobbers the bump (no CAS). Mitigated by the single combined RMW + verify-and-retry; residual is "revocation did not take", surfaced to the client as a failure rather than a false success. Noted as a follow-up candidate (a Lua-EVAL atomic bump, mirroring `lib/store/upstash.ts`'s `MERGE_SCRIPT`) rather than built here — the room backend's Redis client is not injectable today, so an atomic path would also need a test seam.
- **R2** adding a second header control to a crowded admin header on narrow viewports. Checked against the 390px layout.
- **R3** existing e2e specs locate `getByRole("button", { name: "Confirmar" })`. Avoided by giving the revoke confirm a distinct label.
