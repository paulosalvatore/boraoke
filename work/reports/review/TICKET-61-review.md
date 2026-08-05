# TICKET-61 — Independent Reviewer gate

**Reviewer:** independent gate agent, clean context (did not build this branch).
**Branch:** `ticket/61-paste-embeddability-warning` @ `c28a490` · worktree `.worktrees/ticket-61` · tree clean.
**Method:** every load-bearing claim re-derived from the code and from tests I ran myself. The dev report and the two gate reports were read but treated as unverified.

**Verdict: APPROVE-WITH-FOLLOWUPS**

## 1. Observed test + build output (re-run by me, not quoted from the dev report)

`npm test` in the worktree:

```
Test Suites: 43 passed, 43 total
Tests:       637 passed, 637 total
Snapshots:   0 total
Time:        6.321 s
Ran all test suites.
```

Matches the dev report's 43/637. The only noise is a pre-existing `console.warn` from `app/api/queue/advance/route.ts:47` (`[advance-auth] would-block ... mode=log`) emitted by `queue-advance-song-played-props.test.ts` — unrelated to this branch.

`npm run build`:

```
   ▲ Next.js 15.5.20
   Creating an optimized production build ...
 ✓ Compiled successfully in 1390ms
   Linting and checking validity of types ...
   Collecting page data ...
   Generating static pages (0/31) ... (31/31)
...
├ ƒ /api/queue                             176 B         103 kB
+ First Load JS shared by all             102 kB
```

Exit code 0, 31 routes emitted, lint + type check pass. The only warning is the pre-existing multi-lockfile "inferred workspace root" notice (a worktree artifact, present regardless of this branch).

## 2. Fail-open — proven by reading the code path, not the test names

Traced `checkEmbeddable` (`lib/youtube.ts:120-153`) exhaustively:

| Failure mode | Line | Result |
|---|---|---|
| No API key | 125 | `"unknown"`, no outbound call |
| Invalid/unsanitised id | 126 | `"unknown"`, no outbound call (re-validated before it can reach a URL) |
| `URL`/`URLSearchParams` construction throw | 132-135, inside `try` | caught → `"unknown"` |
| `AbortSignal.timeout` unavailable / throws | 138, inside `try` | caught → `"unknown"` |
| fetch rejects (network, DNS, abort/timeout) | 137, inside `try` | caught → `"unknown"` |
| Non-2xx (403 quota, 400, 5xx) | 141 | `"unknown"` |
| `res.json()` rejects (malformed body) | 143, inside `try` | caught → `"unknown"` |
| `items` empty / `status` absent / non-boolean | 146-147 | `"unknown"` |

There is no `throw`, no unawaited promise, and no code path outside the `try` that can reject. The function's only awaits are both inside the `try`. It cannot produce an unhandled rejection or a thrown promise.

Call site (`app/api/queue/route.ts:232-246`): the whole advisory block is additionally wrapped in `try/catch`, which matters because `getTranslations` — a real dependency call — now runs on the **success** path before `store.addEntry`. Without that wrapper an i18n failure would have converted an accepted submit into a 500 and silently dropped the song. The builder claims this was a cyber-gate fix; I confirmed the guard is actually present and that the `catch` sets `warning = undefined` rather than rethrowing.

Between the check and `store.addEntry` there is exactly one new await path: `getRoomModeration(roomId)` (line 255) and the moderation branch, all pre-existing and unchanged in failure semantics. `warning` is a local `string | undefined` that is only ever spread into a response body; it can neither gate nor mutate `entry`, `addEntry`, or `relayQueue`.

**202 moderation branch:** `warning` is computed before the moderation block, so a moderated room's 202 carries it (line 289). The pending-full 429 correctly does *not* carry it. Verified by reading; see finding F1 — this branch is not covered by a test.

**Placement:** the check sits after the body-size cap, JSON parse, room/videoId/nickname/uuid validation, the dual-bucket submit rate limit, and `checkSubmit`. A rejected, malformed or throttled submit therefore spends zero quota. Confirmed by line order (limit at 154, `checkSubmit` at 198, check at 233).

**Conclusion:** no input and no upstream failure can produce a 5xx, an unhandled rejection, or a blocked/dropped submit. Fail-open holds.

## 3. Search path really does skip the check

Server derivation (`route.ts:122-123`):

```ts
const submittedAsUrl = !(typeof rawVideoId === "string" && rawVideoId);
const isPaste = submittedAsUrl || source === "paste";
```

