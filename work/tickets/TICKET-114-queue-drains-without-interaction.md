# TICKET-114 — Investigate: the in-memory queue drains within 1-3s with no browser interaction

**Filed:** 2026-09-27, observed independently by two agents during TICKET-109.
**Priority:** MED — almost certainly a dev/test-environment artifact, but it is unexplained, and the alternative reading is a queue that empties itself.
**Type:** Investigation (spike)
**Size:** S

## What was observed

While testing `/tv`, both the TICKET-109 Dev and the TICKET-109 App Tester independently reported that a queued song **drains from the queue within 1-3 seconds with no browser interaction at all**. The two observations match closely enough that this is a real behaviour in that environment, not one agent's mistake.

## Why it is worth a ticket rather than a shrug

The benign explanation is easy to reach for and probably right: the TV watchdog auto-skips a video it believes has stalled (`components/tv/watchdog.ts`), and in a headless environment with no real YouTube playback, "stalled" is exactly what a healthy player looks like. A related instance is already on record — a mainstream video was auto-skipped within ~10s during the TICKET-103 Step 0 work, while Creative-Commons videos played fine.

But **nobody has actually confirmed that**, and the unexamined alternative is a production-affecting defect: a queue that advances or expires entries on its own would mean a patron's song vanishing before it plays, which is the most visible failure this product could have in a venue. The cost of checking is minutes; the cost of being wrong is the core promise.

It also has a practical cost right now: it makes every `/tv` test harder to write, and three separate agents have lost time to state that disappeared underneath them (compounding the separate dev-server store-eviction issue documented in the `run-app` skill).

## What to establish

- **Which mechanism removes the entry** — watchdog auto-skip, the advance/rotation path, a retention TTL, or something else. Name it with the code path, don't infer it.
- **Whether it can happen in production**, where real playback occurs and the store is Upstash rather than in-memory. If the answer is "no, it requires a non-playing player", say so with the evidence and close this.
- If it **can** happen with real playback (a slow network, a TV that buffers, an ad roll), that is a genuine defect and gets its own ticket with a proposed guard.
- Whether the watchdog's stall threshold is appropriate for a television on a venue's wifi, which is a slower and less reliable environment than a developer's laptop.

## Constraints

- Read **`proof-by-absence`** before concluding the production path is unaffected — "I could not reproduce it in prod" is not the same as "it cannot happen in prod", and that distinction is the whole value of this ticket.
- Prefer reading the watchdog/advance code and writing a targeted test over long manual observation.

## Acceptance

A short report naming the exact mechanism and stating plainly whether production is affected, with evidence for the claim either way.
