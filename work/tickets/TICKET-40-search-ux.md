# TICKET-40 — Patron search UX

Status: IN PROGRESS (Dev)
Product: boraoke (repo `paulosalvatore/boraoke`, live https://boraoke.com)
Branch: `ticket/40-search-ux` · Worktree: `.worktrees/ticket-40` · App port: 3040 (e2e)
Source: two direct Tech-Lead requests from live usage.

## Scope

### 1. Select → jump to add-to-queue
In the patron song-pick flow (`components/SongSearch.tsx` + the page form): after the patron selects a search result (or a pasted link resolves), immediately move the user to the submit action — scroll it into view AND focus the add-to-queue button.

- Respect keyboard/mobile: on phones the selection is below the fold — the submit button must land visible above the keyboard fold. Use `scrollIntoView({ block: 'nearest' | 'center' })` + `.focus({ preventScroll: true })` judgment.
- Do NOT auto-submit — just remove the hunt for the button.
- Must not fight the existing degraded / paste-link resolve path (both selection sources converge on the same "song chosen" moment).

### 2. Mode-aware search keyword
The entry mode toggle (sing vs listen/dance) already exists on the form. When mode = **SING**, the YouTube search should surface karaoke versions: append the keyword `karaoke` to the query. When mode = **listen/dance**, search the raw query unchanged.

- Decision (documented): **client-side query augmentation** before calling `/api/search`. Keeps the existing cache/rate-limit work unchanged (the cache key is the query string, which already reflects the augmented text), and avoids threading `mode` through the API + cache key. Server-side augmentation would require the cache key to include the mode/keyword or risk cross-mode cache poisoning — the client path is cleaner and honest.
- Edge cases:
  - User already typed "karaoke" (case-insensitive) → do NOT double it.
  - Mode switched AFTER results are shown → re-run the search with the newly-augmented query (cheapest honest behavior; results always match the active mode).
  - Pasted YouTube links are NEVER modified.

### 3. Tests
- Unit tests for the query-augmentation logic: sing appends, listen unchanged, already-contains-karaoke (case-insensitive) no-double, empty/whitespace query.
- E2E addition to the search spec: select result → submit button focused/visible; sing-mode query includes `karaoke` (assert at the API-call level via mock/degraded mode).
- Keep the full suite green (354+).

## Process
- Worktree per worktree-create skill (done). Commits via sanctioned commit script.
- CI-green mandatory (`verify-green-local.sh` if present; keep merged up).
- Dev report: `work/reports/dev/TICKET-40.md`. Evidence: `work/evidence/ticket-40/`.
- Local verify: build + unit suite + e2e (PORT=3040). Stop servers after.
- Draft PR "TICKET-40: search UX — select-to-submit jump + mode-aware karaoke keyword" via pr-deliver (`gh -R paulosalvatore/boraoke`).
