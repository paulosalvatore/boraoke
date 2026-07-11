# TICKET-47 — Reviewer Report (D-022 opus merge-counting review + folded Cyber Security pass)

**PR:** #29 — `paulosalvatore/boraoke`, branch `ticket/47-unplayable-exempt`, base `main`.
**Reviewer verdict:** **APPROVE-WITH-FOLLOWUPS**
**Scope of this pass:** correctness + security (the change touches the anti-grief throttle; the Cyber Security pass is folded into this review per the TM instruction).

## What I checked (evidence)

- Full PR diff read LOCALLY from the worktree against `origin/main...origin/ticket/47-unplayable-exempt` (base `f4a37de`) — zero GitHub API diff reads.
- `lib/advance-rate-limit.ts` (two-bucket split), `app/api/queue/advance/route.ts` (skipReason wiring), `__tests__/advance-rate-limit.test.ts` (5 new tests).
- `lib/screen-token.ts` in full — the scrapeable-token threat model this change interacts with.
- Ran the tests and build MYSELF (not relying on dev-report prose):
  - Targeted `advance-rate-limit.test.ts` — **9/9 PASS** (4 original + 5 new).
  - Full jest suite — **465 passed, 32 suites** (matches dev report).
  - `npm run build` — exit 0, route table compiled (matches dev report).
- PR thread + description read via `gh`.

## Correctness — PASS

1. **Bucket independence.** Keys are `room:${roomId}` (singer-skip) vs `unplayable:${roomId}` (watchdog). Distinct prefixes, distinct entries in the one shared `hits` map — no cross-charge. The `max` and `key` are both selected from `opts.unplayable` in lockstep, so a bucket is always read/written with its own ceiling. Independence is proven bidirectionally by the unit test (`the two buckets are independent — exhausting one leaves the other free`).
2. **Singer-skip byte-equivalence.** The non-unplayable path resolves to `max = ADVANCE_ROOM_MAX (12)`, `key = room:${roomId}` — identical to pre-TICKET-47. `ADVANCE_RATE_ROOM_MAX === 12` is asserted in a test; the exactly-12-then-429 behavior is covered at both unit and route level. Confirmed unchanged.
3. **Back-compat overload.** `advanceRateLimitOk(roomId, optsOrNow = {}, now = Date.now())`. The 2nd arg is resolved by `typeof optsOrNow === "number"`: a number → treated as `now` with empty opts (legacy path, singer-skip bucket); an object → opts, with `now` taken from the 3rd arg. Correct. The legacy 2-arg call `advanceRateLimitOk(roomId, now)` is exercised by a dedicated test proving it charges the singer-skip bucket. Existing 4 tests untouched and green.
4. **Route auth ordering.** 400 invalid-room (`isValidRoomId`) → advance-auth 401/log → THEN skipReason resolution → THEN rate charge. `skipReason` resolution was moved above the rate-limit call; it only reads `searchParams.get("reason")` with no side effects and no store access, so hoisting it does not perturb the 400→401 ordering. Confirmed unchanged.
5. **429 shape / telemetry.** The non-unplayable 429 body is `{ error: "Too many advances", reason: "rate" }` — unchanged. `song_skipped` / `song_played` tracking and their props are byte-identical (the diff does not touch lines 68–78). Confirmed.
6. **LRU guard + reset.** `evictOverflow()` and `_resetAdvanceRateLimit()` both operate on the single shared `hits` map, so they cover both prefixed key families automatically — no new machinery, no leak. `ADVANCE_BUCKETS_MAX = 2000` bound is shared across both bucket families (see DoS note below).

## Security — the load-bearing question

**Grief-capacity delta.** `reason` is caller-supplied and forgeable, and per `screen-token.ts` the screen token is scrapeable from the public `/[room]/tv` page (documented, TL-accepted prototype trade-off). Before this change a scraped-token attacker could force **12 advances/min/room**. After it, because the two buckets are INDEPENDENT, a forger who alternates `reason=unplayable` and non-unplayable can force **12 + 40 = 52 advances/min/room**. A forged `reason=unplayable` still calls `store.advance()` — it skips whatever is currently playing exactly like a singer-skip — so the *effective* per-room grief ceiling rises from **12/min to 52/min**. This is the honest number and I want it on record.

**Is 40 (→ effective 52) defensible?** Yes, as-is, for the prototype threat model — with a follow-up noted:

