# Security Gate Report — TICKET-12: Telemetry Foundation

**PR:** #12 — `ticket/12-telemetry`
**Audited commit:** f152db8
**Auditor:** Cyber Security agent (D-011)
**Date:** 2026-07-06
**CI status:** green (build-and-test pass, Vercel deploy pass)
**App Tester waiver:** TM-waived (server-side only, no UI files, e2e in CI — concurred correct)

---

## Verdict: PASS-WITH-NOTES

No BLOCKERs. No HIGHs. Three MEDIUMs and two LOWs require follow-up tickets but do not block merge.

---

## Scope audited

- `app/api/t/route.ts` — public beacon ingest
- `lib/telemetry-types.ts` — enum, constants, `sanitizeProps`, key schema
- `lib/telemetry.ts` — `track()`, `createTracker()`, fail-open contract
- `lib/telemetry-store.ts` — MemoryTelemetryStore, UpstashTelemetryStore, driver selection
- `lib/telemetry-rollup.ts` — `computeRollup`, `renderRollupMarkdown`
- `scripts/telemetry-rollup.ts` — CLI rollup runner, demo-seed
- `.env.example` — secret inventory additions
- `work/telemetry/README.md` — privacy disclosure
- `work/telemetry/rollups/2026-W27.md` — committed sample rollup

Blast-radius: no existing auth or host-token surfaces touched. No changes to `lib/feedback-store.ts`, `lib/store*.ts`, `app/api/host/*`, or `app/api/feedback/*`.

---

## Collected-data inventory (exhaustive)

Every stored event has exactly these fields:

| Field | Type | Origin | Notes |
|---|---|---|---|
| `event` | enum (8 values) | server-validated | CLIENT_ALLOWED_EVENTS subset for beacon (2 of 8) |
| `roomId` | string ≤ 64 chars | client-supplied, length-capped | No character allowlist — see M2 |
| `sessionKey` | string ≤ 64 chars (optional) | client-supplied | No shape validation — see L2 |
| `uuid` | UUID-regex-validated string (optional) | client-supplied | UUID_RE enforced at route |
| `ts` | ISO-8601, server clock | server-filled | Client-supplied `ts` is ignored |
| `appVersion` | git SHA / "dev" | server-filled | Client-supplied `appVersion` is ignored |
| `props` | scalar bag ≤ 8 keys, strings ≤ 64 chars (optional) | client-supplied, sanitized | `sanitizeProps` drops objects/arrays/null; keys not character-filtered — see M2 |

**No IP addresses, no user agent, no names, no free text fields, no cookies, no client SDK, no consent-banner-triggering data.** The README disclosure at `work/telemetry/README.md` is accurate and exhaustive.

---

## Findings

### MEDIUM — M1: No rate limiting on public /api/t

**File:** `app/api/t/route.ts` (entire route)

Public, unauthenticated endpoint with no application-level rate limiting. The 2 048-byte body cap and event-type allowlist stop large and invalid payloads, but an attacker can fire unlimited valid requests. Effect: unbounded Redis list growth, rollup pollution, and Upstash storage/request-cost escalation. Combined with M3, a sustained flood could exhaust the free Upstash tier.

**Remediation:** Edge rate-limit via Next.js middleware or Vercel config (~60 req/IP/min with 429). Or a per-request HMAC derived from room context.

**PR comment:** https://github.com/paulosalvatore/cantai/pull/12#issuecomment-4893775498

---

### MEDIUM — M2: Stored markdown injection via unsanitised roomId and prop keys/values

**Files:**
- `lib/telemetry-rollup.ts` lines 233, 246–247, 255, 264–265 (`renderRollupMarkdown`)
- Root cause: `app/api/t/route.ts` line 83 (`roomId.trim().slice(0, MAX_ROOM_ID)`)
- `lib/telemetry-types.ts` line 91 (`key.slice(0, MAX_PROP_STRING)`)

`roomId` and prop keys/values are inserted verbatim into GFM table cells. Neither pipe characters (`|`) nor embedded newlines are stripped. An attacker posting `{"event":"patron_joined","roomId":"evil|\ninjected"}` to the public beacon stores that value in Redis; at rollup time it breaks the markdown table (pipe) or injects a new section header (newline). Prop keys allow the same via `|` in the key name.

Impact: No XSS (rollup is a committed repo file, not browser-rendered). Corrupts committed team-facing analytics artefacts and can inject fake markdown sections into git history.

**Remediation:** Add a character allowlist at the beacon route for `roomId` (e.g. `/^[\w-]{1,64}$/`) and/or escape user-controlled strings in `renderRollupMarkdown` before interpolating into table cells (`str.replace(/[|\n\r]/g, ' ')`). Input validation at the boundary is preferred.

