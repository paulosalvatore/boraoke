# Spec — Venue rotation modes + fair-queue rules

- **Product:** cantai
- **Author:** Product Owner (TICKET-5)
- **Date:** 2026-07-05
- **Status:** proposed spec — buildable; intended consumers: TICKET-3 (engine lib, in flight) and backlog #10 (UI wiring)
- **Priority rationale:** fairness is cantai's differentiating brain — a plain FIFO queue is a commodity; "the shy table still gets a turn" is the product.

## User story

As a **venue host**, I pick a rotation mode that matches my night (open mic chaos, table-based fairness, or strict one-song-each), and the queue orders itself so patrons trust that their turn will come — without me refereeing.

As a **patron**, I submit a song to **sing** or just to **listen/dance**, I can see where I am in line and why, and I never feel the queue is being gamed.

## Definitions

- **Entry:** `{ id, videoId, title, uuid, nickname, tableNumber?, kind: "sing" | "listen", submittedAt, status, graceRequeue?: boolean }`.
- **`graceRequeue`:** set `true` by the store on the one grace re-queue granted after a skipped-absent turn (see no-shows); it is priority metadata the pure `order()` function consumes (below). The store clears it (sets `false`) when the entry transitions to `playing`, so the grace is single-use by construction.
- **Identity:** the anonymous `uuid` (device-local, no signup). `nickname` is display-only and never an identity key (duplicates allowed).
- **Table:** free-text short code captured at join/submission (optional in full-karaoke mode; required for 2-per-table mode to bind an entry to a table group).
- **Entry status lifecycle:** `queued → playing → done`, with exits `skipped` (host action / no-show) and `removed` (host or owner deletes).
- **Round:** one pass of the rotation over all currently-eligible groups (persons or tables). Rounds are how fairness is expressed: nobody sings twice in a round while someone eligible hasn't sung once.

## The three venue modes

Mode is a **venue-level setting**, changeable live by the host. All modes govern **sing entries only**; listen/dance entries follow their own rules (below).

### 1. Full karaoke (default)

- Everyone queues freely; ordering is **round-robin by uuid**, tie-broken by earliest unplayed submission.
- Concretely: build rounds; in each round every uuid with pending sing entries contributes their oldest entry; rounds are ordered internally by each entry's `submittedAt`.
- Why not plain FIFO: one enthusiastic patron dumping 8 songs would freeze everyone else out; round-robin keeps FIFO feel for casual use while capping hog behavior structurally.
- No cap on how many entries a uuid may hold queued (they just spread across future rounds).

### 2. 2-per-table

- Fairness group = **table**. Round-robin across tables; each table contributes up to **2 entries per round** (its two oldest pending, regardless of which uuids at the table submitted them).
- A sing entry without a table number can't be scheduled in this mode: the submit UI requires table when this mode is active; pre-existing tableless entries surface to the host as "needs a table" and are excluded from rotation until assigned (host or owner can set it).
- Cap on queued-not-played sing entries per table: **4** (2 rounds of lookahead) — prevents one table pre-loading the whole night. Submit beyond the cap is rejected with a friendly "your table already has 4 songs coming up".

### 3. One-per-person

- Fairness group = **uuid**. Round-robin across uuids; each uuid contributes **1 entry per round**.
- Table number is **optional and ignored for fairness** in this mode (as in full karaoke): it may still be captured and displayed (the TV "get to the mic" call shows it), but it never affects grouping or caps.
- Cap on queued-not-played sing entries per uuid: **2** (current round + next) — you can line up your next song while you wait, no more.
- This is the strictest mode; expected for busy nights.

### Ordering algorithm (all modes, one description)