- The screen-token threat model is explicitly "raise the bar from casual/patron-prank to fetch-and-parse THIS room's TV page"; it never claimed to stop a targeted scraper (the accounts wave #14 is the real hardening). 52/min is still bounded, still per-room, and still requires scraping the specific room. The class this throttle actually defends (casual/prank skips) is unchanged in difficulty.
- The alternative — a **full** exemption — is strictly worse (unbounded forged skips), so the bounded second bucket is the correct shape given the ticket's constraint (unwedge without a full exemption).
- The wedge it fixes is real and user-facing (TV stuck up to 60s on an unplayable video). A real bad-instafail run rarely exceeds ~20 in a row, so 40 has ~2x headroom without being a blank cheque.

**Forged `reason` values.** Only `"unplayable"` is in `ADVANCE_SKIP_REASONS` (a `Set`). Any other/junk value → `skipReason = null` → `{ unplayable: false }` → singer-skip bucket (the *stricter* 12-bucket). So a forger cannot invent a third, laxer bucket, and cannot route to the generous bucket with anything but the exact string `"unplayable"`. Confirmed — the allowlist holds. No forged `reason` reaches a Redis key or telemetry prop unsanitized: the `reason` prop on `song_skipped` is only ever the allowlisted `skipReason`, never `rawReason`; the rate-limit key is `unplayable:` (a fixed literal) or `room:` prefixing the already-`isValidRoomId`-validated `roomId`, never the reason string.

**DoS / heap growth via the new bucket map.** The unplayable keys share the same `hits` map and the same `ADVANCE_BUCKETS_MAX = 2000` LRU bound as singer-skip keys. Because both families share ONE cap, the theoretical worst case is that an attacker minting many distinct room slugs churns up to 2000 entries total across both prefixes — same bound as before, no new unbounded surface. Minor note (not a blocker): a single room now occupies up to 2 map slots (`room:` + `unplayable:`) instead of 1, so the effective distinct-room capacity under the 2000 cap roughly halves in the pathological all-both-buckets case. This does not change the O(1)-bounded memory guarantee; it is a constant-factor observation, filed as a follow-up for visibility only.

**Verdict on the tradeoff:** ACCEPTABLE-WITH-A-NOTED-FOLLOW-UP. Not a blocker.

## Tests — PASS

The 5 new tests map cleanly to the ACs:
- unplayable ceiling at 40 (13 OK past old cap, fills to 40, 41st trips) ✓
- singer-skip exactly-12-then-429 (unit + route) ✓
- bidirectional bucket independence ✓
- legacy 2-arg back-compat charges singer-skip bucket ✓
- route-level `?reason=unplayable` charged to the unplayable bucket (13 unplayable all 200, then a full 12 singer-skips before the 13th 429s) ✓

**Minor test gap (NIT, non-blocking):** the route-level test proves an *exact* forged `reason=unplayable` hits the generous bucket, but there is no route-level test that a forged *junk* `reason` (e.g. `?reason=griefbot`) falls back to the strict 12-bucket. The allowlist logic is simple and correct by read, and is indirectly covered, but an explicit negative test would lock the security-relevant fallback against future regressions. Follow-up FU-2 below.

## Dev-report currency — PASS

Read from the PR branch. Status line, commit SHAs (`fd2e2c8`, report-update `7185c5d`), and the verbatim self-verification (465/465, build exit 0, 9/9 targeted) all match what I re-ran independently. No stale prose.

## Gate preconditions note

The PR gate checklist shows App Tester / Cyber Security unchecked. This is expected and NOT a blocker for this PR: (a) the change is backend-only — no component/route-shape/UI change — so there is no UI surface for an App Tester visual gate; it is fully covered by unit + route tests. (b) The Cyber Security pass is explicitly folded into THIS review per the TM instruction, and is delivered in the "Security" section above. CI-green substrate for this product repo is `next build` + full jest (no framework `verify-green-local.sh` in a product repo) — both re-run GREEN by me.

## Follow-ups (APPROVE-WITH-FOLLOWUPS — none blocking)

- **FU-1 (security, LOW):** File a follow-up to explore a **server-side playability signal** so the watchdog-drain path can be authorized by server knowledge rather than a forgeable client `reason` — this would let the generous bucket be trusted and close the 12→52/min forged-grief gap. Tracks with the ticket's own "server-verified playability" note and the accounts-wave (#14) hardening. Not needed for merge.
- **FU-2 (test, NIT):** Add a route-level negative test asserting a junk `?reason=<not-unplayable>` falls back to the strict 12-bucket (locks the allowlist fallback against regression).
- **FU-3 (housekeeping, NIT):** Note in the limiter that one room can now occupy 2 of the 2000 LRU slots; if room churn ever pressures the cap, revisit `ADVANCE_BUCKETS_MAX`. Observation only.

## Final verdict

**APPROVE-WITH-FOLLOWUPS.** Correctness is clean and byte-equivalent on the protected path; the two buckets are genuinely independent; the allowlist holds; tests prove the ACs; build + full suite green (re-run by me). The security tradeoff (effective grief ceiling 12→52/min/room for a scraped-token forger) is bounded, consistent with the already-accepted prototype threat model, strictly better than a full exemption, and fixes a real user-facing wedge — acceptable as-is with FU-1 filed. Do NOT auto-merge (prod deploy on merge — deliver to TL).
