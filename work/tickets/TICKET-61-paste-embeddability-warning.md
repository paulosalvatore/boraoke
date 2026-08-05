# TICKET-61 — Non-blocking embeddability warning on paste-submit

- **Status:** delivered (PR open, not merged)
- **Branch:** `ticket/61-paste-embeddability-warning` · **Worktree:** `.worktrees/ticket-61` · **Port:** 3161
- **Origin:** `work/plans/TICKET-41-plan.md` §5 ("Paste-verify decision — DEFERRED"). The board recorded this as blocked on "PR #40"; that referred to **TICKET-40**, merged 2026-07-08. The file-ownership collision that caused the deferral is gone, so the ticket is unblocked and implements exactly the design §5 named.

## Problem

A pasted YouTube link bypasses search, so it never passes through the `videoEmbeddable=true` + `videoSyndicated=true` filters in `lib/youtube-search.ts`. A non-embeddable video is accepted into the queue, reaches the venue TV, refuses to play, and is skipped by the TICKET-41 watchdog — in front of the patron who requested it. The patron gets no signal at submit time.

## Solution

On the **paste** path of `POST /api/queue`, ask the YouTube Data API `videos.list` for `status.embeddable` and return a **non-blocking `warning`** string in the existing success response. The patron form renders it next to the success line as advisory copy: *"esse vídeo não permite reprodução em telões — pode não tocar"* (localized pt-BR / en / es).

The submit itself is **never** affected: the check runs after the entry has already passed every acceptance rule, and its only possible output is one optional advisory string.

## Paste vs search — the distinction (single place: `app/api/queue/route.ts`)

A submission is a **PASTE** when either:

1. it carried no pre-parsed `videoId` at all (a raw `youtubeUrl` body — nothing but a paste produces a URL), or
2. the client explicitly declared `source: "paste"`.

Everything else — a pre-parsed `videoId` with `source` absent, `"search"`, or an unrecognised value — is **SEARCH** and skips the check entirely. That default is deliberate: it is the quota-conservative choice and it keeps already-cached older clients (which send `videoId` and no `source`) behaving exactly as they do today.

`source` is a **client hint**, and that is safe by construction: it can only cause one extra quota unit or one missing advisory warning. It can never affect acceptance, storage, or authorization.

Client side, `PatronRoom.tsx` derives `source` from the selection shape, because `SongSelection` (`components/SongSearch.tsx`, owned by a parallel ticket) is `{ videoId, title? }` and exposes nothing else: SongSearch emits a `title` **only** for a picked real search result, while a resolved pasted link — and a pick of the synthetic row a paste creates — always arrive with `title` undefined. So "no title" == "paste" for every path in that component.

**Known imprecision, deliberately accepted:** a real search result with an empty title would be labelled `paste`. Cost: one quota unit, and the check returns `embeddable` anyway because search only ever returns embeddable results. **Follow-up:** put an explicit `source` on `SongSelection` in `components/SongSearch.tsx` once that file is free.

Bonus fix: the existing `song_queued` telemetry `props.kind` used `videoId`-presence alone to label paste vs search. The patron form always sends `videoId` (it parses pasted links client-side), so **every** submit was being logged as `"search"`. It now uses the same `isPaste` derivation.

## Quota cost

- **1 unit per checked paste-submit.** `videos.list` costs 1 unit regardless of the `part` requested; we request `part=status` only.
- **0 units** for: search-selected submits, submits rejected by validation / rate limit / rotation rules / body-size cap, and any request in an environment with no `YOUTUBE_API_KEY`.
- The default Data API allowance is 10,000 units/day. For scale: `/api/search` costs 100 units (search.list) + 1 (videos.list) per query, so one paste check is ~1% of one search. Pastes are the minority path, so the added load is negligible against the search budget.
- The call is placed **after** the dual-bucket submit rate limit (10/min per patronUuid, 60/min per IP) and after `checkSubmit`, so an unauthenticated attacker cannot spend quota faster than the existing submit limit allows, and a refused submit never spends any.

## Acceptance criteria