Pure function `order(entries, mode, nowPlaying) → orderedList` (this is the TICKET-3 lib contract). `nowPlaying` is the entry currently in `playing` status, or `null`: `order()` excludes it from the returned list (it's on stage, not in line) and counts it as one consumed quota slot for its group in the current round, so an in-flight turn is never double-scheduled and its group can't be scheduled again ahead of others mid-song.

1. Partition pending (`queued`) sing entries into fairness groups per mode (full karaoke: by uuid / 2-per-table: by table / one-per-person: by uuid).
2. Compute each group's **credit** = number of entries already played/skipped for that group in the current session (skips count as a consumed turn only when the singer was absent — see no-shows), plus the in-round quota consumption from `nowPlaying` per above.
3. Build rounds: sort groups by (credit ascending, oldest-pending-entry `submittedAt` ascending); take each group's allowed quota per round (1, 2, or 1 by mode); repeat until all entries placed. **Grace priority:** when selecting a group's quota entries for a round, entries with `graceRequeue: true` are picked before the group's other pending entries (overriding `submittedAt`); and among equal-credit groups in a round, a group holding a `graceRequeue` entry sorts first. Net effect: the grace entry lands at the front of its group's next-round slot, exactly as the no-show rule promises (AC6).
4. The function is deterministic and side-effect-free: same inputs → same order. All state (entries, statuses, mode, the `graceRequeue` flag) lives in the store; the engine never mutates — granting and clearing `graceRequeue` are store transitions, not engine behavior.

Mode switches mid-night simply re-run `order` with the new mode over the same pending entries — no migration, no lost entries. UI shows a subtle "queue reordered — mode changed to X" toast.

## Sing vs listen/dance entries

- **Listen/dance entries never consume a fairness turn** and never count against per-table/per-person caps. They are ambiance requests, not mic turns.
- Scheduling: listen entries form a secondary FIFO. The player takes the next **sing** entry when one exists; when the sing queue is empty, it drains listen entries in FIFO order. Rationale: karaoke is the show; music fills the gaps. (A venue-level toggle "interleave: play 1 listen entry between singers" is a nice-to-have, out of scope v1.)
- Cap: max **3 pending listen entries per uuid** (anti-spam; generous because they're low-stakes).
- UI must make the kind choice explicit and reversible at submit time ("I'll sing this" vs "just play it"), and badge the two kinds distinctly in the queue view.

## Edge cases (acceptance-critical)

### No-shows

- When a sing entry becomes `playing`, the TV shows a **30-second "get to the mic" call** (nickname + table, big). Host has skip control at all times.
- If the host skips during the call window (singer absent): entry → `skipped`, and the singer gets **one grace re-queue** — their next submission (or a one-tap "I'm back, re-queue it" on their phone) is stored with `graceRequeue: true`, which the ordering algorithm (step 3 above) places at the **front of their group's next-round slot**, not the back of the night. Credit is NOT charged for the skipped turn (they didn't sing).
- Second consecutive no-show by the same uuid: no grace; entry gone, normal re-submit only, and credit IS charged (prevents "queue and vanish" gaming the top of rounds).

### Leavers

- No accounts, so "left the bar" is inferred, never known. Patron pages send a lightweight heartbeat (piggybacked on queue polling); a uuid with no heartbeat for **10 minutes** is flagged `maybe-gone` in the host view (dimmed entries), but entries are **not auto-removed** — phones die, patrons smoke outside.
- Host can one-tap "remove all from this person/table". Auto-cleanup only at session end.
- A patron's own view has "leave / clear my songs" for graceful exits.

### Table changes

- An entry snapshots its `tableNumber` at submission. If a patron changes their table (join screen setting), **future** submissions use the new table; existing queued entries keep the old table unless the patron explicitly moves them ("move my songs to table 7").
- Moving entries to a new table re-validates that table's cap (excess entries stay owned but unscheduled with "table is full" state until the cap frees). Prevents cap-dodging by table-hopping.
- In 2-per-table mode a "table" of one person is legal (solo patron = their own group).

### Other

- **Duplicate songs:** allowed (two people may want the same song), but the submit UI warns "this song is already in the queue".
- **Empty queue:** TV shows the join QR + "queue a song" call-to-action, not a black screen.
- **Host disconnects:** the queue and rotation are server-side state; the TV page is a dumb renderer and any device with the host token can resume control.
- **Clock/ordering abuse:** ordering uses server-received time, never client timestamps.

## Acceptance criteria

1. Given mode = full karaoke and uuid A submits 3 songs then uuid B submits 1, the play order is A1, B1, A2, A3 (round-robin, not FIFO).
2. Given mode = 2-per-table with tables T1 (3 entries) and T2 (2 entries), each round takes at most 2 entries per table, tables taking turns round-by-round in credit-ascending order; T1's third entry lands in round 2.
3. Given mode = one-per-person, a uuid with 2 pending sing entries gets a rejection (with friendly copy) on a 3rd sing submission; a listen submission still succeeds.
4. Listen/dance entries play only when no sing entries are pending, in FIFO order, and never alter any group's credit.
5. Switching modes mid-session reorders pending entries per the new mode without losing or duplicating any entry.
6. A skipped-absent singer's grace re-queue (`graceRequeue: true`) schedules ahead of their group's normal next-round position exactly once — the flag clears when the entry starts playing; a second consecutive no-show gets no grace and is charged credit.
7. The ordering function in the rotation lib is pure: property/unit tests can assert all of the above without a server (aligns with TICKET-3's lib-first build).
8. Changing table never lets a group exceed its cap (test the hop-to-dodge-cap path explicitly).

## Out of scope (v1)

- Priority/boost tools (pro-feature candidate — see monetization spec), duets/group entries, per-song time limits, cross-session credit memory (each night starts fair).
