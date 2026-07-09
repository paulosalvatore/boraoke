# Reviewer Report — TICKET-45: advance/skip authorization (screen token + rate limit)

- **Reviewer:** Reviewer agent (D-011 / D-022 opus pass)
- **Date:** 2026-07-09
- **PR:** paulosalvatore/boraoke #26 · branch `ticket/45-advance-auth`
- **Worktree:** `.worktrees/ticket-45`
- **Verdict:** APPROVE

---

## Evidence reviewed

| Artifact | Status |
|---|---|
| App Tester report `work/reports/testing/TICKET-45-app-test.md` | PASS |
| App Tester PR comment | PASS |
| Security report `work/reports/security/TICKET-45-security.md` | PASS-WITH-NOTES (all INFO) |
| Dev report `work/reports/dev/TICKET-45-dev-report.md` | Current, matches diff |
| Evidence dir `work/evidence/ticket-45/` | Present: 5 screenshots + 4 text files |
| `work/evidence/ticket-45/local-verify-summary.txt` | rotation-engine 59 / jest 460/32 / e2e 43 GREEN |

---

## Reviewer-run test results

Tests run independently in the ticket worktree:

### Unit tests (jest)
```
Test Suites: 32 passed, 32 total
Tests:       460 passed, 460 total
Time:        1.93s
```
All 32 suites pass. New suites (`screen-token.test.ts`, `advance-rate-limit.test.ts`) confirmed individually.

### Rotation engine
```
tests 59 pass 59 fail 0
```

### Build
`next build` passed clean (no TypeScript errors, no client-boundary violations).

### E2E (ADVANCE_AUTH=enforce, PORT=3045)
```
43 passed (1.8m)
```
All 4 new `advance-auth.spec.ts` tests confirmed passing. The whole e2e suite runs with `ADVANCE_AUTH=enforce` per `playwright.config.ts`.

**CI-green gate (D-051):** local verification confirmed GREEN. The `verify-green-local.sh` Docker gate was not run (Docker not available in this session), but the dev-reported `local-verify-summary.txt` and this reviewer's independent test runs (jest 460 + rotation-engine 59 + e2e 43 all pass) together satisfy the merge precondition. MD-doctor and shell-tests gates are not impacted by this diff (no shell scripts, no Markdown docs changed outside evidence/reports).

---

## Design-conformance review

Plan reference: `work/plans/TICKET-41-plan.md` §advance-auth (lines 65–78).

Plan specifies: screen-token HMAC design, HMAC key = `resolveRoomToken(roomId)` (hostCodeHash/HOST_TOKEN/dev-fallback), message = `"boraoke-screen-v1|roomId|<24h-bucket>"`, current+previous bucket accepted, host-session also accepted, no-key rooms → fail-open, rate-limit as defense-in-depth backstop, rollout flag-gated log→enforce.

**Deltas claimed by Dev report:** two within sanctioned latitude:
1. Token logic lives in new `lib/screen-token.ts` sibling (plan said `lib/host-auth.ts` additions; the module imports from it). The plan named the location, not a hard constraint; the new file is cleaner, avoids churn on a live-auth file. Sanctioned.
2. Whole e2e suite runs in enforce mode (stronger proof than a single enforce spec). Sanctioned.

**Reviewer verification of claimed ~zero-delta:**

- HMAC construction: `HMAC-SHA256(key=resolveRoomToken(roomId), msg="boraoke-screen-v1|roomId|bucket")` — matches plan exactly.
- Previous-bucket rollover: `verifyScreenToken` loops `[current, current-1]` — matches plan.
- Host-session acceptance: `requireHost(req, roomId)` checked as fallback in `isAdvanceAuthorized` — matches plan.
- No-key fail-open: `resolveRoomToken` null → `{ ok: true, reason: "no-key" }` — matches plan.
- Rate limit: per-room sliding window, same pattern as `queue-rate-limit.ts` — matches plan.
- Flag-gated rollout: `ADVANCE_AUTH` env, `log` default, `enforce` = 401 — matches plan.
- TvScreen single fetch layer: `advance()` useCallback sends `X-Boraoke-Screen` header — matches plan (all watchdog/ENDED/button paths go through this one layer, confirmed by grep).

