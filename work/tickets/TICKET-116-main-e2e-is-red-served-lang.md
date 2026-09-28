# TICKET-116 — `main`'s e2e suite is RED: the venue TV does not serve the room's language, and nothing was catching it

**Filed:** 2026-09-28, found while re-gating PR #84 against a freshly-merged `main`.
**Priority:** HIGH — not for the failing test itself, but because it proves regressions reach `main` unnoticed.
**Type:** Bug + gate gap
**Size:** M

## What

`e2e/served-lang.spec.ts:105` — *"the venue TV serves the ROOM's language, never the visitor's"* (TICKET-79) — **fails on `main`, deterministically.** Measured 3 runs out of 3 in a clean detached worktree at `main`, on two different ports, with every other test in that file passing. It is not a flake.

The assertion is that `/{room}/tv` served with `Accept-Language: es-ES,es;q=0.9` returns `lang="en"` — the **room's** language, never the visitor's.

## Why this is HIGH despite being one test

**The failing test is the smaller half of the finding. The larger half is that nobody knew.**

Boraoke has no gate that runs this suite:
- There is **no code-review bot** on this repo (the only actor on PRs is `vercel`, a deployment bot).
- `verify-green-local.sh` — the house's authoritative merge gate under D-051 — runs `md-doctor` and `shell-tests`, **neither of which exists in boraoke**.
- GitHub Actions is deliberately minimal and advisory-only (D-051) and does not run e2e.

So the e2e suite runs **only when an agent chooses to run it**, which means a regression lands on `main` and sits there silently until someone re-gates for an unrelated reason. That is exactly what happened: this was found only because a merge-sync pulled new code into PR #84 and the TM re-ran the suite rather than quoting the PR's earlier numbers.

**The product behaviour at stake is real, not cosmetic.** TICKET-79 exists because a venue TV showing the *visitor's* language rather than the room's is wrong — the TV is the venue's screen, shared by a room of people, and its language is a property of the venue, not of whoever last loaded it. If this is a genuine regression rather than a broken test, a venue in Brazil could be showing an English or Spanish interface.

## What's needed

1. **Establish which it is:** a real regression in served `<html lang>` for `/{room}/tv`, or a test that has drifted from correct behaviour. Do not assume the test is wrong because it is inconvenient — TICKET-79 shipped this deliberately and TICKET-75's client-side patch was removed in favour of it.
2. **Find when it broke**, by bisecting over the recent merges (103, 106, 109 all landed on 2026-09-27). Cheap, since the failure is deterministic.
3. **Fix the cause**, and if the test was right all along, check whether production is affected — this is a served-HTML property, so it is verifiable against `boraoke.com` directly.
4. **Close the gate gap**, which is the durable half. Options to weigh rather than assume: run the e2e suite in the GitHub Actions job despite its advisory status, add a boraoke-appropriate target to the local-Docker gate so `verify-green-local.sh` means something here, or make an e2e run a required step of the TM's own merge procedure. The current state — a suite that only runs when someone remembers — will produce this again.

## Constraints

- Read **`proof-by-absence`** before concluding anything is unaffected; "I could not reproduce it in production" is not "production is fine".
- Note the environmental hazards already documented for this repo: the in-memory store resets on route compile **and again on dev-server eviction every ~25s of idle**, and a second `PORT=` does **not** isolate a Next dev server because the `.next` cache is shared. Rule those out before blaming them — this failure reproduced on two ports with a clean `.next`.

## Acceptance

The test passes for the right reason (either the product is fixed, or the test is corrected with a written justification), the breaking change is identified, production impact is stated with evidence, and a gate exists that would have caught it.

## 2026-09-28 UPDATE — ROOT CAUSE FOUND, and it is not a product regression. It is one defect behind a whole family of flakes.

A read-only diagnosis (no suite run — two latency measurements were in flight) establishes this is **neither a product regression nor test drift**, and that **it predates 103/106/109** — none of those three touches the served-lang path, and `git log` over `middleware.ts`, `i18n/`, `app/layout.tsx` and `app/(patron)/[room]/tv/` ends at TICKET-79 itself.

**The mechanism.** Both in-memory stores are **plain module-level singletons, not pinned to `globalThis`**:

- `lib/rooms.ts:278` — `export const roomBackend: RoomBackend = createBackend();`
- `lib/store.ts:39` — `export const store: QueueStore = createStore();`

Under `next dev`, **any module re-evaluation discards every room and every queue entry.** The served-lang test seeds a room and then loads `/{room}/tv`; if a route compiles in between, the room is gone and `getRoomLanguage` falls back to `pt-BR`, failing an assertion that expects the room's `en`. The visitor's `Accept-Language` is structurally unreachable on the TV branch (`i18n/resolve-request-locale.ts:46-48` returns `getRoomLanguage(room)` and never reads the header), so a *product* explanation for the failure does not exist.

**`served-lang.spec.ts` is the only seed-then-load spec that calls no warm-up helper.** That is why it is the one that fails.

**One observation refines the diagnosis and makes the fix more urgent.** The hypothesis was that a full-suite run protects this spec by accident, because alphabetically earlier specs compile `/[room]/tv` first — but **the observed failure occurred in a full-suite run.** The reconciling explanation is the separately-measured dev-server behaviour: `next dev` **evicts and recompiles** routes after roughly 25 seconds of idle (documented in the `run-app` skill after `/apple-icon.png` wiped three testers' state). So the store is wiped not only on *first* compile but on **any** recompile, at arbitrary points in a long run. That makes the hazard **ordering-independent**: no amount of warm-up sequencing fully closes it.

**Therefore the real fix is to pin the dev singletons to `globalThis`**, the standard Next.js dev pattern, so module re-evaluation cannot discard state. That eliminates the entire class rather than another instance of it. Consider what this class has already cost: three warm-up helpers in `e2e/helpers.ts`, the TICKET-88 / TICKET-92 / TICKET-65 / TICKET-68 deflaking work, a warm-up being added to `search.spec.ts` right now under TICKET-108, four agents losing time to vanished state in a single day, and this red `main`.

**Production is not affected, and the reason is structural:** production runs the Upstash driver (`lib/rooms.ts:257-278`), where no module re-evaluation can lose a record. The middleware and i18n files are byte-identical to the TICKET-79 merge that was verified against production.

### Revised scope

1. **Pin both memory singletons to `globalThis`** (dev/test only — the Upstash path is stateless and unaffected). Check first whether any spec *relies* on the store resetting between files; if one does, that dependency is itself a defect to record.
2. **Confirm the mechanism before fixing**, cheaply: run `served-lang.spec.ts` **alone with a clean `.next`** and capture the **received** value. `pt-BR` confirms the store-reset mechanism. **`es` would instead mean the pathname header is not reaching the request config — a genuine regression with production impact**, and that must be ruled out rather than assumed. The diagnosis argues strongly for `pt-BR` (an `es` result would also have failed the `/default/tv` and patron-chain assertions in the same file, which passed), but the value settles it and nobody has read it yet — the original error context was not retained.
3. **Then re-assess the warm-up helpers.** With a `globalThis`-pinned store they become belt-and-braces rather than load-bearing; leave them, but stop treating "add another warm-up" as the answer to this class.
4. **The gate gap stands unchanged** and remains the durable half: nothing in this house runs boraoke's e2e suite, which is why a red `main` went unnoticed.

**Do not run the confirming suite while a latency-sensitive measurement is in flight** — a concurrent suite shares the `.next` cache and has already corrupted one measurement on this product.
