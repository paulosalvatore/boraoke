# TICKET-118 — Dev report

**Status:** EXPLORING → planning. Worktree `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t118-session-revocation`, branch `ticket/118-session-revocation`.

## Picking up from

Fresh ticket, no prior Dev. Read: the ticket, `work/reports/cyber/TICKET-104-security-gate.md`, `work/reports/cyber/TICKET-104-security-regate.md` (finding O-A is this ticket), `prove-your-test-can-fail`.

## The defect, restated from the code

- `sessionValue(token)` (`lib/host-auth.ts:151`) = `HMAC(token, "cantai-host-session-v1")`. Pure function of the room secret. `issueSession` → `sessionValue(resolveRoomToken(roomId))`; `verifySessionValue` recomputes the same value and compares.
- `resolveRoomToken(roomId)` (`:125`) returns the room's `hostCodeHash`, which is immutable (the raw code is shown once and never stored, so it cannot be rotated).
- Therefore every session cookie for a room is the same 64 hex chars for the room's whole life, and nothing anywhere can invalidate one.
- `POST /api/host/session` (logout) already does `revokeRoomClaimTokens(roomId)` — which clears **every** device's claim hash (`lib/rooms.ts:210`). So the claim credential is already revocable house-wide; the session is the only part with no lever.

---

# RESUME NOTE — written at a forced stop (machine reboot, 2026-10-02)

**Read this plus the ticket and you have everything. `work/plans/TICKET-118-plan.md` carries the long-form reasoning; this is the short version plus exactly what is left.**

## Status

Implementation **complete and committed**. The new regression suite is **written and green (32/32)**. What is NOT done is the gate evidence: the full `npm test`, `npm run test:e2e` distribution, `npm run build` (ES2019 + CSS-target checks), the e2e spec addition, the two reverse-checks, the mutation pass, and the PR. No server was ever started; no background job exists; ports 3180-3189 were never used.

## The decision, and why — this is the expensive part

**Chosen: option A, a rotatable per-room session epoch mixed into the derivation.** `Room.sessionEpoch?: number`, folded into `sessionValue`'s HMAC message.

**Why not C (re-derive from a rotated host code):** the code is shown once at `/new`, only its hash is stored, and `hashHostCode`'s key is frozen — it is unrecoverable by design. Rotating it forces the venue to redistribute a new code to every staff device, and a venue that cannot produce the old code cannot be handed the new one either. Rotating it would *be* the shown-once-unrecoverable dead end TICKET-104 exists to remove.

**Why not B (server-side session records):** it buys per-session revocation, which nothing in the ticket asks for, at the cost of the one thing that must not change. `requireHost` is today a pure read on every host API call. A session record has to be *written* at mint and on every rolling refresh — i.e. on every `GET /api/host/session`. That is a write on the authentication path, and a write on the authentication path is precisely what recreated a lockout three times on this surface. Wrong trade.

**Why A is the right shape and not merely the smallest:** both derivation sites (`issueSession`, `verifySessionValue`) already call `resolveRoomToken`, which already does a `getRoom` for `hostCodeHash`. I refactored that into `resolveRoomSecret(roomId) -> {token, epoch}`, so reading the epoch costs **zero extra store reads and zero writes**. The revocation mechanism therefore adds *nothing at all* to the path a returning device takes.

## How the lockout class is ruled out — structurally, not by care

This is what the ticket demanded be stated explicitly. Three independent properties:

1. **Zero writes on the authentication path.** `issueSession`, `verifySessionValue`, `requireHost`, `verifyClaim`, `rollClaimCookie` are all still pure reads. The round-1 eviction and the round-4 lost-update race both needed a write there to lose; there is none.
2. **The acting device depends on neither the write landing nor the response arriving.** This is the load-bearing design choice, and it is why `revokeRoomHostSessions` takes `presentedClaimToken`: it **keeps the acting device's own claim-token hash** and prunes only the others, in the *same single* read-modify-write that bumps the epoch. So that device's `boraoke_claim_<room>` cookie is untouched and still live — nothing has to reach the browser for it to retain access. If the response is lost to a network drop after the write commits, its next admin mount auto-claims with that surviving token and gets a session at the new epoch. **There is no response-delivery lockout window.** The obvious alternative (clear all hashes, re-mint one for the caller) *would* have had one, and that is why I did not take it. There is a test for this: *"its claim token SURVIVES, so it needs nothing from the response to get back in"*.
3. **A lost update degrades to "revocation did not take", never to "owner locked out".** There is no CAS for room records (`RoomBackend` is get/create/update/count; Upstash `update` is a plain `SET`), so a concurrent `issueRoomClaimToken`/`setRoomMode` can clobber the bump. Mitigations: (a) after the update, re-read and confirm the epoch advanced, retrying up to `EPOCH_BUMP_ATTEMPTS`; (b) the caller's replacement session is derived by calling `issueSession` **after** the write, which re-reads the room, so it is always computed from the epoch that is *actually stored* — there is no code path that hands the caller a cookie which will not verify; (c) exhausted contention returns **503**, never a false success, because telling a venue owner an unauthorised session was ended when it was not is the worst failure this screen can have.