| # | Criterion | Where verified |
|---|---|---|
| AC1 | Non-embeddable paste → existing 201/202 success, unchanged shape, **plus** `warning`; the submit still succeeds | `__tests__/api-queue.test.ts` "AC1", "AC1b" |
| AC2 | Embeddable paste → no `warning` | `__tests__/api-queue.test.ts` "AC2" |
| AC3 | API error / timeout / quota exhaustion / no key → fail-open: no warning, no 5xx, request succeeds as today | `__tests__/api-queue.test.ts` "AC3" (4 cases) + `__tests__/youtube.test.ts` fail-open block (7 cases) |
| AC4 | Search-selected ids skip the check entirely (no outbound call) | `__tests__/api-queue.test.ts` "AC4" (3 cases) |
| AC5 | Quota cost documented | this file |
| AC6 | Unit tests mock the YouTube API | both suites mock at the `fetch` boundary — no network, ever |
| AC7 | Response contract respected — `warning` is a plain localized string, no echoed `QueueEntry`/`patronUuid` (TICKET-54) | `__tests__/api-queue.test.ts` "AC1b" asserts the body keys are exactly `["ok","warning"]` |

## Files changed

- `lib/youtube.ts` — new `checkEmbeddable()` + `EMBEDDABLE_CHECK_TIMEOUT_MS` + `EmbeddableStatus`. Never throws; every failure collapses to `"unknown"`; bounded by `AbortSignal.timeout(1500)`; re-validates the id before it reaches an outbound URL and builds the query with `URLSearchParams`.
- `app/api/queue/route.ts` — paste/search derivation, the pre-check call, `warning` on the 201 and 202 responses, telemetry `kind` fix.
- `app/(patron)/[room]/PatronRoom.tsx` — `source` on the submit body, reads the optional `warning`, renders it (amber, `role="status"`, `data-testid="submit-warning"`).
- `messages/{pt-BR,en,es}.json` — `Errors.submitNotEmbeddable`.
- `__tests__/youtube.test.ts`, `__tests__/api-queue.test.ts` — 22 new tests.

## Gate outcomes

- **App Tester: PASS** — true end-to-end (real `next dev` on 3161 + real Playwright browser; only the outbound YouTube call stubbed, via the loopback `YOUTUBE_API_ORIGIN` seam — no client-side `/api/queue` mocking). Non-embeddable paste rendered both the success line and the warning with the exact pt-BR copy; embeddable paste rendered the success line only. Evidence: `work/evidence/TICKET-61/paste-non-embeddable-warning.png`, `work/evidence/TICKET-61/paste-embeddable-no-warning.png`. Report: `work/reports/review/TICKET-61-apptester.md`.
- **Cyber: PASS** — 0 CRITICAL, 0 HIGH, 3 MEDIUM, 3 LOW, 4 INFO. No SSRF/injection (id anchored-regex validated twice, `URLSearchParams` throughout, origin env-only). Call placed after all validation + the rate limit + `checkSubmit`, with a 1500ms abort timeout. No data leakage; the TICKET-54 trim is preserved. Report: `work/reports/review/TICKET-61-cyber.md`.

Two findings fixed in-branch:

- The `getTranslations` call on the new success path was the one unguarded `await` before `store.addEntry` — an i18n failure would have turned an accepted submit into a 500. The whole advisory block is now try/caught.
- `YOUTUBE_API_ORIGIN` is now **loopback-only** (plus the existing `NODE_ENV !== "production"` guard), so the override cannot ship a real API key to an arbitrary host even by operator mistake.

Findings left as follow-ups (not this ticket): no cache on the outbound check (embeddability is stable for days; the existing Upstash search cache from TICKET-55 is the natural home), and the submit limiter being an in-memory per-instance `Map`. Both are dominated by a pre-existing exposure the gate flagged — `/api/search` allows 30 req/10s/IP at **100 units each**, ~50x cheaper to exploit than this 1-unit path. Recommend one follow-up ticket covering both.

## Out of scope

- No change to the TV player / watchdog: a non-embeddable video that is submitted anyway is still handled at play time by TICKET-41's `onError` skip. This warning is UX polish in front of that, not a replacement.
- No blocking, no rejection, no host-side surfacing of the warning.
- `components/SongSearch.tsx` untouched (parallel ticket owns it) — hence the shape-derived `source`.
