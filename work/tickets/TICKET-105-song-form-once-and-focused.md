# TICKET-105 — Song request: ask table+number once, then title-only; bigger focused phone form

**Filed:** 2026-09-27, from the Tech Lead's live test of 2026-09-26 (brief items 7-8)
**Priority:** MED-HIGH — this is the patron-facing flow every guest in the venue touches.
**Type:** UX / mobile
**Size:** M
**Depends on:** TICKET-104 — reuse the device-persistence helper it settles on rather than inventing a second one.

## What the TL asked for

7. **Table + number are entered once**, then remembered on that device, so the recurring request form is **simple: just the song**. First time: table + number + song. Thereafter: song only.
8. **The phone form is bigger and more focused** — larger touch targets, a focused single-field layout, mobile-first. Apply the house UX baseline: loading/skeleton states matching the real layout, and an explicit empty state for "no songs requested yet".

## What exists today (recon, 2026-09-27)

Flow: `app/(patron)/[room]/page.tsx` (server) → `app/(patron)/[room]/PatronRoom.tsx` (client, 633 lines) → `components/SongSearch.tsx`.

Fields collected:
- **Nickname** — its own gate screen (`PatronRoom.tsx:318-355`), `maxLength=30`, saved by `saveNickname()` (L241-249).
- **Mode** (sing / listen-dance) — radio chips in `SongSearch.tsx:401-420`, state owned by PatronRoom (L51). **Not persisted.**
- **Song** — YouTube search, or a pasted URL/ID resolved locally with no API call (`parseYouTubeVideoId`, `SongSearch.tsx:5, 281`).
- **Title** — optional free text, `maxLength=120` (`PatronRoom.tsx:426-436`).
- **Table** — optional, `maxLength=10` (`PatronRoom.tsx:440-451`).

**Already persisted per device:** `cantai_patron_uuid` (minted if absent, L93-97), per-room nickname `cantai:<room>:nick` plus global `cantai_nickname` (L137, 245-246), **and the table is already written on every keystroke** to `cantai:<room>:table` via `updateTable` (L252-258). Plus `cantai_last_room` and the remembered-rooms list. Server-side there is an httpOnly `boraoke_identity` cookie refreshed via `POST /api/identity` (L109-126).

**So the storage half of item 7 largely exists; the gap is that the form still SHOWS the table field every time rather than treating a remembered value as settled.** Read the ask precisely, though: the TL says "table **+ number**", which reads as two identifying values, where the code has one `table` field (`maxLength=10`) and a separate `nickname`. Establish what the second value is before inventing a field — the most likely reading is table + the nickname/identity already collected at the gate, in which case this is a consolidation, not a new field. **If it is genuinely a new field it changes the queue-entry shape, and that is a blocker to surface, not to guess at** — see the constraint below.

## Constraints that bind this work

- **`lib/store/types.ts` is frozen — do not edit it.** `QueueEntry {id, videoId, title?, nickname, patronUuid, table?, mode, submittedAt, graceRequeue?}` (L13-34) and the `QueueStore` interface are explicitly closed. A genuinely new identifying field would require changing that shape plus the `/api/queue` validation, the moderation `PendingEntry` wrapper (`lib/pending-types.ts:34-44`), and the rotation-mode enforcement that already keys on `table` (`table-required`, `table-cap`, `app/api/queue/route.ts:194-210`). Do not start that; surface it.
- **`table` is load-bearing for rotation modes.** Venue modes enforce table-required and per-table caps server-side. Hiding the field must not let a blank table reach a room whose mode requires one — a remembered value satisfying it is fine, an absent one is a 4xx the patron cannot understand. Handle that path explicitly.
- Server validation stays authoritative (`app/api/queue/route.ts`): body ≤4096, nickname required ≤30, `patronUuid` must match `UUID_RE`, title ≤120, table ≤10, mode coerced to `"sing"` unless `"listen-dance"`.
- Device storage here is raw `window.localStorage` in `try/catch` with a `/* sandboxed */` comment; the only abstraction in the repo is `lib/room-memory.ts`'s injectable-storage pattern. **Reuse whatever TICKET-104 settles on** — do not add a third style.
- Keys stay under the legacy `cantai_` prefix; renaming drops live user state.
- Jest is node-env only (no jsdom): put logic in pure helpers, prove the UI with Playwright.

## Acceptance

- A first-time patron gives identifying info once; a returning patron on that device submits a song **without re-entering it**, and can still change it deliberately (a remembered value must be visible and editable somewhere, not silently locked in).
- A room whose rotation mode requires a table never receives a submission with a blank table, and the patron never sees a raw server error as the first symptom.
- The phone form has genuinely larger touch targets and a focused layout, proven by mobile-viewport screenshots.
- Loading/skeleton states match the real layout; "no songs requested yet" has an explicit empty state.
- `lib/store/types.ts` unchanged. Jest + e2e green.
