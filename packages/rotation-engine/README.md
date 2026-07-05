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
| **full-karaoke** | Everybody queues freely | First-in, first-out (FIFO) |
| **per-table-2** | A table can have at most **2** sing songs waiting at once | Fair **round-robin between tables** |
| **per-person-1** | A person can have at most **1** sing song waiting at once | Fair **round-robin between people**, by who sang least recently |

**full-karaoke** is the simplest: songs play in the order they were submitted.

**per-table-2** keeps one table from hogging the mic. Each table takes turns:
one song from table A, then one from table B, then back to A, and so on. A
table's 3rd simultaneous request is politely rejected (`table-cap`) until one of
its two queued songs has played. A song with no table number is treated as its
own private "table" keyed to that person, so table-less singers still rotate
fairly and get the same 2-song allowance.

**per-person-1** makes it maximally fair between *individuals*. You can only
have one song waiting at a time (a 2nd is rejected with `person-cap`). The queue
always favors **whoever sang least recently** — someone who has never sung
outranks someone who sang an hour ago, who outranks someone who just sang. As
soon as your song plays you can queue another, and you drop to the back behind
everyone who's been waiting longer.

### How listen/dance songs interleave

`listen` entries **never consume a sing turn** and are **never blocked by the
caps** (you can always ask to dance). But they can't be allowed to starve the
singers either — imagine 20 people queueing dance tracks while one nervous
singer waits forever.

The rule: **at most `maxConsecutiveListen` listen songs may play in a row while
a singer is still waiting** (default **1**). So with the default, a listen song
can slip in between two sing turns, but never two listen songs back-to-back
while a singer waits. When *no* singers are queued, all listen songs simply play
in submission order. Set `maxConsecutiveListen` higher — or to **`null` ("no
cap")** — if a venue wants a more dance-forward vibe. (`Infinity` is accepted at
`createQueue` and normalized to `null` so that queue state stays safe to
snapshot as JSON.)

This cap is enforced **across real playback, not just in a preview**: the
engine persists the current consecutive-listen run on `QueueState`
(`consecutiveListen`, reset whenever a sing entry plays), so calling `advance`
song-by-song plays exactly the order `peekUpcoming` promised. What the venue
screen shows is what actually airs.

### No-shows, leavers, and edits

- **Skip / no-show** (`skip`): the person at the mic isn't there. They're
  removed from the queue **without penalty** — their "last sang" standing is
  untouched, so if they re-join they keep the priority they had. (They didn't
  actually sing, so fairness shouldn't punish *or* reward them.)
- **Leaving** (`removeEntry`): pulls an entry out of the queue. Idempotent — a
  no-op if it's already gone. Frees up that person's/table's cap immediately.
- **Changing tables** (`moveEntryToTable`): re-buckets the entry. A correction
  is always honored, even if it briefly pushes a table over its 2-song cap
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

- CI wiring for this package lands with the app-integration ticket (the app's
  workflow owns `.github/workflows/ci.yml`).
- The engine is deliberately I/O-free: identity, persistence, realtime sync, and
  the YouTube player all live in the app that consumes this library.
