# TICKET-20 — P0 bug fixes + full render/link test suite

Status: in_progress
Owner: Dev
Branch: `ticket/20-p0-ux-fixes`
Product: cantai (PUBLIC, live at https://cantai-snowy.vercel.app)

Direct Tech-Lead bug reports from using the live product. P0 UX correctness + a render/link
test suite the TL explicitly asked for (they distrust current coverage).

## Constraint

Another Dev owns `lib/store/**` (atomic RMW) in parallel. This ticket does NOT touch
`lib/store/**` internals (using the exported store API is fine). Room persistence lives in
`lib/rooms.ts`, which this ticket DOES own.

## Scope

### 1. Root-cause the room-404 + honest-failure UX
The TL created a room, then `https://cantai-snowy.vercel.app/bar-do-paulin-hjj2` → "Essa sala não existe".

- **ROOT-CAUSE (verify against the live API, don't assume):** production runs the MEMORY driver
  (Upstash unprovisioned). Room meta then lives only on the lambda that created it; any other
  lambda 404s. Verified — see the dev report for the live-API burst proof (13/20 → 200, 7/20 → 404).
- **THE fix is Upstash** (TL action — escalated separately; not in this ticket).
- **This ticket's fixes:**
  - (a) Make the failure honest — when the room store is on the memory driver in production, the
    room-created success screen (`/new`) and the room-404 page both state the truth
    (pt-BR temporary-room warning: "salas ainda são temporárias — podem expirar; recurso de salas
    permanentes chegando").
  - (b) When room meta is missing but the URL shape is valid, offer a one-click
    "recriar sala com este nome" path.

### 2. Landing "Já tem um código?" input does not reveal itself
Root cause: the join input uses `background: var(--surface)` — the SAME fill as its container card
— so it is camouflaged (looks like there is no field until you click exactly on it). Give it a
contrasting fill + clearer border; add a test.

### 3. "The main embed yt screen for customer isn't showing" — investigate BOTH interpretations
- (a) Patron room page has **no** video player **by design** — the video plays on `/[room]/tv`.
  Add a clear "assista na TV" player-hint linking to the TV view; record the design decision.
- (b) Verify `/[room]/tv` renders the YT iframe (seeded queue) AND a sane idle state; fix any real
  rendering bug.

### 4. Room slugs — drop the random suffix
Use the clean slugified name; append a suffix ONLY on collision (check existence first). Preserve
`isValidRoomId` + reserved-path safety: static routes (`new`/`api`/`tv`/`admin`, plus legacy
`default`) must remain impossible as minted slugs — the old always-on suffix was load-bearing for
that, so add an explicit reserved-id guard.

### 5. Admin → customer-screen navigation
On `/[room]/admin` add clear links to the patron page AND the TV view of the same room (new tab).

### 6. Render + link test suite
E2E specs asserting EVERY page renders its essential elements (landing, `/new`, `/[room]` join →
post-join song input + queue + player-hint, `/[room]/tv` iframe + idle, `/[room]/admin` login →
controls + mode switcher, legacy redirects) and a link-crawler asserting every internal href on
every page resolves non-404. Fast + deterministic (warm routes before seeding — memory-store
first-compile reset is the known pattern).

## Deliverables
- Fixes for items 1a/1b, 2, 3, 4, 5.
- New e2e render + link-crawler specs.
- Evidence screenshots in `work/evidence/ticket-20/`.
- Draft PR "TICKET-20: P0 UX fixes + full render/link test suite" (base main), CI green.
</content>
</invoke>
