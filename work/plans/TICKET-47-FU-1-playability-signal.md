# TICKET-47 FU-1 — server-side playability signal: design spike

**Status:** design spike, read-only. No product code changed.
**Filed:** PR #29 reviewer, deferred LOW since 2026-07-11 (`work/status/BOARD.md:190`).
**Question:** can the generous unplayable rate bucket be made to apply only to
genuinely-unplayable heads, closing the residual forged-grief gap?

**TM verification note (2026-09-01):** every load-bearing claim in §1 was independently
re-checked against the code by the Tech Manager before this spike was accepted — the two bucket
maxes and their separate key prefixes, `advanceAuthMode()`'s undefined-means-log branch, the
route's log-mode fallthrough, the module-level `Map`, and the absence of any IP helper in the
advance route. All confirmed. The two items marked UNVERIFIED below remain unverified.

---

## 1. Is the premise still true?

**The arithmetic: CONFIRMED. The framing: REFUTED. The real exposure: larger.**

### 1.1 The 52 number is correct

`lib/advance-rate-limit.ts:38-41` sets `ADVANCE_ROOM_MAX = 12`,
`ADVANCE_UNPLAYABLE_ROOM_MAX = 40`, `ADVANCE_WINDOW_MS = 60_000`.
`lib/advance-rate-limit.ts:81-84` selects both the max and the map key from
`opts.unplayable` (`unplayable:<room>` vs `room:<room>`), so the two windows
share no state. A caller alternating `?reason=unplayable` with a reasonless
advance therefore draws 40 + 12 = **52 successful advances per room per 60s**
against an intended anti-grief budget of 12. Both ceilings are pinned by
existing tests (`__tests__/advance-rate-limit.test.ts:58-80`).

### 1.2 REFUTED — no scraped token is needed today

FU-1 says "a scraped-token forger". That precondition does not currently exist.

- `advanceAuthMode()` returns `"enforce"` only for the exact string `enforce`;
  every other value **including `undefined`** returns `"log"`
  (`lib/screen-token.ts:129-133`).
- In `log` mode the route emits `[advance-auth] would-block …` and **falls
  through to the normal path** (`app/api/queue/advance/route.ts:41-50`).
- `ADVANCE_AUTH` is **absent from Vercel Production**, so the effective mode is
  log-only (recorded at `work/status/MANAGER-LOG.md:367`).
  **UNVERIFIED in this spike** — Vercel was not re-probed; this rests on the
  prior probe record.

So the attacker input required today is the **public room slug** and nothing
else. `isValidRoomId` (`lib/rooms.ts:115-117`) is the only gate the request must
pass. The screen token, the HMAC, the bucket rollover tolerance and the host
session (`lib/screen-token.ts:153-173`) are all currently **advisory**.

### 1.3 REFUTED — the ceiling is per-process, not per-room

`lib/advance-rate-limit.ts:43` holds state in a module-level `Map`. There is no
Redis path here, in deliberate contrast with `lib/rate-limit-counter.ts`, whose
header exists precisely because "on Vercel each lambda keeps its own map, so the
throttle is NOT a hard cross-instance cap". TICKET-47's own scope note defers
this ("Moving rate buckets onto Upstash / cross-instance (separate filed
follow-up)", `work/tickets/TICKET-47-unplayable-rate-exempt.md:43`).

**Effective ceiling = 52 x N**, where N is the number of concurrent serverless
instances an attacker can spread requests across. **N is UNVERIFIED** — it is not
derivable from this repo and would need a measurement against a deployment.

### 1.4 TICKET-78/86 are not on this path

The client-IP hardening (`clientIpFrom`, `lib/host-auth.ts:244-259`) is consumed
by `/api/host/login`, `/api/queue` and `/api/t`. **The advance route imports no
IP helper at all** (`app/api/queue/advance/route.ts:1-6`) and buckets purely per
room. Those tickets neither help nor hurt here.

### 1.5 Harm calibration FU-1 omits

One advance destroys exactly one queued song. `QUEUE_MAX = 200`
(`lib/store/types.ts:34`). At the intended 12/min a full queue is drained in
~17 minutes; at 52/min in ~4 minutes. The gap is **how fast the venue's night
dies, not whether it dies**. This supports the LOW priority — but relocates the
real severity: the open item that matters is the `ADVANCE_AUTH` enforce flip,
not the bucket split.

---

## 2. What is actually forgeable

