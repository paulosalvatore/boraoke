# Dev Report — TICKET-44 (venue-optional song moderation)

**Status:** IMPLEMENTED — self-verified green (build + 470 unit + e2e). Awaiting local-Docker verify-green + gates.
**Branch:** `ticket/44-moderation` · worktree `.worktrees/ticket-44` · port `3044`
**PR:** https://github.com/paulosalvatore/boraoke/pull/25 (draft)

## Picking up from

Fresh start. Pulled latest `origin/main` (i18n / trilingual catalogs already merged). Created worktree `.worktrees/ticket-44`, branch `ticket/44-moderation`, upstream `origin/ticket/44-moderation` (verified), port 3044 free. Emitted `worktree_created`.

## Exploration (done)

Read the queue/host/store/i18n/telemetry/test areas directly + one Explore fan-out. Key findings:

- **Setting pattern to mirror:** `RoomSettings` in `lib/rooms.ts`; `mode` + optional `language?`. `getRoomMode`/`setRoomMode` + `getRoomLanguage`/`setRoomLanguage` are the exact template for `getRoomModeration`/`setRoomModeration` (in-place `roomBackend.update`, normalize absent→default, 404-via-null on missing room).
- **Host endpoint template:** `/api/host/language/route.ts` — `roomIdFromRequest` → `requireHost` → JSON → validate → setter → `track("host_action", …)` → `{ ok, … }`.
- **Parallel-keyspace pattern:** `lib/feedback-store.ts` is the model — memory+upstash drivers, injectable `FeedbackRedisLike`, `feedback:{index,item,rl}` keyspace, `feedbackStore` singleton, both-driver conformance test with a `FakeRedis`. Pending store mirrors this exactly under `room:<id>:pending:*`.
- **Frozen queue = clean isolation:** `QueueStore` (`lib/store/types.ts`) is frozen; rotation (`orderQueue`/`relayQueue`), public `GET /api/queue`, and `TvScreen` all read ONLY `store.getQueue`. So pending entries in a separate keyspace are invisible to fairness/caps/TV/public-queue **by construction** — no filtering, and **no TvScreen edit** (→ zero overlap with TICKET-45).
- **Submit path:** `/api/queue` POST gates in order: size → JSON → field validation → `submitRateLimitOk` (429 `submit_rejected{reason:rate}`) → `checkSubmit` caps (409) → `addEntry` cap (429) → `relayQueue` → `song_queued` 201. Moderation branch inserts after `checkSubmit`, before `addEntry`.
- **Telemetry frozen union:** `host_action` + `submit_rejected` already exist — I only add new prop VALUES (`action:approve|reject|moderation_change`, `reason:moderation`), no new event types (docstring update only).
- **UI:** `AdminRoom.tsx` (3s poll, optimistic host actions, language card = toggle template) + `PatronRoom.tsx` (3s poll, submit handler). e2e: `warmUp`/`drain`/`seed` helpers, dev token `cantai-dev-host`, `PORT` override.

## Plan

`work/plans/TICKET-44-plan.md` — full file list, endpoint contract table, submission branch, test strategy. No user input needed (default-OFF, additive, unambiguous).

## Implementation log

- `80e1b87` — ticket + plan + dev report.
- `b99e96e` — backend + API: `lib/pending-{store,types}.ts` (parallel keyspace, both drivers), `RoomSettings.moderation` + `get/setRoomModeration`, `/api/host/moderation`, `/api/host/pending` (GET), `/api/host/pending/{approve,reject}`, `/api/queue/pending` (patron uuid-scoped GET), `/api/queue` POST moderation branch (202) + `moderation` in GET payload, telemetry docstrings.
- `fc8c1bf` — UI + i18n + unit tests: AdminRoom moderation toggle + pending-approval section (badge/approve/reject) + poll; PatronRoom pending/rejected view + poll; `admin.module.css` switch/pending styles; trilingual catalog strings; `pending-store.test.ts`, `room-moderation.test.ts`, `api-moderation.test.ts`.
- (next commit) — `e2e/moderation.spec.ts` + a `data-testid="moderation-track"` on the switch for a clickable target.

## Key decisions

- **Pending in a parallel keyspace** (`room:<id>:pending:*`), never the frozen `QueueStore`. The rotation engine / public queue / TvScreen read only `store.getQueue`, so unapproved entries are invisible to fairness/caps/TV **by construction** — no filtering, and **no TvScreen edit** (→ zero overlap with TICKET-45).
- **Caps AT approval, not submit.** Submit-time `checkSubmit` runs as a cheap pre-filter; the authoritative caps (`checkSubmit` + `QUEUE_MAX`) re-run at approve time against the live queue. A refused approval **re-adds** the entry to pending (never lost) and returns 409.
- **202 (not 201)** for a moderated submit so the patron client distinguishes "queued" from "awaiting approval".
- **Telemetry reuses** `host_action` (`action: approve|reject|moderation_change`) + `submit_rejected` (`reason: moderation`) — new prop VALUES only, no new event types (docstring-only change to `telemetry-types.ts`).
- **Bounded pending:** per-room (`PENDING_ROOM_MAX`, default 100) + per-uuid (`PENDING_UUID_MAX`, default 5) caps → polite 429 from the catalogs; the existing submit rate limit still runs upstream, unchanged.

## Self-verification

- **Build:** `npm run build` GREEN — all new routes compiled (`/api/host/moderation`, `/api/host/pending`, `/api/host/pending/approve`, `/api/host/pending/reject`, `/api/queue/pending`).
- **Unit:** `npx jest` → **Test Suites: 33 passed, Tests: 470 passed** (0 fail). Includes: pending-store both-driver conformance, room-moderation getter/setter, api-moderation flow (OFF→queued, ON→pending, approve→queued, reject→rejected, caps-at-approval, uuid isolation, unauth 401), i18n-completeness parity (195 keys × 3, ICU placeholders matched).
- **e2e (`PORT=3044`):** `e2e/moderation.spec.ts` → **3 passed** (OFF unchanged; ON approve→queue; ON reject→patron rejected). Full e2e suite run in progress — result pasted below.
- **verify-green-local (local-Docker):** _to run before requesting gates — output pasted here._

## Friction

- Worktrees carry no `node_modules` — needed `npm ci` in the worktree before build/e2e (expected; noted for the App Tester who reuses this worktree).
- The visually-hidden switch checkbox (`opacity:0`) is unclickable by Playwright; added `data-testid="moderation-track"` on the visible track span as the click target. Standard a11y-switch pattern gotcha.

## Deferred follow-ups (non-blocking)

- **Rejected-entry TTL.** A rejected pending entry is kept so the patron's poll can show the polite rejected state; it currently persists until the room is cleared (fine for the prototype — bounded by the room being ephemeral). A short TTL / "dismiss" so old rejected cards age out is a clean follow-up (mirrors telemetry's retention TTL). File as a ticket if desired.
- **Approve-time 409 UX.** On a caps-at-approval refusal the host sees `pendingApproveFailed`; a per-entry reason (duplicate vs queue-full) could be surfaced. Low priority.

## Overlap notes (TICKET-45)

No shared-file edits. Pending lives outside the queue → no TvScreen / advance / host-auth changes. e2e ships self-contained helpers → no shared e2e-helper edit. Clean parallel merge.
