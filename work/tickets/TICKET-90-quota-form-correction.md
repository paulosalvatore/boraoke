# TICKET-90 — Correct `work/youtube-quota-form.md` before it is filed

**Filed:** 2026-08-19, interactive TM session (TL present)
**Priority:** MED
**Size:** S
**Type:** Documentation correctness — blocking a real submission

## Why this exists

`work/youtube-quota-form.md` is drafted, paste-ready answer text for a real Google compliance
audit submission (the YouTube Data API quota-increase request). It is currently **wrong in two
places**, both verified against the file and against the code this session, and both matter
because this is a document that will be submitted to a third party, not an internal note.

### 1. False "60-second search cache" claim

Line 22 of the form states:

> no API response caching beyond a 60-second search cache

This was true when the form was drafted (2026-08-05). It has been false since **TICKET-55 (PR
#39, merged 2026-08-05)** shipped a cross-instance search cache with a **12-hour TTL** for
non-empty results (10-minute TTL for empty results) — `lib/search-cache.ts` / the `sc:` cache
prefix, not a 60-second window.

**This is legal on its own terms** — a 30-day retention window is within the API's Terms of
Service, and 12 hours is well inside that. The problem is narrower and sharper: **this is a
compliance-audit submission, and the claim in it is factually false.** Submitting an inaccurate
answer to a compliance question is the kind of thing that undermines the credibility of the whole
form, independent of whether the true answer would itself have been acceptable.

### 2. Mis-denominated quota request

Line 17 requests:

> 1,000,000 units/day

TICKET-85's spike (PR #58, merged) established the quota model changed on **2026-06-01**:
`search.list` is now capped at a hard **100 calls/day**, in its own bucket, separate from
`videos.list`/`playlistItems.list`/`playlists.list`/`channels.list`, which sit in a **separate
10,000-unit/day pool that boraoke barely touches**. The two are decoupled.

Requesting "more units/day" asks for more of the resource that is **already in surplus**. The
resource that is actually scarce and actually constrains the product — the daily count of
`search.list` **calls** — isn't denominated in "units" at all under the new model, so a
units-based request may not even map onto anything Google's current review process evaluates.

## What's needed

- Rewrite the "no API response caching" compliance answer to state the true, current caching
  behavior (12h/10min TTL, cross-instance, fail-open) rather than the stale 60-second figure.
- Re-derive the quota-calculation section in terms of `search.list` **calls**, not units, sized
  against the real 100-calls/day cap and boraoke's actual/projected venue-night call volume
  (informed by TICKET-55's cache hit rate and TICKET-83's ~2-call-per-search-then-0-for-repeats
  reduction, both already shipped).
- Flag explicitly, inside the form or as a submission note, the **unresolved open question from
  TICKET-85**: it is not confirmed whether an approved extension raises the `search.list` **call**
  cap at all post-June, or only ever raised the old unit pool — Google's public audit
  documentation still describes the pre-June world. If the call cap turns out to be fixed
  regardless of approval, filing this form may be a placebo, and that should be understood before
  spending the submission on it, not discovered after.

## Acceptance criteria

- Both false/stale claims corrected in place, verified against the actual shipped code
  (`lib/search-cache.ts` TTLs, `MAX_SEARCH_PAGES` / call-count-per-search from TICKET-83) rather
  than restated from memory.
- The quota-calculation section denominates its request in `search.list` calls/day, not units,
  and the unresolved call-cap-vs-unit-cap question is recorded rather than silently assumed
  either way.
- Not filed with Google until this ticket is closed.