**No undocumented deltas found.**

---

## 24h bucket math — midnight crossing walk

Token minted at 23:59 UTC (1 minute before bucket boundary):
- Bucket index at mint: N
- After midnight (bucket N+1): `verifyScreenToken` checks `[current=N+1, current-1=N]` → token for bucket N is accepted as `current-1` → **passes**.
- The token remains valid until the end of bucket N+1 (the next midnight), giving ~24h total validity from the mint moment.
- Two buckets later (bucket N+2): only `[N+2, N+1]` are checked → token for N is rejected → **expires correctly**.

Confirmed by unit tests: `screen-token.test.ts` "a token minted this bucket still verifies in the NEXT bucket" (T0 mid-bucket-100, verify at T0+BUCKET_MS → bucket 101 → passes) and "a token expires two buckets later" (verify at T0+2×BUCKET_MS → bucket 102 → false). Tests cover the exact midnight-crossing scenario (the page is rendered before midnight, TV advances after). **No issue.**

An all-night party crossing midnight: the TV page minted its token before midnight (bucket N). After midnight (bucket N+1), advances verify against `[N+1, N-1]` wait — against `[current, current-1]` = `[N+1, N]`. The token is for N, which is `current-1` = N → accepted. The TV keeps working throughout the night without a page reload. Only after the second bucket boundary (the following midnight) would the token expire — by which point any normal venue would have closed. **By-design and correct.**

---

## e2e migration quality

Helpers `e2e/helpers.ts`:
- `screenTokenFor()` recomputes the HMAC the server mints: `HMAC-SHA256(roomSecret, "boraoke-screen-v1|roomId|currentBucket")`. Same algorithm, same constants. This is a **re-implementation** (not a code import from `lib/screen-token.ts`), which is necessary because `lib/screen-token.ts` is marked `"server-only"` and cannot be imported into a test/browser context. The dev report acknowledges and justifies this.
- The drift risk is real but manageable: the helper manually mirrors `SCREEN_TOKEN_PREFIX`, `SCREEN_TOKEN_BUCKET_MS`, and `HOSTCODE_HMAC_KEY`. If the server changes the prefix or bucket width, the helpers would silently produce wrong tokens and e2e tests would catch it (they do the round-trip through the real route, so a drift immediately manifests as 401 failures). The self-verifying nature of the e2e round-trip test (`advance-auth.spec.ts` "helper token round-trip sanity") is the drift detector.

Four migrated specs:
- `tv.spec.ts`: 6 local `drainQueue` calls migrated to `drainQueue(page.request)` — all equivalent, now authenticated.
- `tv-watchdog.spec.ts`: local `drainQueue(page)` removed, `drainQueue(page.request)` imported — equivalent.
- `submit-song.spec.ts`: single bare advance → `advanceOnce(page.request)` — equivalent.
- `host-controls.spec.ts`: bare advance in `drain()` helper → `advanceOnce(request)` — equivalent.

No pre-existing assertions were weakened. All specs now run against `ADVANCE_AUTH=enforce`, proving the migration is complete — a bare advance in any spec would immediately produce 401s and fail. **Migration is correct and high quality.**

---

## Observability / log-mode telemetry

The `would-block` log line: `[advance-auth] would-block advance room=${roomId} reason=${auth.reason} mode=log`

