---
ticket: TICKET-134
product: boraoke
status: filed
---

# TICKET-134 — Measure how often billed searches and queued songs repeat across days

**Filed:** 2026-10-15, by the boraoke Tech Manager, from `work/plans/SCOPE-search-cache-pagination.md` section 3.
**Priority:** MEDIUM — it decides how far 136 should stretch the cache and how much 137 is worth.
**Type:** Measurement / telemetry
**Size:** S

## What

We can't say how many billed live searches repeat a question, or a song, that was already answered for another patron or on another day. The 125 replay oracle is one day of keys the cache has already deduped by construction, and query text is deliberately kept out of telemetry. So the cross-day repeat rate, which is the number that sizes the cache work (135/136/137), is unknown.

## Change

- Add a salted/HMAC hash of the **folded** cache key (the same fold TICKET-135 introduces) to `search_performed` events with `source: live`.
- Add a salted/HMAC hash of the `videoId` to `song_queued`.
- A read-only report script (beside `scripts/telemetry-rollup.ts`) that prints: the daily cache / index / live split, the repeat rate of billed key hashes within 12 h, 7 d and 30 d windows, and the repeat rate of queued song hashes over the same windows.

## Acceptance

- The script prints those numbers from production telemetry.
- No raw query text and no raw `videoId` is stored. The salt lives in env, never in code.
- A test proves the key hash is stable across accent and case variants of one query (`maná` / `mana`, `Cerol na Mão` / `cerol na mao`).
- The hashes fall under the existing telemetry retention window.

## Notes

- Patron-facing: no. Budget risk: none. Privacy: hashes only.
- No longer gates TICKET-137 (TL, 2026-10-15). It still measures what 135/136/137 actually save.

## References

- `work/plans/SCOPE-search-cache-pagination.md` sections 3 and 4.
- `app/api/search/route.ts` (`search_performed` emits), `app/api/queue/route.ts` (`song_queued`).