`checkEmbeddable` is called only under `if (isPaste)`. So `source: "search"`, `source` absent (legacy cached clients), and any unrecognised `source` all skip it — the quota-conservative default, and byte-identical behavior to today for old clients. Three route tests assert zero outbound calls for exactly those three shapes.

Client derivation — I read `PatronRoom.tsx` and `components/SongSearch.tsx` read-only and judged it **sound, and sound in the safe direction**:

- `SongSearch` emits a selection from exactly two places. The paste path (`SongSearch.tsx:132`) calls `onSelect({ videoId: pastedId })` with no `title` → `paste`. `handlePick` (`:158-161`) sets `title: r.title && r.title !== t("youtubeLink") ? r.title : undefined` — so picking the *synthetic row that a paste creates* also yields `title === undefined` → `paste`. A real search result always carries a non-empty title → `search`.
- Therefore a paste can never be mislabelled as `search`, i.e. **no warning is ever silently lost** by this derivation. The only imprecision is the reverse: a real search result with a falsy title, or one whose title happens to equal the localized "YouTube link" string, is labelled `paste`. Cost is one quota unit, and the check comes back `embeddable` anyway because `/api/search` is filtered `videoEmbeddable=true`. The ticket documents this accurately.
- `PatronRoom.tsx:199` is the only `setParsedVideoId` outside the post-submit reset at `:304`, and it is the same callback that sets `selectionSource`, so the two states cannot diverge. The post-submit reset leaves `selectionSource` stale, but `parsedVideoId` is nulled and the submit button is `disabled={!parsedVideoId}`, so no submit can occur before the next selection re-sets both.

Plainly: it is sound. The residual fragility is that it depends on a *localized string comparison* inside `SongSearch.handlePick` — if that copy is reworded, a picked paste row would start carrying a title and be labelled `search`, silently losing the warning. That is a real (if low-probability) coupling; see F3.

## 4. Response contract (TICKET-54 trim) — verified on both paths

- **201:** `{ ok: true, ...(warning ? { warning } : {}) }`. `warning` originates solely from `tw("submitNotEmbeddable")` — a next-intl lookup, i.e. a plain `string`. No `QueueEntry`, no `patronUuid`, no `videoId`, no API payload fragment is interpolated into it; the YouTube JSON is read only for a boolean and then discarded.
- **202:** `{ pending: true, pendingId, ...(warning ? { warning } : {}) }` — same string, same absence of entry metadata. The TICKET-54 trim is preserved on both.
- The key is omitted entirely (not `warning: undefined`) when absent, so the embeddable/skip case serialises to exactly the old body. `AC2` and the AC3 cases assert `toEqual({ ok: true })`, which would fail on any extra key — a genuine lock on the unchanged shape.
- `AC1b` asserts `Object.keys(json).sort() === ["ok","warning"]` plus explicit absence of `patronUuid`/`entry`/`videoId`. Non-vacuous.
- Client side, `PatronRoom` reads the body with `res.json().catch(() => null)` and type-guards `typeof w === "string"`, so a malformed success body cannot turn a successful submit into an error.

## 5. Locales

`messages/` contains exactly three files, all three carry the key at line 215:

- `pt-BR.json`: `"esse vídeo não permite reprodução em telões — pode não tocar"` — **byte-identical to the ticket's required string**, including the em dash and the accents.
- `en.json`: "this video doesn't allow playback on external screens — it may not play"
- `es.json`: "este video no permite la reproducción en pantallas — puede que no suene"

`__tests__/i18n-completeness.test.ts` and `i18n-locales.test.ts` both pass, so no locale is missing the key.

## 6. Design conformance

`work/plans/TICKET-41-plan.md` §5 specifies, verbatim: *"server-side `status.embeddable` check in `/api/queue` POST returning a non-blocking `warning` field, patron form rendering 'esse vídeo não permite reprodução em telões — pode não tocar'."* That is exactly what this branch implements — same endpoint, same `videos.list` `status` part, same non-blocking `warning` field, same copy. Not a different invented design. The deferral reason (file-ownership collision with TICKET-40 over `SongSearch.tsx`) is respected: that file is untouched, which is precisely why the shape-derived `source` exists.

## 7. Test quality