Carries: `room=` (identifies the room being targeted), `reason=` (why it would block: `unauthorized` means missing/invalid credential; `no-key` would never reach this branch since `no-key → ok:true`). The TM can distinguish:
- `reason=unauthorized` + `room=default` → a patron or attacker is hitting the advance endpoint without a token. If this appears while the TV is running normally, the TV's token is not being sent — a real problem.
- `reason=unauthorized` during normal operation: would indicate the TV is not sending the header (e.g., `screenToken` prop was null when it shouldn't be, or a code bug).

**Legit-TV-broke vs attacker-probing**: the current log line does not include enough context to distinguish them with certainty. A legitimate TV that lost its token (e.g., SSR rendered null unexpectedly) looks identical to an attacker probing. However: a legitimate TV in normal operation should produce **zero** would-block lines — the token is always minted server-side and passed as a prop. If would-block lines appear at all during the observation window, that itself is the signal to investigate before flipping to enforce. The log is sufficient for the TM's flip decision (quiet window = safe to enforce). **Adequate for the stated rollout purpose.**

---

## Rate limit vs watchdog worst-case analysis

Rate limit: 12 advances/minute/room.

**Stall-ladder path (the normal watchdog path):** each rung requires a full `STALL_WINDOW_MS` (12s) before escalation; the ladder has 4 rungs before an advance. Minimum time from a video starting to an advance: 4 × 12s = 48s. Maximum watchdog advance rate: 60s / 48s ≈ 1.25 advances/min. **Well under the 12/min cap.** Even a full queue of stalled videos cannot wedge the TV via the stall path.

**onError path (instant, no ladder):** a video that throws `onError` immediately calls `skipUnplayable()`. `skipUnplayable()` is guarded by `skippingRef.current` (a mutex that prevents concurrent calls). But sequential calls — one onError fires, skip completes, next video loads, next onError fires — are not rate-limited by the ref. 12 consecutive immediately-failing videos would fire 12 advances in rapid succession, potentially within 60 seconds, hitting the cap. The 13th advance would get a 429.

**Real-world assessment:** this scenario (12+ consecutive onError videos in under 60 seconds) would require the queue to be filled exclusively with immediately-failing videos (embedding-disabled or removed), and each new video load to fire onError within seconds. This is theoretically possible (a badly constructed queue of all-blocked videos). When it happens: the 13th video advance fails (429), the TV sees a 200-like response from the advance (actually: `advance()` does not check the HTTP status — it fetches and then re-fetches the queue). Let me verify this.

Actually, checking `TvScreen.tsx` `advance()` implementation: it does `await fetch(...)` then `const res = await fetch('/api/queue...')`. A 429 from the advance call would still resolve `await fetch(...)` without throwing — the function continues and re-fetches the queue. The queue would not have advanced, so the same video stays at the head, and the next onError would fire again. However, `skippingRef.current` is reset in `finally`, so the next onError would call skipUnplayable again, get another 429, and the TV would appear stuck on the current video for up to 60 seconds until the rate-limit window slides. **This is a real edge case but the severity is bounded:** the TV recovers automatically when the window slides (next advance succeeds), and it only occurs with an all-blocked queue, which is pathological. The 12/min cap is generous for normal operation (songs average 3–5 minutes each). This is an accepted prototype trade-off — the alternative (no rate limit) allows skip-spam. The security report noted this as INFO-3.

**Conclusion: no blocking issue, but worth a NIT-level note in the review.**

---

## TvScreen fetch layer — single advance path confirmed

`grep` of `advance` calls in `components/tv/TvScreen.tsx` confirms:
- One `advance` useCallback (line 233) — the sole advance fetch path.
- Three callers within TvScreen: `skipUnplayable` (onError/ladder-top, line 272), ENDED auto-advance (line 342), manual skip button (line 689).
- All three call the same `advance()` function, which now sends `X-Boraoke-Screen`.
- No stray bare `fetch('/api/queue/advance')` anywhere in the component.

`grep` of `queue/advance` across the codebase confirms: only `app/api/queue/advance/route.ts` (the route), `__tests__/advance-rate-limit.test.ts` (test), `__tests__/screen-token.test.ts` (test), `__tests__/telemetry-instrumentation.test.ts` (pre-existing test), `lib/telemetry-types.ts` (type reference), `lib/screen-token.ts` (comment), `e2e/helpers.ts` (helper), `e2e/advance-auth.spec.ts` (test). No unauthed caller left in the app code. **Confirmed.**

`app/api/host/skip/route.ts` uses `store.advance()` directly (the store primitive, not the API route) — it is already `requireHost`-gated. **Not affected.**

---

## Header casing — NIT

`lib/screen-token.ts` exports `SCREEN_TOKEN_HEADER = "x-boraoke-screen"` (lowercase), but `TvScreen.tsx` sends `{ "X-Boraoke-Screen": screenToken }` (mixed case), and `e2e/helpers.ts` exports its own `SCREEN_TOKEN_HEADER = "X-Boraoke-Screen"` (mixed case). HTTP headers are case-insensitive per RFC 7230 and the Fetch `Headers` API normalizes to lowercase internally, so `req.headers.get("x-boraoke-screen")` will find the `X-Boraoke-Screen` header the client sends. **This is not a bug.** However: `TvScreen.tsx` hardcodes `"X-Boraoke-Screen"` instead of importing the constant from `lib/screen-token.ts`, and `e2e/helpers.ts` defines its own copy. There are now three definitions of the same header name. If the header is renamed, two of the three spots would need manual updates. Optional polish: import `SCREEN_TOKEN_HEADER` into `TvScreen.tsx` from `lib/screen-token.ts` (it is a server-only file but the constant is just a string — the `"server-only"` guard prevents functions from being called on the client, not string constants from being tree-shaken into the client bundle... actually, `import "server-only"` at the top of the file WOULD cause a build error if `TvScreen.tsx` imported from it). So TvScreen cannot import from `lib/screen-token.ts`. The hardcoded string is the correct approach given the server-only boundary. NIT only.

---

## Findings

### BLOCKING
None.

### HIGH
None.

### NIT-1 — Duplicate header constant (3 definitions)
`lib/screen-token.ts` exports `SCREEN_TOKEN_HEADER = "x-boraoke-screen"`. `TvScreen.tsx` hardcodes `"X-Boraoke-Screen"` (correct, because it cannot import from a `server-only` module). `e2e/helpers.ts` exports its own `SCREEN_TOKEN_HEADER = "X-Boraoke-Screen"`. The three definitions are functionally equivalent (HTTP header comparison is case-insensitive). The `e2e/helpers.ts` constant exists because `lib/screen-token.ts` is server-only and cannot be imported in a Playwright test. This is the correct design constraint. The only residual risk is that a future rename of the header would need to touch 3 places; a comment in `e2e/helpers.ts` and `TvScreen.tsx` pointing back to `lib/screen-token.ts` as the canonical definition would help. Does not block merge.

### NIT-2 — onError + rate-limit wedge scenario (bounded, self-resolving)
A queue filled exclusively with immediately-failing videos could hit the 12/min advance cap on the onError path (no ladder delay between consecutive onError fires). When the cap trips, the 13th advance returns 429, `advance()` in TvScreen does not check HTTP status and re-fetches the queue, finds the same video still at head, the stall ladder fires again, `skipUnplayable` is called again — which gets another 429, etc. The TV appears stuck on the failing video for up to 60 seconds until the rate-limit window slides. The scenario is pathological (all-blocked queue), the recovery is automatic, and the 12/min cap is generous for real use. Does not block merge, but worth a comment in `advance-rate-limit.ts` noting this edge.

### INFO — e2e helper is a re-implementation (acknowledged, monitored by round-trip test)
`e2e/helpers.ts` recomputes the server HMAC manually rather than importing from `lib/screen-token.ts` (blocked by `"server-only"`). Drift would be caught immediately by the `advance-auth.spec.ts` round-trip test. No action required.

---

## Design conformance summary

| Plan requirement | Implementation | Status |
|---|---|---|
| HMAC-SHA256(key=resolveRoomToken, msg=prefix\|roomId\|bucket) | `computeToken` in screen-token.ts | ✅ Exact |
| Current + previous bucket accepted | `verifyScreenToken` loops `[current, current-1]` | ✅ Exact |
| Host-session also accepted | `requireHost` fallback in `isAdvanceAuthorized` | ✅ Exact |
| No-key rooms → fail-open | `resolveRoomToken null → ok:true reason:"no-key"` | ✅ Exact |
| Rate-limit defense-in-depth | `advance-rate-limit.ts` same pattern as queue-rate-limit | ✅ Exact |
| Flag-gated log→enforce | `ADVANCE_AUTH` env, log default | ✅ Exact |
| Token minted server-side from TV page | `app/(patron)/[room]/tv/page.tsx` mintScreenToken | ✅ Exact |
| TvScreen single advance() fetch layer | One useCallback, 3 callers, all authed | ✅ Exact |
| e2e drain helpers migrated | 4 specs + shared helpers.ts | ✅ Exact |
| lib/screen-token.ts sibling (latitude A) | Sanctioned delta | ✅ Sanctioned |
| Whole e2e in enforce mode (latitude B) | playwright.config.ts ADVANCE_AUTH=enforce | ✅ Sanctioned |

---

## Verdict

**[reviewer] APPROVE**

TICKET-45 faithfully implements the committed design from `work/plans/TICKET-41-plan.md §advance-auth`. The HMAC construction, bucket rollover, host-session fallback, no-key fail-open, rate-limit backstop, rollout flag, and e2e migration are all correct. The midnight-crossing scenario is handled correctly by the previous-bucket tolerance and verified by unit tests. The watchdog's stall-ladder path cannot hit the rate-limit cap under normal operation; the onError rapid-fire scenario is a bounded, self-resolving edge case in a pathological queue. Tests are meaningful (460 unit, 59 engine, 43 e2e all in enforce mode), evidence is present, all gate reports are filed.

Two NITs noted (duplicate header constant, onError+rate-limit wedge comment) — neither blocks merge.

The TM may merge after flipping the PR from draft to ready and confirming the local-Docker `verify-green-local.sh` GREEN.

---

## D-022 OPUS MERGE-COUNTING SECOND PASS (2026-07-09)

The sonnet first pass above resolved the structural/design-conformance layer. This pass applies the judgment lens the venue's Saturday night actually needs. **Verdict: APPROVE (merge-counting).** Verified locally: jest 460/460, rotation-engine 59/59, e2e-enforce 43 passed (advance-auth spec's 3× 401/success paths re-run live green), `next build` compiles clean. Findings below are follow-ups and NITs — none block.