**Attacker requirements today:** the room slug. That is the complete list.

**With `ADVANCE_AUTH=enforce` (not the current prod state):** additionally a
valid `X-Boraoke-Screen` token, scraped from the public `/[room]/tv` page — the
honest threat note at `lib/screen-token.ts:24-30` documents this as an accepted
prototype trade-off. Tokens are valid for a 24h bucket plus the previous one
(`lib/screen-token.ts:56,109-117`), so one scrape lasts up to 48h.

**What `ADVANCE_AUTH=enforce` would stop:** the anonymous curl. It raises the bar
to "fetch and parse this room's TV page once every <=24h".

**What it would not stop:** the forged `reason`. The token authenticates the
*caller*, never the *claim*. `reason` is read straight from the query string and
allowlisted only for shape (`app/api/queue/advance/route.ts:56-58`), then used to
pick the bucket (`:61`). A token-holder still alternates freely.

**Rooms with no key fail open regardless of mode** (`lib/screen-token.ts:158-162`
-> `resolveRoomToken`, `lib/host-auth.ts:118-133`). Every real created room has a
`hostCodeHash`, so this affects the legacy `default` room without `HOST_TOKEN`
rather than normal venues.

---

## 3. Options

### (a) Verify playability server-side at advance time via `videos.list`

**Cost.** 1 quota unit per checked advance against the ~10,000/day combined pool.
That pool is **not accounted anywhere**: `reserveSearchCall` guards only
`search.list` and has exactly one call site (`lib/search-budget.ts:98,114`;
`app/api/search/route.ts:178`), while `youtube-search.ts:268-270` (contentDetails
per search page) and TICKET-61's `checkEmbeddable` already spend unbudgeted
`videos.list` units. Adding a per-advance spender to an unmetered pool is the
same shape of hole TICKET-87 was written to close for `search.list`.
Latency cost: the existing helper budgets 1500 ms (`lib/youtube.ts:84`) on a path
whose entire purpose is fast recovery.

**What breaks it — decisive.** `checkEmbeddable` collapses *every* failure (no
key, HTTP error, quota exhaustion, timeout, malformed JSON) to `"unknown"` and
never throws, by explicit design (`lib/youtube.ts:120-153`, rules at `:66-77`).
A verification that fails open is not a verification: the forger induces or waits
for the fail-open branch. Making it fail *closed* instead means a Google blip
wedges every venue TV — strictly worse than the bug TICKET-47 fixed.

**It also measures the wrong thing.** The watchdog fires on fatal codes 2/5/100/
101/150 (`components/tv/watchdog.ts:32`) — bad parameter, deleted, private,
embed-disallowed, region-blocked. `status.embeddable` covers only one of those.
Region blocking needs `contentDetails.regionRestriction` and knowledge of the
venue's region, which the server does not have.

**And it is defeatable.** The attacker also controls submissions. Queue a
genuinely non-embeddable video, then "unplayable"-skip it honestly.

**Verdict: reject.**

### (a') Verify at SUBMIT time and persist the verdict — the salvageable variant

TICKET-61 already calls `checkEmbeddable` on the paste path and **throws the
result away** into an advisory warning string
(`app/api/queue/route.ts:233-246`). Persisting it as a field on `QueueEntry`
(`lib/store/types.ts:15-31`) would let the route grant the generous bucket only
when the *current head's* stored verdict is `not-embeddable`.

- **Buys:** a genuinely server-side, advance-caller-unforgeable signal, at **zero
  new quota** and **zero added advance latency**.
- **Costs:** an additive field on a contract whose header calls itself FROZEN
  (`lib/store/types.ts:4`) — additive changes have precedent (`graceRequeue`,
  `:24-30`), so this is a review question, not a blocker. Needs a store migration
  story for entries queued before the change (absent => strict).
- **Breaks:** coverage. Paste-only; `unknown` must map to strict; and search-
  sourced entries are already pre-filtered `videoEmbeddable`/`videoSyndicated`
  (`lib/youtube-search.ts:237,243`) so they would all land strict. Most real
  instafail runs are *deleted-after-submit* and *region-blocked* heads, which no
  submit-time verdict can see. **This partially re-opens the exact 60s TV wedge
  TICKET-47 exists to fix.**

**Verdict: defensible later refinement, not the primary fix.**

### (b) Infer from elapsed play time before the advance

