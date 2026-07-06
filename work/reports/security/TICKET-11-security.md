# Security Report — TICKET-11: In-App Feedback Widget

**Agent:** Cyber Security
**Date:** 2026-07-05
**PR:** #11 — `ticket/11-feedback-widget`
**Verdict:** PASS-WITH-NOTES

---

## Scope Audited

| Surface | File |
|---|---|
| Domain types + constants | `lib/feedback-types.ts` |
| Memory + Upstash store drivers | `lib/feedback-store.ts` |
| Public POST / Admin GET + PATCH | `app/api/feedback/route.ts` |
| Client widget | `components/FeedbackWidget.tsx`, `components/feedback/FeedbackSheet.tsx`, `components/feedback/useFeedbackContext.ts` |
| Environment spec | `.env.example` |
| Unit tests | `__tests__/api-feedback.test.ts`, `__tests__/feedback-store.test.ts` |

Blast-radius check: diff verified locally against `git merge-base origin/main origin/ticket/11-feedback-widget`. No changes to auth, session, queue, or unrelated data flows detected.

---

## CI & Tests

- CI: Vercel deployment **pass** (all required checks green — `gh pr checks 11`)
- Unit suite: **105/105 pass** (`npx jest --no-coverage`)
- Feedback-specific suites: **27/27 pass** across `api-feedback` and `feedback-store`

---

## Findings

### MEDIUM — M1: Admin token comparison is not timing-safe

**File:** `app/api/feedback/route.ts:75`

```ts
return !!provided && provided === expected;
```

JavaScript's `===` on strings short-circuits on the first mismatched byte. A persistent attacker who can make thousands of requests and subtract network jitter could theoretically infer the token byte-by-byte. In a serverless/edge environment, round-trip jitter largely drowns the signal — this is difficult but not impossible to exploit at scale.

**Remediation:** Replace with a constant-time comparison:
```ts
const eq = (a: string, b: string) => {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.byteLength === bb.byteLength && crypto.timingSafeEqual(ab, bb);
};
return !!provided && eq(provided, expected);
```
Use `Buffer` of equal length; `timingSafeEqual` throws if lengths differ, so the length check must guard it.

---

### LOW — L1: UUID rotation bypasses the rate limiter (no IP dimension)

**File:** `app/api/feedback/route.ts:139`, `lib/feedback-types.ts:91-92`

The 5/uuid/hour limit is keyed on the client-supplied UUID from localStorage. An automated sender can rotate UUIDs (or generate fresh ones) to submit unlimited entries. There is no IP-dimension to the rate limit.

This is the same bypass class identified in TICKET-8. It is an accepted design trade-off for the zero-friction, no-login widget. The rate limit protects against accidental spam from a normal device, not a determined adversary.

**Remediation (if threat model changes):** Add an IP-keyed secondary counter, or enforce the rate limit also on `x-forwarded-for` alongside uuid. Accept as-is for the prototype phase with a note in the ticket.

---

### LOW — L2: Stored text is verbatim — stored-XSS risk at future consumers

**File:** `app/api/feedback/route.ts:124`, `lib/feedback-store.ts`

The free-text `comment` field is stored verbatim after length capping (`slice(0, 1000)`). The current admin `GET /api/feedback` endpoint returns JSON — safe. However, any future consumer (e.g., mission-control dashboard) that renders `record.text` as HTML without sanitization is vulnerable to stored XSS.

**Remediation:** No action required now (the output is JSON-only). When mission-control or any HTML rendering consumer is built, sanitize the text field before rendering (e.g., `DOMPurify.sanitize()` client-side, or strip tags server-side). File a follow-up ticket before the intake dashboard is built.

---

### INFO — I1: Memory driver rate Map grows unboundedly

**File:** `lib/feedback-store.ts:140-148`