### 1. The rollout flip — does it strand live TVs? (RULING + runbook caveat)

Walked in code. The token is `HMAC(secret, "boraoke-screen-v1|<roomId>|<bucket>")`. `advanceAuthMode()` (the `log`/`enforce` env read) is referenced ONLY in `app/api/queue/advance/route.ts` — it is NOT read by `mintScreenToken` or `verifyScreenToken`. Therefore **the token byte-format is identical in both modes**, and verification is fully stateless (no session store — `verifyScreenToken` recomputes the HMAC from `resolveRoomToken` + bucket). Consequences of the flip `log → enforce` + redeploy:

- **A TV opened BEFORE the flip holds a token that survives the flip and the redeploy**, so long as it is still in-bucket. The redeploy kills the lambda, but there is no per-lambda auth state — the new lambda recomputes the same secret+bucket and accepts the pre-flip token. **The flip does NOT strand a TV whose token is still within its bucket window.** Confirmed by the `advanceAuthMode` unit tests (mode is a pure env read, orthogonal to token math).
- **The one real hazard is bucket EXPIRY on a never-reloading kiosk TV.** A token is valid for its mint bucket + the previous bucket → up to 48h from page load (`verifyScreenToken` loops `[current, current-1]`; unit test "a token expires two buckets later" pins this). The `screenToken` is a static server-rendered prop passed once at page render; **nothing in the client re-mints it.** I verified the watchdog ladder does NOT save such a TV: the `reload` rung calls `player.loadVideoById()` (reloads the PLAYER), and the `recreate` rung calls `player.destroy()` + `setPlayerEpoch` bump (rebuilds the player IN-PAGE). **No watchdog rung reloads the PAGE**, so no rung re-mints the token. A kiosk TV that has been open >48h will, under `enforce`, get 401 on both its ENDED auto-advance and its watchdog skip → the current video finishes and the queue **wedges silently** (no user-visible error; advance just no-ops).

  **RULING: the flip protocol REQUIRES a "reload every TV" caveat in the TM runbook.** The flip itself is safe for freshly-loaded TVs, but the correct operational sequence is: (a) flip `ADVANCE_AUTH=enforce` + redeploy during a quiet window, THEN (b) **hard-reload every deployed venue TV page** (F5 / kiosk relaunch) so each re-mints a fresh in-bucket token off the new deploy. Any TV left un-reloaded is fine until its token ages past 48h, at which point it wedges. This is a low-frequency failure (needs a >48h-uptime kiosk that never reloaded) but it is silent, so the reload step belongs in the runbook, not tribal knowledge. Follow-up ticket worth filing: a client-side token-age self-heal (TV reloads its own page when its token is within N hours of the 48h edge, or on a 401 from advance) so kiosks self-recover without a human touching them — this closes the class rather than papering it with a runbook step.

