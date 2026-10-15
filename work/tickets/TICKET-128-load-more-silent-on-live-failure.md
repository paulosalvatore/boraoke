# TICKET-128 — "Load more" past an index answer is silent when live search fails

**Filed:** 2026-10-15, from the App Tester pass on PR #88 (TICKET-124), finding 1.
**Priority:** LOW — no data loss and the rows already shown stay, but the patron gets no feedback and a button that does nothing.
**Type:** UX / bug
**Size:** XS

## What

Since TICKET-124 every index answer ends in `nextPageToken: "IDXLIVE"`, so the second "Ver mais resultados" tap escapes to a LIVE first page (`page=2&pageToken=IDXLIVE`). When that live call comes back degraded for any reason other than `daily-limit` (`quota`, `error`, `no-api-key`), the existing load-more branch in `components/SongSearch.tsx` swallows it: no message is shown, and the "Ver mais resultados" button stays, so the patron can keep tapping a control that cannot work.

The `daily-limit` branch already does the right thing: it shows the unavailable state and retires the button.

The behaviour is pre-existing, but TICKET-124 made it far more reachable, because every index answer now ends in an IDXLIVE tap.

## Acceptance

- A degraded page-2 response of any reason (`daily-limit`, `quota`, `error`, `no-api-key`) shows the search-unavailable state and hides the "load more" button, exactly as the `daily-limit` case does today.
- The rows already shown stay put.
- Any copy change exists in all three catalogs (`messages/{pt-BR,en,es}.json`).
- A test covers a non-`daily-limit` degraded page-2 response and fails on the current code.

## References

- App Tester report: `work/reports/testing/TICKET-124-app-test.md`, "Defects / notes" item 1.
- Evidence: `work/evidence/TICKET-124/apptest/*-13-loadmore-tap2.png`.
- Code: `components/SongSearch.tsx` (load-more branch), `app/api/search/route.ts` (IDXLIVE escape).
