# TICKET-134 dev report

**Status:** implemented, self-verified, draft PR open. Ticket: `work/tickets/TICKET-134-measure-cross-day-search-repeats.md`. Branch `ticket/134-repeat-telemetry`, worktree `.worktrees/t134-repeat-telemetry`.

## What was built

- `lib/repeat-hash.ts`: HMAC-SHA256, keyed by env `TELEMETRY_HASH_SALT`, first 16 hex chars (64 bits). Collision odds at under 10^5 distinct values are around 10^-10, and it fits the 64-char prop limit. Kinds are domain-separated. No salt (unset or blank) returns undefined, the field is omitted and the event is unchanged. No fallback salt. Never throws. One sync HMAC over a short string, so no meaningful request cost.
- `search_performed{source:live}` gets `keyHash` = hash of `cacheKey(...)` (the TICKET-135 fold, `foldSearchKey`, no second fold). `song_queued` gets `videoHash` in `app/api/queue/route.ts` and in the host-approve route (the other `song_queued` emit).
- `lib/repeat-report.ts` (pure window math) and `scripts/telemetry-repeat-report.ts` (`npm run telemetry:repeats -- --days N`, read-only, same Upstash day-list read as `telemetry-rollup.ts`): daily cache/index/live split, repeat rate at 12 h / 7 d / 30 d for billed key hashes and queued song hashes. Events without a hash are counted but excluded from the denominator.
- `.env.example` documents `TELEMETRY_HASH_SALT`.

## Retention

Hashes live in event `props`, so they share the raw-event TTL: `TELEMETRY_RETENTION_DAYS = 90` at `lib/telemetry-types.ts:94`, applied with `expire` at the day key's first write in `lib/telemetry-store.ts:161-164`. 90 d covers the 30 d window.

## Mutation proof (`__tests__/repeat-hash.test.ts`, `__tests__/repeat-report.test.ts`)

- Route hashes raw `q` instead of `ck`: 1 test fails (live route emits the folded-key hash).
- `cacheKey` fold call replaced by trim+lowercase: 4 fail (`maná`/`mana`, `Cerol na Mão`/`cerol na mao`, karaoke variants, route).
- Salt-missing branch replaced by a constant fallback salt: 3 fail.
- Report window boundary `<=` to `<`: 1 fails.
- Hollowing-out: no primitive beneath existing assertions changed.
- Triggered mutation pass: not triggered, no new parsing/normalisation function on a money/quantity/identity path (the fold is TICKET-135's, unchanged).
- Reverse-check against pre-fix code: the new files test new fields that the pre-change routes do not emit, so they fail there by construction (route tests assert `keyHash`/`videoHash`).

## Self-verification

- Targeted: `npx jest __tests__/repeat-hash.test.ts __tests__/repeat-report.test.ts` 18 passed.
- Full CI steps run locally: rotation-engine `node --test` 59 pass; `npm test` 81 suites, 1598 passed, 89 skipped; `npm run build` OK including es-target (52 chunks ES2019) and css-target OK.
- Not run: Playwright e2e and the old-Chromium TV gate (no patron/TV UI import touched; server routes and a script only). CI runs them.

## Deploy note

Telemetry is inert until the TM sets `TELEMETRY_HASH_SALT` in the deployment env. Do not rotate it afterwards (a new salt starts a non-comparable series).