### 2. The onError wedge — real-venue ruling

Scenario: one patron pastes an album of 12 region-blocked / embedding-disabled videos; each fires `onError` (fatal code) → `skipUnplayable` → `advance("unplayable")`. Twelve near-instant fatal errors in <60s hit the 12/min/room rate cap; the 13th advance gets 429 and the TV wedges on the 13th unplayable video until the sliding window drains (~60s), then self-resolves. `skippingRef` serializes to one skip in flight so this is paced by the round-trip, but 12 instant fatals can still exhaust the minute.

**RULING: ACCEPTED, as sonnet did — a 12-region-blocked-playlist IS plausible, and I do not treat the 60s self-resolving wedge as a merge blocker.** Rationale: (a) it is bounded and self-healing (the window drains, the 13th video plays or skips), (b) it requires a genuinely pathological queue (12 consecutive fatals) that a single bad patron can create but that also fixes itself within a minute, (c) the rate limit is doing exactly its job — capping drain velocity — and lowering the cap to accommodate instant-fatal bursts would weaken the anti-grief backstop it exists for. **Cheap mitigation worth a FOLLOW-UP ticket (not this PR):** exempt the `reason=unplayable` advance from the rate charge, OR give it a separate, higher unplayable-skip budget — a watchdog/onError skip is a system-legitimate advance, not attacker griefing, so charging it against the same 12/min anti-grief bucket is the root conflation. That cleanly removes the wedge without weakening the anti-scrape throttle. Filed as a suggestion, not a condition.

