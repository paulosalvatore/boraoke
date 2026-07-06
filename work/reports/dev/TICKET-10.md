# TICKET-10 — Rotation modes UI (engine integration) — Dev Report

- **Status:** IMPLEMENTED — self-verified green locally (build + 308 jest + 59 engine + 18 e2e). Awaiting CI + gates.
- **Branch:** `ticket/10-rotation-modes` · **Worktree:** `.worktrees/ticket-10` · **App port:** 3010
- **PR:** #14 (draft) — https://github.com/paulosalvatore/cantai/pull/14
- **Plan:** `work/plans/TICKET-10-plan.md` (APPROVED-BY: auto-approved via TM dispatch of the full authoritative ticket — validated downstream by gates + TL merge of PR #14)

## What shipped

The fairness brain is live. The venue picks full-karaoke / 2-por-mesa / 1-por-pessoa on `/[room]/admin`; the shared queue orders itself via `@cantai/rotation-engine`; submit enforces per-mode caps; TV/patron render the effective order with a reorder toast and a 30s "get to the mic" no-show call.

### Integration model (frozen store, composition on top)
Ordering is computed fresh over the store queue by the adapter `lib/rotation.ts`; the store's physical order is kept in effective order by **re-laying** — one additive bulk `rewrite` store op (added post-security-gate; the wave-2 interface freeze ended with wave 2) — on the two ordering mutations — submit and mode-switch — so reads AND the store-head-based `advance`/`skip` all reflect fair order. `items[0]` is the pinned now-playing entry; its fairness group is seeded as "served this round" (the spec `nowPlaying` quota rule). Fairness memory is one turn deep — a documented v1 tradeoff the ticket accepts ("full-queue read-per-advance at bar scale"); deeper cross-play credit needs store state the contract forbids (follow-up).

### A1–A6 reconciliation (engine, policy per merged spec)
| # | Resolution |
|---|---|
| A1 | full-karaoke FIFO → **round-robin by uuid** (`computeSingOrder` routes all modes through `roundRobin`; full & per-person key by uuid, per-table by table). AC1 covered. |
| A2 | caps 2/table → **4**, 1/person → **2** (`capViolation`; `PER_TABLE_CAP`/`PER_PERSON_CAP`). |
| A3 | engine listen knob kept (default 1); **app configures `0`** = spec policy (listen only when no sing pending). Interleave capability retained for the future venue toggle. |
| A4 | `Entry.graceRequeue` consumed by `order()` (grace entry first within its group; grace-holding group first among equal credit — never leapfrogs a lower-credit group). `skip()` returns `graceGranted`; `QueueState.noShowStreakByUuid` charges credit on the 2nd consecutive no-show; streak resets on an actual sing. AC6 covered. |
| A5 | engine already rejects only exact same uuid+video+mode; different-uuid same-song allowed. App adds submit-time duplicate copy + (song-level dupes are a UI warning surface). |
| A6 | **Canonical boundary = `lib/rotation.ts`.** `RoomMode` === engine `VenueMode` strings verbatim (zero mapping). App `patronUuid`→`uuid`, `mode:"listen-dance"`→`"listen"` mapped only in the adapter. No cross-codebase rename. |

### Mode persistence (additive, no re-migration)
`RoomSettings.mode: RoomMode` (was `Mode | "full"`). `lib/rooms.ts` gains an additive backend `update` + public `setRoomMode`/`getRoomMode`. Legacy records (`"full"`/entry-mode placeholders) read back through `normalizeRoomMode` as `full-karaoke` — no write, no migration. New rooms default `full-karaoke`.

### Telemetry
`host_action` gains `action: "mode_change"` (+ `mode`/`from` props) — a single new event prop, NOT a new event type (telemetry files untouched). No-show grace emits `song_skipped{reason:"noshow"}`.

## Files
- Engine: `packages/rotation-engine/src/{types,engine}.ts`, `test/engine.test.ts` (48→59 tests), `README.md`.
- Adapter/model: `lib/rotation-modes.ts` (new, client-safe), `lib/rotation.ts` (new, server), `lib/rooms.ts` (additive).
- Routes: `app/api/queue/route.ts` (caps + re-lay + mode in GET), `app/api/host/mode/route.ts` (new), `app/api/host/skip/route.ts` (grace).
- UI: `components/host/ModeSwitcher.{tsx,module.css}` (new), `app/(patron)/[room]/admin/AdminRoom.tsx`, `app/(patron)/[room]/PatronRoom.tsx`, `components/tv/TvScreen.tsx` + `tv.module.css`.
- Wiring: `tsconfig.json` + `jest.config.ts` (`@cantai/rotation-engine`), `.github/workflows/ci.yml` (engine tests + Node 24).
- Tests: `__tests__/rotation-adapter.test.ts`, `__tests__/api-mode.test.ts` (new); `e2e/rotation-modes.spec.ts` (new); updated `__tests__/{api-queue,rooms}.test.ts` + `e2e/{tv,rooms}.spec.ts`.

## Implementation log
- `74e5a53` engine alignment A1–A5 + grace (59 tests, typecheck clean, README).
- `43d6209` app wiring — adapter, rooms mutator, routes, ModeSwitcher, patron/TV, tsconfig/jest.
- `d726fd7` e2e mode-switch-reorders + 5 evidence screenshots + TV mic-call testid.
- CI step for engine tests + Node 24 (this commit).

## Self-verification (local)
- Engine: `node --test` → **59 pass / 0 fail**; `tsc --noEmit` clean.
- App unit: `STORE_DRIVER=memory jest` → **Test Suites 22 passed, Tests 308 passed**.
- Build: `npm run build` → success (incl. `/api/host/mode`).
- E2e: `PORT=3010 playwright test` → **18 passed**.
- Evidence: `work/evidence/ticket-10/*.png` (5) — admin switcher (ATIVO + verbatim copy), per-table reorder + toast, patron mode hint, patron reorder toast, TV 30s mic-call.

CI (`gh pr checks`) output to be pasted before requesting gates (S1 contract).

## Security-gate resolutions (PASS-WITH-NOTES verdict, 2026-07-06)

- **MEDIUM-1 (fixed, both tracks):**
  - (a) Additive `QueueStore.rewrite(roomId, entries)` bulk-replace op — interface + MemoryStore + UpstashStore (Upstash: single del+rpush-all; the pre-existing private helper made public as `rewrite`, internal helper renamed `rewriteKey`). `relayQueue` now issues **one** store call regardless of queue depth (was N-1 sequential `reorder` ≈ 3 RTTs each, ~597 calls near QUEUE_MAX). Conformance-tested in the `describe.each` store suite (5 new tests × both drivers) plus a spy test asserting exactly 1 `rewrite` / 0 `reorder` calls per relay and no write on 0/1-entry queues.
  - (b) Dual-bucket submit rate limiter `lib/queue-rate-limit.ts` on POST /api/queue (house pattern — mirrors the search/feedback/beacon limiters): **10/min/patronUuid + 60/min/IP**, LRU-capped bucket map, polite pt-BR 429 ("Calma, cantor! Muitos pedidos em pouco tempo…"), charged only after uuid validation (garbage can't burn a patron's bucket) and checked before any store work (over-limit never triggers a queue read or relay). Unit + route tests: trips at the cap, window slides, uuid rotation can't dodge the IP bucket, malformed submits don't charge.
- **INFO-1 (fixed):** `/api/host/mode` derives its `valid` set from `MODE_META` (single source of truth; the 400 copy derives too).
- **MEDIUM-2 (documented, per remediation direction):** accepted-v1-limitation note in `packages/rotation-engine/README.md` §Notes — caps key on self-reported uuid/table; rotation/fake tables bypass them; host visual detection + remove controls at bar scale; per-IP pending-sing grouping tracked in the #14 hardening batch.

Post-fix verification: app jest **23 suites / 325 tests** (was 308, +17), engine **59/59**, `npm run build` clean, Playwright e2e **18/18**.

## Notes / follow-ups (not blocking)
- Host manual reorder (TICKET-7) is a transient override — the next submit/mode-switch re-lays under the fairness engine. A host "pin/manual mode" is a possible follow-up.
- Deeper (multi-turn) fairness credit needs persisted session history — out of scope under the frozen store; documented in `lib/rotation.ts`.
- Grace is host-authorized only (patrons can't self-grant): `/api/host/skip {grace:true}` re-queues the head with `graceRequeue`.
