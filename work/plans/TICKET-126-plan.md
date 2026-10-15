# TICKET-126 plan: per-person daily search cap + single-flight cache (folds in TICKET-119, TICKET-120)

Status: APPROVED by the boraoke Product TM 2026-10-14 ("Good plan; go"), with these amendments: PR A base `ticket/125-enter-idle-search`; device/IP caps env-configurable (defaults 10/45); production header check only if it writes no prod data; Upstash type checked before relying on a multi-key script; the room-write race filed as TICKET-127; TICKET-120 as PR B from `main` after PR A is up.

**Caps raised at the TL OK (2026-10-15):** the defaults below (10/device, 45/IP) were superseded before merge. The TL: "Lets increase the numbers, because we are rebuilding the search mechanism to allow more searchs. Otherwise the app will be shitty". Shipped defaults: **30 per device, 90 per IP (= the platform budget, so it never binds before the platform cap for one bar)**, platform 90 unchanged. The caps exist only to stop one abuser, never to throttle normal patrons. Env overrides and the clamp are unchanged. §2's numbers below are the original proposal, kept for the record.

Implementation outcomes that changed this plan are recorded in `work/reports/dev/TICKET-126-dev-report.md` (notably: §1's production check was run, read-only for data, and settled the header question; the Upstash database is standalone, so the multi-key script needs no hash tags).

## 0. What I read

- `lib/search-budget.ts` (TICKET-87: Pacific-day Lua counter, budget 90 = cap 100 minus margin 10, fail-closed, no refunds, deployed-without-Upstash denies).
- `lib/search-cache.ts` (L1 memory + Upstash `sc:` keys, fail-open).
- `app/api/search/route.ts` and `lib/live-search-gate.ts` on `ticket/125-enter-idle-search` (v2 marker, `live=1`, 2 s per-uuid in-memory cooldown, order: validate → rate limit → cache → index → liveRequired → key → cooldown → reserve → Google).
- `lib/host-auth.ts` `clientIpFrom` (x-real-ip first, then XFF first hop, `TRUSTED_CLIENT_IP_HEADER` override). The search route has its OWN `clientIp()` that reads the XFF first hop first.
- `lib/rooms.ts` `MAX_CLAIM_TOKENS` / `issueRoomClaimToken` (`[...hashes, new].slice(-5)`), `app/api/host/login/route.ts` (always `attachClaimCookie` → mint).
- `ticket/118-session-revocation` diff of `lib/rooms.ts` (adds `sessionEpoch`, `revokeRoomHostSessions` prunes `claimTokenHashes` to the presented hash in one read-modify-write with re-read/retry).
- MANAGER-LOG auth-surface warnings (three lockouts from writes on the auth path; concurrency probe required).
- Measurements: ticket-108 (real night: 90 billed calls for 24 queued songs, 3.75/song), ticket-124 (index: 0.84 to 1.22/song), ticket-125 (Enter/idle shipped: 0.89 billed per queued song, p5-p95 18-21 calls over the 24-song trace set; hit@10 89%).

## 1. TICKET-119: which IP header to trust (answered from the primary source)

Vercel, "Request headers", https://vercel.com/docs/headers/request-headers (last_updated 2025-12-13), verbatim:

- `x-forwarded-for`: "The public IP address of the client that made the request. If you are trying to use Vercel behind a proxy, we currently overwrite the X-Forwarded-For header and do not forward external IPs. This restriction is in place to prevent IP spoofing." (Custom XFF is honoured only with the Enterprise "Trusted Proxy" add-on, which this project does not have.)
- `x-vercel-forwarded-for`: "This header is identical to the x-forwarded-for header. However, x-forwarded-for could be overwritten if you're using a proxy on top of Vercel."
- `x-real-ip`: "This header is identical to the x-forwarded-for header."

Conclusion:

1. **On Vercel production the edge overwrites the IP headers**, so today's `clientIpFrom` (x-real-ip first) and even the search route's XFF-first `clientIp()` both get the true client IP. The host-code brute-force bound most likely **holds in production**. TICKET-119's measured reset (1200 rotating-XFF claims) was a non-Vercel run (local `next start`), where nothing overwrites anything. So 119 is a local/dev + non-Vercel-deploy weakness plus a false comment, not a live hole. Severity drops from MED.
2. **The header to derive from is `x-vercel-forwarded-for`**: Vercel sets it, and it's the one header Vercel documents as surviving a proxy placed in front of Vercel. Fallback order on Vercel: `x-vercel-forwarded-for` → `x-real-ip` → XFF first hop (all three are edge-written on Vercel per the doc).
3. **Caveat, stated plainly:** the doc is explicit that XFF is overwritten and says the other two are "identical". It does not separately say "a client-sent `x-vercel-forwarded-for` is stripped". The inference is strong but it's an inference. Proposed cheap confirmation (needs a TM go, it touches prod): from one host, send ~15 failed host-code logins against a throwaway prod room, rotating all three headers per request, and expect a 429 by around attempt 11. A 401 all the way through would mean the edge does NOT overwrite, and the bound is absent in prod.

Code change (single derivation, used by login, claim, rooms, queue, telemetry AND search):
- `clientIpFrom` decides trust by environment, not by header presence:
  - `process.env.VERCEL === "1"`: `x-vercel-forwarded-for` → `x-real-ip` → XFF first hop.
  - else if `TRUSTED_CLIENT_IP_HEADER` is set: only that header.
  - else: the constant bucket `"untrusted"`. **Fail-closed**: off Vercel with no declared trusted proxy, everyone shares one bucket. Over-throttling a dev box is fine, a rotatable bucket isn't.
- IPv6 addresses are normalised to their /64 prefix before use as a key (one subscriber typically holds a whole /64, so per-address keys are free rotation).
- jest and e2e set `TRUSTED_CLIENT_IP_HEADER=x-forwarded-for` explicitly (many tests drive buckets via XFF: `__tests__/host-claim.test.ts`, `api-search.test.ts`, `host-auth.test.ts`, `e2e/feedback-widget-safe-area.spec.ts`), so they keep working and say out loud what they trust.
- The search route deletes its private `clientIp()` and uses `clientIpFrom`.
- Fix every "server-derived" / "not client-controllable" claim (`lib/host-auth.ts` ~410 and ~439, `app/api/t/route.ts` ~39, the search route's comment, and the round-3 report line) to say what's true: trustworthy on Vercel because the edge overwrites, untrusted elsewhere unless declared.
- Prove-can-fail: a test rotating XFF with `VERCEL` unset and no trusted header must stay in ONE bucket. Against today's `clientIpFrom` it yields N buckets, so it fails on the old code.

## 2. Per-person daily caps: proposed numbers

**Proposal: per-device 10 billed calls/day, per-IP 45 billed calls/day, platform 90 (unchanged).** All counted on the same Pacific day as the platform counter.

Why these:

- **Unit cost.** After #88 + #89, a queued song costs ~0.89 billed calls (ticket-125 replay; Enter-only floor 0.84; worst p95 trace 21 calls over 24 songs ≈ 0.88). Retries after a miss (hit@10 is 89%) push a bad night toward ~1.3/song.
- **Device cap 10.** A patron sings ~3-6 songs a night. 6 songs × 1.3 ≈ 8 billed, so 10 leaves an honest heavy user headroom and only binds someone who isn't queueing what they search. One device then takes at most 11% of the platform day instead of 100%.
- **IP cap 45 (half the platform).** The only real night on record was 24 queued songs on one venue. A busy karaoke bar (4 h × ~4 min/song ≈ 60 songs) costs ~50 billed calls before cache sharing. Arithmetic first: **90/day only buys about 100 queued songs platform-wide, so one busy bar on one Wi-Fi IP is already most of the platform's capacity whatever we choose.** The rule that follows: **no single network may take more than half the day**, so at least a second venue always has 45 left. A per-IP cap low enough to stop a one-IP attacker taking a big share (say 15) would starve a normal bar by the 15th live search. That's the trade, and half is the line I'd draw.
- **Why not per-room as the bar-level bucket.** The `room` param is client-chosen and rooms are public, so a per-room cap doesn't bound an attacker (rotate rooms). It would only shape fairness between honest venues, while handing an attacker a way to starve one named venue by spending its room budget. Rejected as a bound. Possible later as a fairness layer.
- **Why the device cap is fairness, not security.** The device key is client-minted and rotatable (see below). The **IP cap is the anti-drain bound**, which is why TICKET-119 is a prerequisite. A many-IP attacker (botnet, mobile-data toggling) can still drain the platform 45 at a time. The platform cap stays the hard ceiling, and nothing at this budget size fixes a distributed attacker.
- **Mobile CGNAT** (common in Brazil) puts unrelated phones behind one carrier IP. 45 is lenient enough that this should rarely bind.
- Constants live in `lib/search-budget.ts`, next to `SEARCH_DAILY_BUDGET`, as named exports with this reasoning in the docblock. No env override (an env typo shouldn't silently lift a cap). Revisit when TICKET-111 telemetry gives real per-device numbers.

Device key, in order: the server-minted httpOnly `boraoke_identity` cookie if it holds a valid UUID, else the validated `uuid` param, else `anon@<ip>`. Keys are stored as an HMAC (keyed with an existing server secret) so no raw IP or uuid lands in Redis, matching identity-store's zero-PII invariant.

Mechanism:

- One atomic Upstash Lua script replaces `RESERVE_SEARCH_SCRIPT` for the live path. KEYS = [global day key, ip day key, device day key], ARGV = [90, 45, 10, ttl]. It checks all three first, then INCRs all three or none, and returns a distinct negative code for which cap denied. All-or-nothing means a denied request never half-charges a person, and the no-refund rule stays intact. Same 36 h TTL. The in-process fallback mirrors it inside one synchronous block.
- **Fail-closed** on unreachable or misconfigured Redis, the same choice as TICKET-87 and for the same reason (fail-open = unaccounted spend that outlives the blip). The personal caps add no new failure mode, because the same call already fails closed for the platform cap.
- Placement is unchanged: after cache, index, `liveRequired` and the cooldown, at the existing `reserveSearchCall()` site. Free tiers never touch a personal counter, so **index and cache results keep working for a capped person**. Single-flight waiters (below) are never charged.
- Denial response: `200 { degraded: true, reason: "personal-limit", results: [] }`, mirroring `daily-limit`. One reason covers both device and IP denials, so the body can't be used to probe which key is exhausted, and remaining counts are never returned. New `Search.personalLimit` copy in en/es/pt-BR, styled like `dailyLimit`. Draft: en "You've used today's live searches. Karaoke catalogue results still work, or paste a YouTube link." The es and pt-BR copy gets written natively in the same register, not machine-literal. The client shows it in the same slot as `dailyLimit`, and the current text's index results stay on screen.
- Legacy (pre-v2) clients pass through the same reserve, so they are capped too.

## 3. Single-flight lock on the cache

On a cache miss that is about to bill:

1. `SET sf:<cacheKey> <random token> NX PX 10000`.
2. **Leader** (got the lock): reserve (platform + personal), call Google, `setCachedSearchPage`, then release with a compare-and-delete Lua (`if GET == token then DEL`), so a leader never deletes a lock it no longer owns. On a Google error, also write a short `sf:<ck>:err` marker (PX 3000) so waiters stop waiting. If the reserve is denied, release the lock and return the denial.
3. **Waiter** (lock held by someone else): poll `getCachedSearchPage(ck)` every ~150 ms until a ~6 s deadline. On a hit, return it with `cached: true` (free, no personal charge). On the err marker, return `degraded: "error"`. If the lock disappears with no cache entry (the leader was denied or died), try once to become leader. On deadline, return `deferred: "single-flight"` with `retryAfterMs` instead of billing. A waiter never bills while a live leader exists.
4. Redis error on `SET NX`: proceed without the lock (**fail-open**). Single-flight is an optimisation, and the reserve below it is still fail-closed, so the worst case is N billed calls inside every cap, which is today's behaviour.
5. Without Upstash (dev/jest): an in-process promise map gives the same property per instance.

Concurrency probe (jest, faithful fake Redis with SET NX PX, async jitter between ops, a counting `fetch` mock): 20 concurrent identical requests across 4 simulated "instances" (separate L1s, shared fake Redis) → exactly 1 Google call, 20 identical result sets, platform counter +1, only the leader's device charged. Prove-can-fail: with the lock acquisition stubbed to always succeed (today's behaviour), the same probe yields 20 calls and the test fails. Verbatim failure output goes in the dev report. Also probes for leader error (waiters get degraded, 1 call) and leader denied (no call, no waiter charged).

## 4. TICKET-120: claim-token cap evicts the owner. Recommendation: SPLIT into its own PR

**Recommend a separate PR in the same ticket**, based on `main` (not on #89's search branch), sequenced with TICKET-118 by the Product TM. Reasons: it's a write on the authentication path, the class that recreated the lockout three times. It needs its own Cyber Security re-gate on the auth surface. It shares no code with the search work (the search PR's only auth-file change is `clientIpFrom`, which is read-only on the auth path). And it shouldn't wait on #88/#89's TL OK, or make the search PR's security review twice as wide.

Design (minimal write, minimal conflict with 118):

1. **Devices, not issues, on login.** If the login request already presents a live `boraoke_claim_<room>` cookie for this room (verifies against the stored hashes), re-send it via the existing `rollClaimCookie` instead of minting. Five logins from one tablet consume one slot. This reuses the no-write roll path that already ships.
2. **Owner pin, as a pointer.** Add an optional `ownerClaimTokenHash?: string` to `Room`. It's set in the same `create` write that stores the creation token's hash (atomic with creation, no race). It's a pointer to one entry of `claimTokenHashes`, not a second credential. `verifyRoomClaimToken` is **unchanged** (it still only checks the array). Eviction in `issueRoomClaimToken` changes from `slice(-5)` to "keep the owner hash if present, fill the remaining 4 with the newest others". So other people's logins can never evict the owner. Only devices that demonstrably know the host code get evicted, and they can type it again.
3. Logout (`revokeRoomClaimTokens`) still clears everything, and also clears the pointer. After a logout, the owner's next login token is an ordinary slot. Re-pinning on login is deliberately NOT done: deciding "this login is the owner" needs `creatorUuid`, which PR #81 showed is client-readable, so whoever knows code + uuid could steal the pin and evict the owner. That would recreate the lockout. Documented as the accepted limit.
4. Docblocks corrected on both paths (`MAX_CLAIM_TOKENS` and the login route).

Why this won't conflict badly with 118: 118's `revokeRoomHostSessions` prunes `claimTokenHashes` to the presented hash and never reads the new field. With the pointer design, a pruned-away owner hash just leaves a dangling pointer that pins nothing, and since verify ignores the pointer, revocation stays complete. That's the right semantics with zero 118 code change. Textual conflict is limited to adjacent hunks in `lib/rooms.ts` (the new `Room` field next to 118's `sessionEpoch`, and `issueRoomClaimToken`, which 118 doesn't edit) plus the login route. Whichever lands second rebases trivially. Optional tidy-up for whichever lands second: 118's prune also clears the pointer when it drops that hash. Not needed for correctness.

Concurrency probe (required by the MANAGER-LOG): the owner creates the room, then 30 logins from distinct clients run concurrently in batches against the room backend with interleaving. Assert the owner's claim token still verifies after every batch, and that a probe client presenting a live cookie gets no new hash. Prove-can-fail: run against today's `slice(-5)` and the owner-survives assertion fails after the 5th login. Verbatim output goes in the report.

**A pre-existing race found while reading, not fixed by this ticket:** `issueRoomClaimToken` (and every room write) is a whole-record read-modify-write with no CAS. Two concurrent logins can lose one appended hash, so one device gets a cookie that doesn't verify (a lockout of that new device, recoverable by retyping the code). Worse for 118: a login RMW that read before a revoke and wrote after it would **re-insert revoked hashes and roll back `sessionEpoch`**, un-doing a revocation that 118's re-read loop already confirmed. The 120 design does not make this worse (it removes most login writes). Flag it to 118's security gate, and file the atomic Lua room-mutation follow-up that 118's report already mentions.

## 5. PR shape

- **PR A (search), base `ticket/125-enter-idle-search`:** TICKET-119 IP derivation + comment corrections, per-device/per-IP caps, single-flight, trilingual copy, tests and probes. Touches `lib/host-auth.ts` (`clientIpFrom` only), `lib/search-budget.ts`, `lib/search-cache.ts` (lock helpers) or a new `lib/search-single-flight.ts`, `app/api/search/route.ts`, the client search component (new reason), `messages/*.json`, jest/e2e env for `TRUSTED_CLIENT_IP_HEADER`, tests.
- **PR B (auth), base `main`:** TICKET-120 only. Sequenced by the TM relative to 118.

## 6. Risks

1. **Header inference.** The Vercel doc explicitly covers XFF overwriting. That the other two are equally unspoofable rests on "identical". The prod probe in §1 settles it, but it needs a TM go.
2. **Off-Vercel fail-closed bucket.** Any non-Vercel deploy (none today) without `TRUSTED_CLIENT_IP_HEADER` throttles everyone together. Intended, but loud: log once at boot.
3. **Bar Wi-Fi.** A genuinely huge night on one IP can hit 45 before closing. Patrons still get index, cache and paste-link, and the copy says so. This is the stated trade.
4. **Stacked base.** PR A sits on #89, which is being rebased and is unapproved, so PR A rebases whenever #89 moves, and it can't merge before #88 and #89.
5. **Waiter latency.** A waiter can block up to ~6 s inside a serverless invocation (cost and duration). Bounded by the deadline, then `deferred` instead of billing.
6. **Upstash multi-key EVAL.** Fine on a single-region Upstash DB. If the DB is ever a cluster, the three keys need a hash tag. To check against the actual DB type before building.
7. **e2e workers=1 / shared default room.** The new tests are jest-level. One e2e for the capped message at most, gated on the canary.