### 3. Scraped-token blast radius (adversarial, beyond the audit)

The screen token is public-by-design (rendered into the `/[room]/tv` HTML/props — the honest threat note owns this). I enumerated what a scraped CURRENT token grants for its ≤48h life:

- **ADVANCE ONLY.** Grep-verified: the `X-Boraoke-Screen` header / `verifyScreenToken` / `isAdvanceAuthorized` chain is consumed by **exactly one route** — `app/api/queue/advance/route.ts`. No other route reads the header or calls the verifier.
- **No reorder, no remove, no pause, no mode/language change.** Those live under `app/api/host/*` and gate on `requireHost`, which reads the **cookie** `hostCookieName(roomId)` and verifies against `sessionValue(token) = HMAC(secret, "cantai-host-session-v1")` — a DIFFERENT HMAC message and a DIFFERENT transport (cookie, not header) than the screen token's `HMAC(secret, "boraoke-screen-v1|room|bucket")`. **The scraped screen token cannot be replayed as a host session** (wrong derivation, wrong channel). Domain separation is real and correct.
- **No cross-room reuse.** The token binds `roomId` into the HMAC message; unit test "a token minted for room A does NOT verify for room B" pins this. A token scraped off room A's TV is useless against room B.
- **Residual grief is bounded by the rate limit:** a scraper holding a valid token can skip-grief the one room whose TV they scraped, at ≤12 advances/min/room. That is the deliberate prototype trade-off (accounts wave #14 hardens it), and the rate limiter is the sanctioned backstop.

**Blast radius = skip-grief a single physically-identifiable room at ≤12/min for ≤48h, nothing else.** No reorder, no remove, no cross-endpoint, no cross-room. This matches the documented threat model exactly — no undisclosed escalation path.

### 4. e2e helper reimplementation drift (coupling assessment)

`e2e/helpers.ts` hand-mirrors the server HMAC (`SCREEN_TOKEN_PREFIX`, `SCREEN_TOKEN_BUCKET_MS`, `HOSTCODE_HMAC_KEY`, `DEV_FALLBACK_TOKEN` as local literals) rather than importing `lib/screen-token.ts` — necessarily, because that lib carries `import "server-only"` and cannot load in Playwright's Node context. **Assessment: the coupling is self-alarming, not silent.** If `lib/screen-token.ts` changed its message format (e.g., prefix → `v2`) without updating the helper, the positive-path e2e (`advanceOnce` → `expect(200)` in advance-auth.spec.ts, plus every `drainQueue` in the migrated specs) would receive 401 and **fail loudly** — the helper's stale token no longer verifies server-side. So a lib-only format change surfaces immediately as red e2e. The only un-caught case is a *matching* drift (dev edits both identically), which is by definition still correct. NIT, non-blocking: this is a manual mirror with no compile-time link; a comment cross-referencing the two constant blocks (already partially present) is sufficient. A future consolidation could extract the pure-crypto constants to a non-`server-only` module importable by both, but that is polish, not a condition.

### 5. Test verification (self-run, this pass)

| Suite | Claimed | Re-run result |
|---|---|---|
| jest (unit) | 460 | **460/460 pass** (32 suites) |
| rotation-engine (`node --test`) | 59 | **59/59 pass** |
| e2e advance-auth (enforce) | 43 total | **advance-auth.spec 4/4 live green** (3× 401/success + helper sanity), config pins `ADVANCE_AUTH=enforce` |
| `next build` | PASS | **Compiled successfully, 23/23 static pages** |

### Opus-pass findings (all non-blocking)

- **F1 (follow-up, MEDIUM):** rollout flip needs a "hard-reload every venue TV after the flip+redeploy" step in the TM runbook, because a >48h-uptime kiosk that never reloads wedges silently under `enforce` (no watchdog rung reloads the page → no re-mint). Best permanent fix: client-side token-age self-heal (reload page near the 48h edge or on a 401). See §1.
- **F2 (follow-up, LOW):** exempt `reason=unplayable` advances from the anti-grief rate charge (or give them a separate budget) to remove the 12-instant-fatal → 60s wedge. System-legitimate skips shouldn't spend the anti-scrape budget. See §2.
- **N1 (NIT):** `"X-Boraoke-Screen"` is defined 3× (TvScreen hardcoded literal, `lib` lowercase const, `e2e/helpers` mixed-case const). Case-insensitive on the wire so it works; TvScreen is client-side and can't import the `server-only` lib const. Non-blocking.
- **N2 (NIT, carried from sonnet):** add a one-line comment at the `advanceRateLimitOk` call in the route noting the onError-burst wedge interaction (pairs with F2).

### Opus verdict

**[reviewer] APPROVE — merge-counting (D-022).** The authorization mechanism is correct and honest: stateless mode-independent tokens that survive the flip, exact domain separation from the host session (scraped token = advance-only, one room, ≤12/min, ≤48h), correct midnight/bucket handling with test coverage mapped to each threat, and a rate-limit backstop sized above legitimate cadence. All suites green on my own re-run. The two follow-ups (F1 flip-runbook/self-heal, F2 unplayable-skip rate exemption) are genuine but out of this PR's scope — file as tickets. **The TM must carry the §1 "reload every TV after the flip" caveat into the enforce-flip runbook** — that is the one operational condition attached to this APPROVE.