**Not implementable without new state.** `QueueEntry` has no start timestamp
(`lib/store/types.ts:15-31`) and the key schema is queue + paused only (`:115-118`).
Telemetry is fire-and-forget and fail-open by contract (`lib/telemetry.ts:1-16`)
and is therefore not admissible as an authorization input. So (b) requires a new
durable per-room "head started at" write on every advance.

**And the inference is backwards.** A genuine instafail run is characterised by
*tiny* inter-advance gaps — which is also exactly what a griefer produces.
Elapsed time separates fast from slow, not honest from forged. The only rule that
would bind an attacker (charge STRICT when advances are fast) charges the
legitimate watchdog drain to the strict bucket and reinstates the wedge.

**Verdict: reject. It cannot work as an authorization signal.**

### (c) Tighten the buckets so alternation cannot beat the intended total

Add a **third per-room bucket charged by every advance, whatever the claimed
reason** — e.g. `total:<room>` at 40/60s — while the existing strict 12/60s
bucket continues to be charged only by non-unplayable advances.

Worst case becomes **40/min instead of 52**, independent of the caller's claimed
reason. A pure singer-skip forger is still capped at 12/min. The alternation
bonus disappears entirely.

- **Cost:** ~10 lines in `lib/advance-rate-limit.ts` plus one argument at
  `app/api/queue/advance/route.ts:61`. No new dependency, no quota, no latency,
  no new persisted state, fully unit-testable offline.
- **Breaks:** nothing legitimate. Skips are serialized one-in-flight
  (`components/tv/TvScreen.tsx:419-420`); the stall path needs 4 x 12s before it
  advances at all (`components/tv/watchdog.ts:43,52-57`); only the instant-
  `onError` run is fast, and TICKET-47 sized 40 for exactly that
  (`work/tickets/TICKET-47-unplayable-rate-exempt.md`, "rarely exceeds ~20").
- **Side effect:** one room now occupies up to 3 LRU slots instead of 2 against
  `ADVANCE_BUCKETS_MAX = 2000` (`lib/advance-rate-limit.ts:41`) — this is
  already-filed FU-3 territory (`work/status/BOARD.md:192`); at 2000 slots and
  3 per room it still covers ~666 concurrent rooms.
- **What it does not buy:** it never distinguishes an honest skip from a forged
  one. It makes that distinction *stop mattering for the ceiling*, which is the
  actual goal FU-1 states.

**Verdict: recommended.**

### (d) Do nothing, document the accepted risk

- **Cost:** zero. **Buys:** an honest record.
- Defensible on the harm calibration in §1.5 — 12/min already ends a venue night.
- **But the current record is wrong**, and leaving it uncorrected is not "doing
  nothing", it is preserving a false belief: `work/status/BOARD.md:190` implies a
  token is required, and nothing on the board states that the advance limiter is
  per-process. If (d) is chosen, §1.2 and §1.3 must be written onto the board.

---

## 4. Recommendation

**Take (c), and correct the record.** It removes the alternation bonus outright
for roughly ten lines, no quota, no latency and no new state — and it does so
without a playability signal, because the ceiling stops depending on the claimed
reason. Reject (a) (fail-open verification is not verification, on an unmetered
quota pool) and (b) (the inference runs the wrong way and needs state that does
not exist). Keep (a') filed as an optional later refinement if honest-vs-forged
attribution is ever wanted for its own sake.

**Sequencing note — this is not the top item.** The `ADVANCE_AUTH` enforce flip
buys strictly more than anything in FU-1: it converts an anonymous attack into
one that requires a per-room scrape every <=24h. FU-1 should stay LOW **behind**
that flip, not ahead of it.

## 5. Smallest slice that proves or disproves it

1. **One unit test**, added to `__tests__/advance-rate-limit.test.ts`: alternate
   `{unplayable:true}` / `{unplayable:false}` within one 60s window and assert the
   observed successful total. **It should read 52 today.** If it does not, the
   premise is refuted and the ticket closes on the spot.
2. Add the third total bucket; the same test now asserts **40**, and the two
   existing ceiling tests (`:58-80`) must stay green unchanged.

Total: one test plus ~10 lines, no deployment and no external dependency.

**Cheaper prior probe (not run here — UNVERIFIED):** `curl -X POST` a preview
deployment's `/api/queue/advance?room=<slug>` with **no** `X-Boraoke-Screen`
header and confirm HTTP 200. That is the one-command proof of the §1.2 log-mode
precondition, and it is the fact most worth confirming before any code moves.