## Deliberate scope choice a successor must not "fix"

**Logout (`POST /api/host/session`) is intentionally NOT changed.** It already revokes every device's claim token. I did not add an epoch bump to it: logout's ordinary meaning is "get me off this shared tablet", and making it also kill the owner's own phone's live session would regress the common path into the code dead end. There is a test pinning this (*"logout is UNCHANGED — it does not bump the epoch"*). The lever the ticket asks for is a *separate*, explicitly labelled, confirmed action, and it is.

## The product-decision question, answered rather than escalated

The brief flagged "does revoking sessions also force re-entry of the host code?" as a possible escalation. I judged it **not** a fork needing the Tech Lead, because the design removes it: **no** for the acting device (its claim token survives), **yes** for every other device — which is the literal meaning of the affordance, and is already exactly what today's logout does to every other device's claim credential. **No new product cost over shipped behaviour.** The residual — other legitimate staff devices need the shown-once code — is the pre-existing TICKET-104/120 surface, and it is stated plainly in the confirm copy rather than hidden. *If the TM disagrees with that judgement, this is the paragraph to argue with.*

## What is implemented (commit `[TICKET-118] feat(host-auth): rotatable session epoch + sign out all devices`)

- `lib/rooms.ts` — `Room.sessionEpoch?: number` (documented, kept out of `PublicRoom`); `normaliseSessionEpoch` (pure); `getRoomSessionEpoch`; `revokeRoomHostSessions(roomId, {presentedClaimToken})` returning a discriminated `{ok:true,epoch,keptClaimToken} | {ok:false,reason:"no-room"|"contended"}`.
- `lib/host-auth.ts` — `sessionValue(token, epoch)`; **epoch 0 keeps the byte-identical legacy HMAC message** (`cantai-host-session-v1`), so shipping this logs nobody out and needs no migration; `resolveRoomSecret`; `resolveRoomToken` kept as a delegating export; the stale docblock that asserted sessions "cannot be revoked server-side" corrected (leaving it would have been the fifth confidently-wrong comment the re-gate complained about).
- `app/api/host/revoke-sessions/route.ts` — NEW. Same two independent refusals as logout (`isCrossSiteRequest` ‖ `!requireHost`), same undifferentiated 401, no room-existence oracle, 404 for `default`, 503 on contention.
- `AdminRoom.tsx` + `admin.module.css` — header trigger (`admin-revoke-button`), confirm panel **below** the header (`admin-revoke-confirm`) because the warning sentence cannot share a 390px row with four other controls, result toast (`admin-revoke-toast`). The acting device deliberately stays `auth === "authed"` on success.
- `messages/{pt-BR,en,es}.json` — `Admin.signOutAll{,Warning,Confirm,Done,Error}` in all three (pt-BR authored first). `i18n-completeness` + `i18n-locales` green (21/21). The revoke confirm has its **own** label, deliberately, so no existing `getByRole("button", { name: "Confirmar" })` locator in `host-controls.spec.ts` / `render-and-links.spec.ts` becomes ambiguous.
- `__tests__/host-session-revocation.test.ts` — NEW, **32/32 green**.

## Exactly what to do next, in order

