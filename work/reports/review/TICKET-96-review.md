# TICKET-96 — opus reviewer report (D-022)

**Verdict: APPROVE-WITH-FOLLOWUPS**

> **Provenance note, recorded honestly.** The reviewer wrote its full report into the ticket
> worktree and, per its brief, left it uncommitted. The Tech Manager then removed that worktree
> with `--force` after the merge and destroyed the file — a mistake, and exactly what the
> `worktree-cleanup` skill's uncommitted-work check exists to prevent. What follows is
> **reconstructed from the reviewer's returned summary**, which is complete on findings and
> verdict but shorter than the original prose. No finding has been dropped or softened. The
> file:line citations below are the reviewer's own and were spot-checked by the TM.

## 1. The deliberate behaviour change — trade is sound, no re-scope needed

Both paths that can produce an unplayable advance were traced:

- **The stall ladder is not a contributor.** 4 rungs x `STALL_WINDOW_MS = 12_000`
  (`components/tv/watchdog.ts:43`, `:52-57`) = at least 48s per video, so it can produce at most
  ~1 advance per 60s window.
- **Fatal `onError` is the only fast path** (`components/tv/TvScreen.tsx:581-582`), serialized by
  `skippingRef` (`:419-420`), two round-trips per cycle (`:387`, `:403`). Pacing does not stop it,
  so reaching 40 reduces to: are there 40 consecutive fatal-error videos in one room within 60s?

Reachable in theory, but roughly double the documented worst case — TICKET-47 chose 40 as headroom
precisely because "a real bad-run of instantly-unplayable videos rarely exceeds ~20 in a row"
(`work/tickets/TICKET-47-unplayable-rate-exempt.md:23`). The consequence is bounded and
self-healing (<=60s, host retries, nothing lost), on top of an already-pathological state in which
40 queued songs have been destroyed.

**The decisive point:** the symptom is already live on a much more ordinary path. The Skip button
(`components/tv/TvScreen.tsx:1017`) and the ENDED auto-advance (`:566-568`) both charge the
unchanged 12/60s singer-skip bucket, so a host clearing a run of no-shows already hits a silent 429
today. TICKET-96's new starvation path is strictly *less* reachable than one that already ships.

**Reverse direction verified clean:** singer-skips can consume at most 12 of the 40 total, so the
unplayable path always retains >=28 headroom — TICKET-47's acceptance criterion (">=13 consecutive
unplayable advances no longer 429") still holds unconditionally.

## 2. Charge/deny logic — no findings

Denial pushes to neither array and persists both pruned windows (`lib/advance-rate-limit.ts:125-134`);
the check on both buckets strictly precedes both pushes, so a partial charge is impossible. The
prefixes `room:` / `unplayable:` / `total:` differ at character 0, so no attacker-mintable roomId can
collide. LRU is sound: every call touches all of a room's live keys, so an active room can never be
evicted ahead of an idle one. Back-compat 2-arg signature verified at `:108-111`. The
3-slots-per-room capacity cost (~666 concurrent rooms at 2000 slots) is the accepted, disclosed cost.

## 3. The new test is discriminating, not tautological

Hand-simulated: with the change the alternation yields exactly 40 (singer-skip saturates at i=23,
unplayable carries the total to 40 at i=54); without it, 52 — the number the TM observed at base.
Both plausible half-implementations (total charged on only one path) were checked: each yields 52
and fails the test. Fixed `NOW`, 100ms span, `beforeEach` reset — no wall-clock fragility.

## 4. Plan-divergence note

The spike claimed option (c) "Breaks: nothing legitimate". That claim is now known to be slightly
wrong, and the dev report says so plainly rather than quietly editing the test. The spike's hard
constraint — the two existing ceiling tests at base lines 58-80 must stay green unchanged — **is
satisfied**: the modified test begins at base line 81, outside the protected range. (TM
independently confirmed via `git diff`: only one `it(` was renamed and one added; neither ceiling
test was touched.)

## Follow-ups (none merge-blocking)

- **FU-1 (MEDIUM, pre-existing, out of scope — filed as TICKET-97):**
  `components/tv/TvScreen.tsx:387-405` handles only 401. A 429 is swallowed and the code returns the
  *unchanged* queue head, so the Skip button becomes a silent no-op, ENDED **replays** the finished
  song, and `skipUnplayable` reloads the same broken video -> `onError` -> retry: a tight loop
  hammering the advance route until the window clears. Already reachable today via the 12-cap;
  TICKET-96 does not materially widen it.
- **FU-2 (LOW):** `work/status/BOARD.md` (TICKET-47 FU-3 entry) still says "up to 2 LRU slots" — it
  is 3 now.
- **FU-3 (NIT):** `ADVANCE_RATE_TOTAL_ROOM_MAX` is exported but referenced nowhere; both siblings
  are used in tests.
- **FU-4 (NIT):** `__tests__/advance-rate-limit.test.ts:2` docstring still says "dual-bucket".

## Labelled UNVERIFIED by the reviewer

The Playwright failure's attribution to the TICKET-94 flake — not reproduced by the reviewer
(consistent with the diff, which touches no feedback surface). Gate figures were taken from the TM's
runs, not re-run.
