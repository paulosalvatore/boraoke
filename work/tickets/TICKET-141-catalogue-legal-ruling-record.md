---
ticket: TICKET-141
product: boraoke
status: filed
---

# TICKET-141 — Song catalogue: legal ruling record (YouTube policy, KaraFun, MusicBrainz, Vercel)

**Filed:** 2026-10-15, by the boraoke Tech Manager, from `work/plans/EPIC-song-catalogue-plan.md` (section (e) and its "Independent verification (2026-10-15)" table). TL decisions 2026-10-15 (Global TM, prompt 022): epic approved, file 141-149 in the plan order after #90 and TICKET-140; patron-facing parts need a TL OK (via the Global TM) before merge.
**Priority:** MEDIUM
**Type:** Decision record (docs only)
**Size:** XS
**Patron-facing:** no. **Non-blocking:** this is a short record of rulings already made, not a memo awaiting a decision. 142-149 do not wait on it.

## TL rulings (2026-10-15, recorded verbatim where quoted)

1. **YouTube policy.** TL, verbatim: "We can proceed carefully, but at the same time, we dont need to present song name as YouTube's, because we can have the song data, but when user is searching, if we just present the video embed, I think thats fine and youtube wont bother".
   Ruling: **proceed.** Our own song data (CC0 sources + patron picks + KaraFun titles/artists) is ours and is shown as our song name and artist. The YouTube side is the video embed or link, refreshed within 30 days. We **never present our metadata as YouTube's** (no YouTube-derived title/description shown as if it were our song record, and no claim that our song fields come from YouTube).
2. **KaraFun.** TL, verbatim: "I have their authorization, go ahead and use it". The TL holds KaraFun's authorization. **The house has NOT seen the document.** Keep any attribution the CSV or the KaraFun site asks for (see 145).
3. **Vercel.** Stay on Hobby for now. TICKET-150 tracks the switch to Pro when boraoke becomes a paid product.
4. **Room retention.** Unanswered by the TL. Rooms stay as they are; no retention ticket.

## Clauses considered (YouTube Developer Policies, last updated 2026-09-14, verified 2026-10-15)

- **III.E.4.d / III.E.4.e:** non-authorized API Data may be stored only temporarily, at most 30 calendar days, then refreshed or deleted, with reasonable efforts to keep it consistent with current data.
- **III.E.4.h:** must not "replace API Data with similar, independently calculated data" or use API Data "to create new or derived data or metrics".
- **III.E.1.a:** no storing copies of audiovisual content (we store none; thumbnails are built from the ID at read time).
- **III.E.2 (aggregation, newly cited by the verifier):** "Do not aggregate API Data except that you may only aggregate API Data relating to YouTube channels…" owned by the same content owner. Whether it applies to a cross-channel index is a legal reading nobody here can settle.
- **III.C.5 (search results, newly cited):** "must not modify or replace the text, images, information, or other content of, the search results". This is the clause the TL's ruling is shaped around: we show the video embed and our own song data, not a rewritten YouTube record.
- **No video-ID exemption.** "Video IDs may be stored indefinitely" is not in the current text. A videoId obtained from the API is treated as API Data (30 days).
- API Services ToS section 15: no circumventing quota. Do not create extra GCP projects to multiply the pool.
- oEmbed: not mentioned in either policy page and no primary rate-limit page found (UNVERIFIABLE). Not a bulk path.

## House mitigations (what the epic does about the above)

- **Dated, 2026-11-01:** delete every local copy of the TICKET-143 labelled sample, holdout and non-karaoke sample (YouTube titles; local-only, gitignored — never on main). Accepted leftover: the sample remains in PR #93's own GitHub history (it was committed on the PR branch before the review caught it; main is squash-merged so it never reaches main).
- **Songs = our data, permanent; links = YouTube data, refreshed within 30 days** (the 144 schema). Link shards carry a TTL of at most 30 days and the existing `INDEX_MAX_AGE_MS` hard stop.
- A parsed song/artist taken from a YouTube title becomes permanent only when a non-YouTube source (MusicBrainz, Wikidata, KaraFun) or a patron's own typing corroborates it. Otherwise it expires with its link.
- Song/artist is shown as our fields; the YouTube side shown to patrons is the embed or link only.
- Thumbnails are never stored.
- Harvesting stays on the official API inside the 10k pool, with `assertNoSearchList()` on every harvest URL. `search.list` is on-demand fallback only.
- The `ki:stamps` hash (channel IDs and timestamps, no TTL) rests on the same unverified "IDs are fine" premise. Low risk; flagged here, left as is.
- Mention III.E.4.h and III.E.2 in the compliance description of `work/youtube-quota-form.md`.

## Closed by the verifier (no longer open)

- MusicBrainz **URL relationships are core data, CC0** (https://musicbrainz.org/doc/MusicBrainz_Database lists "Relationships & URLs" under core). The plan's "UNVERIFIED" is retired.
- Vercel Hobby has 100 cron jobs per project, once per day (https://vercel.com/docs/cron-jobs/usage-and-pricing).

## Still open (UNVERIFIABLE, tracked, not blocking)

oEmbed coverage and rate limits; ListenBrainz CC0 wording (only secondary sources); Discogs dump licence (primary 403); whether re-validating a non-API videoId with `videos.list` makes it API Data.

## Acceptance

- This ticket is merged as a docs-only note (or folded into the plan file) with the rulings above, so later tickets cite it. Nothing else.

## References

- `work/plans/EPIC-song-catalogue-plan.md` (b), UNVERIFIED register, verification table rows 7, 8, 12, 20, 30-32.
- https://developers.google.com/youtube/terms/developer-policies, https://developers.google.com/youtube/terms/api-services-terms-of-service
