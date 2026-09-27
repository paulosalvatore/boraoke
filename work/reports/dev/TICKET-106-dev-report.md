# TICKET-106 — Dev report (spike)

**Status:** SPIKE COMPLETE. Findings + prototype delivered. No production code changed.
**Branch:** `ticket/106-search-quota` · **Worktree:** `.worktrees/t106-search-quota`
**Deliverable:** `work/reports/TICKET-106-spike.md` (the findings) + `work/spikes/ticket-106/` (the prototype the numbers came from).

## What was done, in the order the TM asked for

| Step | Outcome | Committed in |
|---|---|---|
| 1 — production numbers | **Reached.** Cap genuinely exhausted (`sb:2026-09-26 = 90`); cache hit rate **27%**; root cause is **one `search.list` call per keystroke** (12 calls for one song title). | first commit |
| 2 — extension question | **RESOLVED from primary source.** The extension form has a dedicated per-day `youtube.search.list` quota field. Not a placebo. | second commit |
| 3 — harvested-index prototype | **Built and measured.** 60 channels / 36,372 songs for **741 units** and **zero** `search.list`; hit@10 **66%** against 32 real production queries. | third commit |
| 4 — `youtubei.js` | Assessed. Works from residential; search needs no PoToken/player JS; **untested from Vercel**, which is the gating unknown. ToS clauses quoted. | third commit |
| 5 — Piped/Invidious re-probe | Bounded re-check. 1 working endpoint of 5 Invidious clearnet, 1 of 12 Piped. August verdict stands in substance. | third commit |
| 6 — comparison + recommendation | Delivered, with failure modes and the four TL decisions left unmade. | third commit |

## How production state was reached (and left)

Production `UPSTASH_REDIS_*` and `YOUTUBE_API_KEY` came from the linked Vercel project via `vercel env pull --environment=production` into the **session scratchpad, outside any repo**, and were shredded on exit (`handle-secret`). No secret value was printed, logged, or committed. Boraoke has **no entry in the Credential Vault** — the `vault` skill could not serve these keys, which is a gap worth closing and is noted under Friction.

Production was **read only**. The `search.list` bucket was not spent: the day's counter was read, never incremented, and `harvest.mjs` carries `assertNoSearchList()` which throws on any URL whose path contains "search". The 741 units consumed were `videos.list` / `channels.list` / `playlistItems.list` against the separate 10,000-unit pool — which is the whole point of the approach under test.

## Test validity (`prove-your-test-can-fail`)

This spike adds **no product regression test and changes no gate assertion**, so the formal (a)/(b) bar does not bind. The measurement harness is nonetheless controlled, because a hit-rate number that cannot fail is not a measurement:

- **(a) Mutations that kill the score**, run as `eval.mjs --controls`, verbatim output pasted in the spike report: **C1** empty index → 0%; **C2** ranking replaced by the first N rows → 0%; **C3** exact-substring matching only → 53%; **C4** diacritic folding removed → 22%, against a baseline of 63%. C1/C2 prove the `hit()` predicate is not vacuously true; C4 proves accent folding is load-bearing.
- **C3 is a finding, not a formality.** The naive substring baseline scores **8/13 on partial-word queries versus the fuzzy matcher's 7/13** — the matcher is *worse* than plain substring on that bucket. Reported in the spike rather than buried: most of the value is the index existing, not the scoring function.
- **`no primitive beneath existing assertions changed`** — this branch touches no existing code, so the hollowing-out hazard does not apply.
- **`triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path`.** `fuzzy.mjs` does normalise user input, but it is prototype-only, ships nothing, and is on no money/quantity/identity path.
- **`proof-by-absence` caught THREE real silent false negatives during this work** — every one of them found by a control, not by noticing:
  1. The credential scan over the committed files reported 0 matches for every secret pattern — *and 0 for its own positive control*, because zsh did not word-split the unquoted file list, so the scan had never run over the files at all. Rewritten with an array; the control then returned 4 and every pattern returned 0.
  2. During housekeeping, a fingerprint comparison meant to check whether the production API key had leaked into the scratchpad reported "no match" for all 9 candidate files — while the fingerprint itself was `e3b0c44298fc1c14`, the sha256 of the **empty string**, because `vercel env pull /dev/stdout` produced nothing. Every "no" was vacuous. Redone with a real fingerprint plus two controls (fingerprint ≠ empty-hash, and the matcher provably fires on a file that really holds the key); both passed, and the absence result is now valid.
  3. A secret-absence grep over the scratchpad used a positive control that had itself been shredded moments earlier, so it could not distinguish a working grep from a broken one. Replaced with a control string known to be present.

  In all three cases the failing output was **indistinguishable from the clean result** it was supposed to prove. The parallel research passes carried the same discipline (network positive controls, a `fetch`-tap that exits non-zero on zero calls, DNS controls separating NXDOMAIN from resolver failure).

## Gates

**No gate requested and none applicable.** This is a read-only spike: no product source file is touched, so there is nothing for the App Tester or Cyber Security to verify and no `verify-green-local.sh` verdict to gate on. The next ticket — implementing Tier 0 (stop searching per keystroke) — is the one that needs the full chain.

## Friction

- **Boraoke has no Credential Vault entry.** Reaching production required `vercel env pull`, which writes plaintext secrets to disk. `boraoke/upstash_rest_url`, `boraoke/upstash_rest_token` and `boraoke/youtube_api_key` belong in `vault/vault.age` so the next agent uses `vault.sh run` instead. **Framework-scope observation, filed as a note, not fixed here (D-046).**
- **The spend counter's 36h TTL means one day of history.** `sb:<day>` expires before anyone can look at a trend. Telemetry lists (`telemetry:events:<day>`) saved this spike — but only because `search_performed` happens to be emitted on exactly two code paths, letting the hit rate be *derived*. The `cached: true|false` flag TICKET-85 asked for is still unshipped and is two lines.
- **Session spans a UTC-date boundary while the budget counter is keyed to Pacific.** The one exhausted session lives in two telemetry day-lists and one counter key. Correct by design, but it makes every future measurement a reconstruction.

## Follow-ups this spike identified (not filed — TM's call)

1. **Tier 0: stop spending a `search.list` call per keystroke.** Highest value, hours of work, ~4× quota recovery. Needs a TL product call on search-as-you-type vs search-on-submit.
2. Ship `cached: true|false` on `search_performed` (and the selected `videoId` on `song_queued`) so hit rate and song-level repeat rate are measured, not derived.
3. Build the harvested index for real, with an inverted token index rather than the prototype's linear scan (91 ms at 36k rows, linear).
4. A deployed Vercel probe for `youtubei.js` before any fallback tier rests on it.
5. Quota-form corrections: §2 should describe TICKET-87's *shipped* bound, and the ask must be denominated in the `youtube.search.list` per-day box.