**PR comment:** https://github.com/paulosalvatore/cantai/pull/12#issuecomment-4893778448

---

### MEDIUM — M3: No TTL or retention policy on Upstash telemetry keys

**File:** `lib/telemetry-store.ts` lines 130–136 (`UpstashTelemetryStore.append`); `lib/telemetry-types.ts` lines 116–118

All `telemetry:events:<YYYY-MM-DD>` lists and the `telemetry:days` registry set are created with no TTL and no per-day cap. Events accumulate indefinitely. `LRANGE … 0 -1` reads grow with list size. Under M1 flood conditions this accelerates storage exhaustion.

**Remediation:** Either (a) add a `--prune-after-rollup` flag to the CLI script that deletes processed day-keys after writing the rollup file, or (b) set a TTL at append time (e.g. 90 days: `redis.expire(key, 90 * 86400)`).

**PR comment:** https://github.com/paulosalvatore/cantai/pull/12#issuecomment-4893780955

---

### LOW — L1: MemoryTelemetryStore has no event-count cap

**File:** `lib/telemetry-store.ts` lines 79–112

No bucket size limit in the memory driver. In a long-running local dev server under a request flood, heap memory would grow without bound. Low real-world risk (Vercel Functions are ephemeral; local dev is short-lived).

**Remediation:** Add a per-bucket max (e.g. 10 000 events) with drop-oldest semantics. Non-urgent; track as a follow-up.

**PR comment:** https://github.com/paulosalvatore/cantai/pull/12#issuecomment-4893783808

---

### LOW — L2: sessionKey has no shape/character validation at the route boundary

**File:** `app/api/t/route.ts` lines 75–78

`sessionKey` is accepted as any non-empty trimmed string. The MAX_SESSION_KEY cap (64) is applied in `lib/telemetry.ts` line 79, not at the route. No UUID or slug format enforcement. Can store arbitrary short strings including special characters. sessionKey is not rendered in rollup table cells, so markdown injection impact is minimal. No PII risk beyond the roomId surface.

**Remediation:** Apply UUID_RE or `/^[\w-]{1,64}$/` to sessionKey at the route boundary; move the MAX_SESSION_KEY cap to the route for visibility.

**PR comment:** https://github.com/paulosalvatore/cantai/pull/12#issuecomment-4893783996

---

### INFO — I1: 2 moderate npm audit findings (pre-existing)

`postcss < 8.5.10` (GHSA-qx2v-qp2m-jg93) via `next`. Not introduced by this PR. Audit fix requires downgrading Next.js to 9.3.3 — a breaking change. Track in a separate upgrade ticket.

### INFO — I2: App Tester waiver confirmed correct

No UI files changed; `e2e/telemetry.spec.ts` runs in CI (green). Waiver is appropriate.

---

## Positive findings

- Event-type enum strictly enforced: `CLIENT_ALLOWED_EVENTS` is a read-only subset (2 of 8); server-observable events are rejected at the route with a 400 — no data poisoning path from the beacon.
- `ts` and `appVersion` are server-filled; client-supplied values ignored — confirmed by tests.
- UUID validated with `UUID_RE` at the route boundary; arbitrary identifiers rejected.
- `sanitizeProps` correctly drops nested objects, arrays, null, NaN, non-finite numbers, and enforces scalar types with hard string caps.
- `roomId` length-capped at 64 bytes via `MAX_ROOM_ID`.
- No secrets in committed files; `.env.example` correctly shows commented-out placeholders only.
- `import "server-only"` in both `lib/telemetry.ts` and `lib/telemetry-store.ts` — no accidental client bundle inclusion.
- Driver-selection pattern mirrors the established house pattern (TICKET-6); no new credential surface.
- No admin/export HTTP endpoint for telemetry data — no token-guard surface to audit.
- Rollup demo sample (`2026-W27.md`) uses deterministic synthetic roomIds ("bar-do-ze", "vila-sessions", "trial-venue"); contains no real user data.
- Fail-open contract verified in unit tests: store outage returns 202, not an error surfaced to patrons.
- Kill switch (`TELEMETRY_DISABLED=1`) documented and implemented.
- 43 unit tests, all pass (37 in telemetry suites + 6 in api-t suite).

---

## Unit test run

```
PASS __tests__/api-t.test.ts          (6 tests)
PASS __tests__/telemetry-rollup.test.ts
PASS __tests__/telemetry-store.test.ts
PASS __tests__/telemetry-track.test.ts

Tests: 43 passed, 4 test suites
```

---

## D-011 verdict

**PASS-WITH-NOTES**

M1 (rate limiting), M2 (markdown injection), M3 (no TTL) are MEDIUMs — they do not block merge but warrant follow-up tickets. L1 and L2 are LOWs. No BLOCKERs or HIGHs.
