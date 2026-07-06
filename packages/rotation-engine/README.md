# @cantai/rotation-engine

The fairness heart of cantai. A **pure, immutable, dependency-free** TypeScript
library that decides *who sings next* in a bar's shared karaoke queue.

Every function takes the current queue state and returns a **new** state — it
never mutates its input and never touches the network, storage, or clock. That
makes it trivial to test, to reason about, and to drive from any app (cantai's
Next.js app consumes it in a later integration ticket).

## The fairness rules, in plain language

### Who's in the queue

Anyone can add an **entry**: a song (`videoId`) submitted by a participant
(anonymous `uuid` + `nickname`), optionally with a `table` number, in one of two
modes:

- **sing** — you want a turn at the mic.
- **listen** (a.k.a. dance) — you just want this song played; you are *not*
  asking for a mic turn.

The order songs actually play in is always computed fresh from the current
queue (`getEffectiveOrder`). Nothing is "locked into" a position, so the venue
can change the rules mid-session without anyone losing their spot.

### Venue modes

The venue picks one of three rotation policies:

| Mode | Rule | Fairness |
| --- | --- | --- |
| **full-karaoke** | Everybody queues freely (uncapped) | **Round-robin by person** (anti-hog) |
| **per-table-2** | A table can hold at most **4** sing songs waiting at once | Fair **round-robin between tables** |
| **per-person-1** | A person can hold at most **2** sing songs waiting at once | Fair **round-robin between people**, by who sang least recently |

**full-karaoke** is the default. Ordering is **round-robin by person** (spec A1),
tie-broken by earliest unplayed submission — one enthusiastic patron dumping 8
songs can't freeze everyone else out; their entries spread across future rounds
(the FIFO *feel* is preserved for casual use, but hogging is capped
structurally). No cap on how many a person may queue.

**per-table-2** keeps one table from hogging the mic. Each table takes turns:
one song from table A, then table B, then back to A. A table may hold up to
**4** queued songs (two rounds of lookahead); a 5th is politely rejected
(`table-cap`) until one plays. A song with no table number is treated as its own
private "table" keyed to that person, so table-less singers still rotate fairly
and get the same 4-song allowance.

**per-person-1** makes it maximally fair between *individuals*. You may hold up
to **2** songs waiting (current round + next); a 3rd is rejected with
`person-cap`. The queue always favors **whoever sang least recently** — someone who has never sung
outranks someone who sang an hour ago, who outranks someone who just sang. As
soon as your song plays you can queue another, and you drop to the back behind
everyone who's been waiting longer.

### How listen/dance songs interleave

`listen` entries **never consume a sing turn** and are **never blocked by the
caps** (you can always ask to dance). But they can't be allowed to starve the
singers either — imagine 20 people queueing dance tracks while one nervous
singer waits forever.

The rule: **at most `maxConsecutiveListen` listen songs may play in a row while
a singer is still waiting** (engine default **1**). The **cantai app configures
`0`** — the spec policy (A3): listens play *only* when no sing entry is pending,
so karaoke is always the show and music just fills the gaps. The interleave
capability is retained as the venue-toggle knob the spec earmarked: set
`maxConsecutiveListen` to `1`+ (a listen may slip between singers) or to
**`null` ("no cap")** for a dance-forward vibe. When *no* singers are queued, all
listen songs play in submission order regardless. (`Infinity` is accepted at
`createQueue` and normalized to `null` so state stays JSON-safe to snapshot.)

This cap is enforced **across real playback, not just in a preview**: the
engine persists the current consecutive-listen run on `QueueState`
(`consecutiveListen`, reset whenever a sing entry plays), so calling `advance`
song-by-song plays exactly the order `peekUpcoming` promised. What the venue
screen shows is what actually airs.

### No-shows, leavers, and edits

- **Skip / no-show** (`skip`): the person at the mic isn't there. The **first**
  no-show is forgiven — removed **without penalty** (their "last sang" standing
  is untouched) and `skip` reports `graceGranted: true`, so the caller may
  re-queue their entry with `graceRequeue: true` (see below). A **second
  consecutive** no-show by the same person (no actual sing in between) IS charged
  credit — their recency is bumped like a played turn so they drop in the
  rotation (`graceGranted: false`), preventing "queue and vanish" gaming.
  Singing anytime resets the consecutive-no-show streak.
- **Grace re-queue** (`graceRequeue: true` on an entry): a forgiven no-show's
  re-queued song is scheduled at the **front of that person's next-round slot**
  — ahead of their own other pending entries, and their group sorts first among
  equal-credit groups. It never leapfrogs a group that has genuinely less
  credit. Single-use by construction: the flag rides on the entry, so it's gone
  once the entry plays.
- **Leaving** (`removeEntry`): pulls an entry out of the queue. Idempotent — a
  no-op if it's already gone. Frees up that person's/table's cap immediately.
- **Changing tables** (`moveEntryToTable`): re-buckets the entry. A correction
  is always honored, even if it briefly pushes a table over its 4-song cap
  (those extras simply drain off; nothing is dropped).
- **Duplicate submissions**: the same person submitting the same video twice
  **in the same mode** while it's still queued is rejected (`duplicate`). After
  it plays, they may submit it again. A `listen` request for a video does not
  block a `sing` request for the same video (and vice-versa) — asking to dance
  to a song and asking to sing it are different requests.
- **Mode switch mid-session** (`setVenueMode`): **never drops anyone.** Existing
  entries are grandfathered in — even if they'd now be over a cap — and the play
  order simply recomputes under the new policy. The new caps apply only to
  *new* submissions from that point on.

## API

```ts
import {
  createQueue, addEntry, removeEntry, moveEntryToTable,
  setVenueMode, getEffectiveOrder, peekUpcoming, advance, skip,
} from "@cantai/rotation-engine";

let state = createQueue("per-person-1");            // or full-karaoke / per-table-2

const res = addEntry(state, {
  id: "entry-123", videoId: "dQw4w9WgXcQ", title: "…",
  uuid: "user-abc", nickname: "Ana", table: "5", mode: "sing",
});
if (res.accepted) state = res.state;                 // else res.reason tells you why

const upNext = peekUpcoming(state, 5);               // Entry[] — the next 5 to play

const { state: after, played } = advance(state);     // play the head; played may be undefined
state = after;

const { state: s2, skipped } = skip(state);          // no-show the current head
```

All state is a plain serializable object (`QueueState`) — persist it, diff it,
or send it over the wire freely.

## Development

Zero runtime dependencies. Tests use the Node built-in test runner and TypeScript
type-stripping (Node ≥ 22.6; developed on Node 25).

```bash
npm install      # dev-only: typescript + @types/node
npm test         # node --test
npm run typecheck # tsc --noEmit
```

## Notes

- CI runs this package's `node --test` suite as a step of the app workflow
  (`.github/workflows/ci.yml`, wired in the TICKET-10 integration PR).
- The engine is deliberately I/O-free: identity, persistence, realtime sync, and
  the YouTube player all live in the app that consumes this library.
- **Accepted v1 limitation — identity is self-reported (PR #14 security
  MEDIUM-2).** Fairness caps key on the client-minted anonymous `uuid`
  (browser localStorage) and the user-typed `table` string. Clearing
  localStorage / going incognito mints a fresh uuid (cap reset), and fake table
  strings dodge the per-table cap. This is inherent to the no-signup identity
  model the product chose; at bar scale the host sees queue spam visually and
  has remove controls. Server-side per-IP pending-sing grouping is the planned
  lightweight mitigation (tracked in the #14 hardening batch) — it raises the
  bypass cost without requiring accounts.
