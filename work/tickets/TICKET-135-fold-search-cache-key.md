---
ticket: TICKET-135
product: boraoke
status: filed
---

# TICKET-135 — Fold the search cache key the way the index folds queries

**Filed:** 2026-10-15, by the boraoke Tech Manager, from `work/plans/SCOPE-search-cache-pagination.md` section 3.
**Priority:** LOW-MEDIUM — under 1% saving on today's sparse traffic, more at scale.
**Type:** Search / cache
**Size:** S
**May ship with:** TICKET-136, in one PR.

## What

`cacheKey()` in `lib/youtube-search.ts` folds only case and whitespace. Accent, punctuation, NFC/NFD and "karaoke"-position variants of the same question each get their own key, so each one can spend a billed call. Real production pairs: `maná` / `mana`, `cerol na mão` / `cerol na mao`. Sing mode appends `karaoke` client-side, so `karaoke evidencias` and `evidencias karaoke` are different keys, and an accented `karaokê` gets a second `karaoke` appended. The index normaliser (`lib/search-prefix.ts`) already folds all of this. The cache key does not.

## Change

- Fold the query part of the key with the same normaliser the index uses: NFD then strip diacritics, punctuation to space, collapse whitespace, lowercase.
- Canonicalise a `karaoke` / `karaokê` token to one position (the end), and treat `karaokê` as `karaoke` in `lib/search-query.ts` so it is not appended twice.
- Google still receives the patron's original `q`. Only the key changes.
- Keep the uppercase `P:` page marker outside the folded part, so the collision argument in `cacheKey()` still holds.
- Single-flight (TICKET-126) keys its lock on the cache key, so it inherits the change with no extra work. Confirm with a test.

## Acceptance

- `maná` / `mana`, `Cerol na Mão` / `cerol na mao`, and `karaoke evidencias` / `evidencias karaoke` / `evidências karaokê` each map to one key.
- A test that fails on today's `cacheKey()` (mutation-proof).
- The graded accent queries in `work/measurements/ticket-108/queries.ts` keep their hit@10 in the 125 harness.
- Old keys simply age out within the cache TTL. No migration.

## Notes

- Patron-facing: no.
- Quality risk: the first variant's YouTube answer is served for the folded variant (`mana` vs `maná` can be different songs). Mitigated by the harness check.

## References

- `work/plans/SCOPE-search-cache-pagination.md` sections 1, 3, 4.
- `lib/youtube-search.ts` (`cacheKey`), `lib/search-prefix.ts` (`normalizeQuery`), `lib/search-query.ts`, `lib/search-single-flight.ts`.