- **They mock the YouTube API, not the module under test.** `__tests__/api-queue.test.ts` replaces `global.fetch` — the *network boundary* — so the real `checkEmbeddable` executes end to end through the real route handler. `__tests__/youtube.test.ts` injects `fetchImpl`, again standing in for the API, not for the function being tested. There is no `jest.mock("@/lib/youtube")` anywhere in the new tests. This is the right seam.
- **All four acceptance cases covered:** AC1 (+AC1b shape), AC2, AC3 (four route-level modes: 403 quota, 5xx, thrown timeout, no key — plus seven unit-level modes), AC4 (three variants, each asserting `fetchMock` was *not* called).
- **Non-vacuous:** the fail-open tests assert `toEqual({ ok: true })` (exact body) *and* in the network-error case that the entry actually landed in the store — so they would fail if the warning leaked or the submit were dropped. The quota test parses the outbound URL and asserts `path=/youtube/v3/videos`, `part=status`, `id`, and `toHaveBeenCalledTimes(1)`. The `freshBody` helper rotates uuid and videoId per test, which is necessary given the per-uuid rate limit and `checkSubmit`'s duplicate rule — without it later tests would silently 409/429 and the assertions would be meaningless. It is done correctly.
- **One weak test:** "does not spend quota on a rejected submit (rate-limited / refused never reach the check)" only exercises a 400 from an invalid `videoId`, which short-circuits before the derivation even runs. It does not test the rate-limit or `checkSubmit` refusal paths its own name claims. Not wrong, just weaker evidence than it advertises.

## Findings

**F1 (LOW, test coverage) — the 202 moderation path's `warning` is unverified.** The code is correct by reading (`route.ts:289`), but no test submits a non-embeddable paste into a moderated room. AC1's "existing 201/202 success response" is only locked on the 201 half. A future refactor of the moderation branch could drop the spread with a green suite. Follow-up: one test asserting the 202 body is `{pending, pendingId, warning}`.

**F2 (LOW, latency) — the paste path gains up to 1500ms of serial latency before `store.addEntry`.** Non-blocking in the correctness sense (the submit still succeeds), but under a slow/degraded Data API a paste submit now feels up to 1.5s slower than today. The ticket documents the quota cost but not this. The already-noted cache follow-up (Upstash, TICKET-55's cache being the natural home) would largely remove it; worth naming latency, not just quota, as the reason.

**F3 (LOW, fragility) — the client `source` derivation depends on a localized copy string.** `SongSearch.handlePick` distinguishes the synthetic paste row from a real result by comparing `r.title !== t("youtubeLink")`. Reword that catalog entry and picked paste rows start carrying a title, get labelled `search`, and silently lose the warning — with no test failing. The ticket already files the correct fix (explicit `source` on `SongSelection` once that file is free); this finding just records that the failure mode is silent, so the follow-up should not be dropped.

**F4 (INFO) — self-declared `source: "paste"` lets any caller force one quota unit per accepted submit.** Bounded by the pre-existing dual-bucket limit (10/min/uuid, 60/min/IP) and dominated by `/api/search` at 100 units under a 30-req/10s/IP limit, as the cyber gate observed. Accepting as-is; the recommended combined follow-up ticket (cache + shared limiter) is the right home.

None of F1–F4 blocks the merge: none is a correctness defect on the shipped path, and each has a bounded, already-identified follow-up.

## Acceptance criteria — verdict per criterion

| AC | Status | Basis |
|---|---|---|
| Non-embeddable paste → unchanged 201/202 shape + `warning`, submit succeeds | PASS (202 half untested — F1) | code read + AC1/AC1b observed passing |
| Embeddable paste → no warning | PASS | AC2 asserts exact `{ok:true}` |
| API error / timeout / quota → fail-open, no 5xx | PASS | full path trace §2 + 4 route cases + 7 unit cases |
| Search-selected ids skip the check | PASS | `if (isPaste)` guard + 3 zero-call tests; client derivation sound §3 |
| Quota cost documented | PASS | ticket §"Quota cost"; 1 unit/checked paste, 0 elsewhere — matches `part=status` single `videos.list` |
| Unit tests mock the YouTube API, cover four cases | PASS | mocked at `global.fetch`/`fetchImpl`, real module under test |
| Response contract (TICKET-54) preserved | PASS | both 201 and 202 verified §4 |
| Locale copy exact | PASS | pt-BR byte-identical §5 |

**Verdict: APPROVE-WITH-FOLLOWUPS** — merge as-is; file F1 (202 test), F2/F4 (cache + limiter, one combined ticket as the ticket already proposes), and F3 (explicit `source` on `SongSelection` once `components/SongSearch.tsx` is free).