1. **The two reverse-checks** (`prove-your-test-can-fail` duty (b), not yet done — the suite must be shown to FAIL against the pre-fix behaviour, with verbatim output):
   - **Part 1:** revert *only* the derivation — `sessionValue` back to `createHmac("sha256", token).update("cantai-host-session-v1")`, ignoring the epoch — keeping everything else. The revocation assertions must FAIL.
   - **Part 2 — do not skip this one, it is the important one.** Make the epoch bump a no-op (`target = current` in `revokeRoomHostSessions`) while keeping the claim pruning. The revocation assertions must *still* FAIL. This proves the suite is not being carried by the pre-existing claim-token revocation, which has worked since TICKET-104 and is **not** what this ticket fixes. The core assertions were written with a session value taken straight from `issueSession` and no claim token in play specifically so this holds — verify it rather than trusting it.
2. **Mutation pass on `normaliseSessionEpoch`** — duty (d) is **TRIGGERED**: it is a new pure normalisation function on an auth/identity path. Mutations worth running: drop the numeric-string coercion branch (the `"3"` case is the security-relevant one — failing open to 0 would resurrect every session the bump revoked); `Number.isInteger` → `Number.isFinite` (1.5); drop the `n < 0` guard; `>` → `>=`. Report each as KILLED / SURVIVED-equivalent / SURVIVED-real-gap. A SURVIVED-real-gap is blocking.
3. **Hollowing-out, duty (c) — declaration required either way, and it DID fire.** `issueSession`/`sessionValue` is a primitive beneath existing assertions, and I changed it. There are 18 `issueSession` call sites across `__tests__/` (`host-claim`, `host-auth`, `host-api`, `api-mode`, `api-moderation`, `api-admin-analytics`, `screen-token`). My read is that all of them mint and use a session with no revoke in between, so the epoch is 0 throughout and their assertions keep their original meaning — but **this must be walked file by file and written down**, not asserted. The `host-claim.test.ts` logout tests are the ones to look at hardest, and the "logout is UNCHANGED" test I added is the pin that makes them safe.
4. **The e2e spec.** Add a describe to `e2e/creator-reentry.spec.ts` (it already has the create-room helper and the B-S1/B-S2 describes): owner context A creates a room and is admin; context B copies A's session cookie (that byte-identical copy *is* the defect) and gets moderation 200 as the **positive control**; A clicks `admin-revoke-button` → `admin-revoke-confirm-yes`; B's moderation → 401 and B's session probe → 401 **with no Set-Cookie**; A is still admin. A failing positive control means a void run, not a passing security test — that is the re-gate's own Friction lesson and it applies here.
5. **Gates.** `npm test` (full), then `npm run test:e2e` **one suite at a time**, reported as a distribution with its condition stated (the suite is documented deterministic — 126/126 on 6 of 6 cold runs, ~4 min — so a failure means something and must not be dismissed as environmental). Check `e2e/_canary.spec.ts`: if it fails the run is **void**, discard it. Do not raise `workers: 1`. Then `npm run build` (which runs the ES2019 bundle check and `check-css-target.mjs`). Ports 3180-3189.
6. **Deliver** via `pr-deliver` as a **draft** PR, then `housekeeping`.

## Things learned that are not obvious from the code

- `npx tsc --noEmit -p tsconfig.json` reports **hundreds of pre-existing errors in `__tests__/**`** (jest globals are not in that tsconfig) plus one pre-existing error in `e2e/advance-auth.spec.ts:12`. Filter with `grep -E "^(app|lib|components)/.*error TS"` to get a meaningful signal. `app/` and `lib/` are currently clean.
- The admin logout label is the hardcoded literal `"Sair"`, not an i18n key — two earlier tickets deliberately skipped localising it because a sibling agent owned `messages/*.json` that cycle. I left it alone (e2e depends on it); it is a genuine small follow-up, not something to fold in here.
- `Admin.confirm` / `Admin.cancel` are **shared** with the queue-row remove confirm. Do not repurpose them for revocation wording.
- There is no fake-Redis seam for the room backend (`UpstashRoomBackend` builds its `Redis` inside `createBackend()` and is not injectable), so the concurrency probes run against the memory driver only. An atomic Lua-EVAL epoch bump — mirroring `MERGE_SCRIPT` in `lib/store/upstash.ts`, the only server-side atomic primitive in the repo — is the right follow-up for the contention residual in property 3, and it would need that test seam first. **Worth filing as a follow-up ticket; deliberately not built here.**
- `playwright.config.ts` runs a **production build** into `.next-e2e`, and `HOST` is `localhost` (not `127.0.0.1`) because prod-build cookies are `Secure` and Playwright's `APIRequestContext` only sends those to a trustworthy hostname. Any new API-level e2e assertion must respect that.