`MemoryFeedbackStore.rate` adds one `Map` entry per unique UUID and never prunes entries whose `resetAt` has passed (a UUID that fires once and is never seen again leaves a stale entry forever). Under sustained attack with distinct UUIDs, this could exhaust server memory on the memory driver.

This is a development/CI driver only — the store is clearly documented as non-durable and non-production. The Upstash driver is not affected (TTL-based expiry at line 219). No remediation required for current use. Note: pruning stale entries is a one-liner in `hitRateLimit` (check `now >= bucket.resetAt` before setting a new bucket instead of overwriting).

---

### INFO — I2: `feedback:index` Redis list has no size cap or TTL (Upstash driver)

**File:** `lib/feedback-store.ts:178`

`rpush(feedbackKeys.index, record.id)` appends to the index list indefinitely. Rate-limit keys have TTL (line 219), but the index and item keys do not. Over months at scale this list could become large. No immediate security risk — purely an operational concern.

---

### INFO — I3: `NEXT_PUBLIC_GIT_SHA` stored in feedback records

**File:** `app/api/feedback/route.ts:63`

The `appVersion()` fallback reads `NEXT_PUBLIC_GIT_SHA`. This variable, when set, is inlined into the client bundle by Next.js. A git SHA is not sensitive (it is public on a public repo and already visible in browser assets). Storing it in feedback records is useful for correlating reports to deployments. No security concern; noted for completeness.

---

### INFO — I4: Moderate npm vulns (pre-existing, not introduced by this PR)

`npm audit` reports 2 moderate vulnerabilities in `postcss < 8.5.10` via the `next` dependency. These are pre-existing from TICKET-1 and not introduced by this PR. The fix requires a Next.js major downgrade and is not applicable. Track separately.

---

## Checklist Results

| Check | Result |
|---|---|
| `FEEDBACK_ADMIN_TOKEN` server-only (never in client bundle) | PASS — no `NEXT_PUBLIC_` prefix; grep of `.next/static/` finds no match |
| Store has `import "server-only"` | PASS — `lib/feedback-store.ts:22` |
| Route server-only imports (store/route only) | PASS |
| Fail-closed when token unset | PASS — `route.ts:71`: `if (!expected) return false` |
| Token never logged | PASS — no `console.*` in route or store |
| Token not in `.env.example` as real value | PASS — commented placeholder only |
| Token not in client bundle | PASS — confirmed via `.next/static/` grep |
| Free-text comment capped | PASS — `MAX_TEXT = 1000`, `str()` slices, textarea `maxLength=1000` |
| Category enum validation strict | PASS — `CATEGORIES.includes()` check with 400 on mismatch |
| Sentiment enum validation strict | PASS — `SENTIMENTS.includes()` check with 400 on mismatch |
| UUID format validated | PASS — `UUID_RE` regex enforced |
| Body size cap before JSON parse | PASS — `MAX_BODY_BYTES = 8192` enforced before `JSON.parse` |
| Durable rate limit key TTL set (Upstash) | PASS — `expire(key, 3660)` on first window hit |
| `since` cursor injection-safe | PASS — string comparison only, not used in Redis commands |
| PATCH status enum validated | PASS — `FEEDBACK_STATUSES.includes()` check |
| No mass-assignment in PATCH | PASS — only `id`, `status`, `triageRef` extracted |
| No IP stored | PASS — `x-forwarded-for` not collected |
| No geolocation stored | PASS |
| Token comparison timing-safe | FAIL — see M1 |
| npm audit (new packages) | INFO — 2 moderate pre-existing vulns (postcss via Next.js) |

---

## Verdict

**PASS-WITH-NOTES**

No BLOCKER or HIGH findings. One MEDIUM (M1 — non-timing-safe token comparison) and two LOWs (L1 — UUID rotation bypass; L2 — stored-XSS risk at future consumers). All three should be addressed before mission-control's feedback intake dashboard is built. The PR is safe to merge in its current form.

The 105/105 unit suite is green. All TICKET-1 protections are intact.
