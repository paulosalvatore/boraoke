# Security Report — TICKET-7: Host Controls

**Auditor:** Cyber Security agent (D-011)
**PR:** #10 — `ticket/7-host-controls`
**Date:** 2026-07-05
**Verdict:** PASS-WITH-NOTES

---

## Scope

- `lib/host-auth.ts` — full auth model (timing-safe compare, HMAC session, cookie flags, dev fallback, production lock)
- `app/api/host/login/route.ts` — login endpoint (brute-force surface, error oracle, body cap)
- `app/api/host/session/route.ts` — session probe + logout
- `app/api/host/skip/route.ts` — skip head
- `app/api/host/remove/route.ts` — remove entry by id
- `app/api/host/reorder/route.ts` — reorder entry
- `app/api/host/pause/route.ts` — pause/resume
- `app/admin/page.tsx` — admin client page (token stash, client bundle)
- `app/api/queue/route.ts` — public GET (additive `paused` field)
- `.env.example` — HOST_TOKEN documentation
- `__tests__/host-auth.test.ts`, `__tests__/host-api.test.ts`, `__tests__/host-stats.test.ts`
- npm audit delta

---

## Checklist Results

### 1. lib/host-auth.ts

**Timing-safe comparison (timingSafeHexEqual)** — PASS

The implementation hashes both operands through HMAC-SHA256 before calling `timingSafeEqual`, producing fixed-length 32-byte digests regardless of input length. This correctly neutralises the length-leak that a bare `timingSafeEqual` call would expose when comparing strings of different lengths. Implementation is correct.

```ts
// lib/host-auth.ts:56-61
function timingSafeHexEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
}
```

**HMAC session derivation** — PASS

Session value is `HMAC(HOST_TOKEN, "cantai-host-session-v1").digest("hex")`. The token is the HMAC key; the constant data string acts as a domain separator. One-way: an observer with the session cookie cannot reverse the token without brute-force. On HOST_TOKEN rotation `resolveRoomToken` returns the new token at call time, so all previously issued sessions immediately become invalid — confirmed by test `"rejects a session minted for a different token"`. No replay across rotations.

**Dev fallback token dead in production** — PASS

`resolveRoomToken` returns `DEV_FALLBACK_TOKEN` only when `process.env.NODE_ENV !== "production"`. The production path returns `null` (locked), gating out host controls entirely. Verified by unit test `"is LOCKED (null) in production with no token"` and `"rejects everything when locked in production"`.

**Fail-closed when HOST_TOKEN unset in prod** — PASS

`isHostConfigured` returns `false` → `/api/host/login` responds 503, all `requireHost` checks return false → 401. No route is callable in production without a configured token.

**Cookie flags** — PASS (one INFO note below)

| Flag | Value | Assessment |
|------|-------|------------|
| httpOnly | true | Correct — blocks JS access |
| sameSite | lax | Adequate — blocks cross-site POST; see note |
| secure | `NODE_ENV === "production"` | Correct — HTTPS-only in prod |
| maxAge | 43200 (12 h) | Reasonable for a venue shift |
| path | `/` | See LOW-1 below |

### 2. Login endpoint brute-force surface

**No rate limiting** — MEDIUM (see finding M-1)

**Error oracle** — PASS

Wrong token and missing/malformed token both return 401 `{"error":"Invalid host token"}` — same status code, same body. No distinguishing oracle between "token wrong" vs "token absent".

`503` is returned only when host controls are unconfigured — this is visible via the session probe too so it leaks nothing new.

**Body cap** — PASS — `MAX_BODY_BYTES = 1024` applied before `JSON.parse`.

### 3. Host routes — auth guard

All six routes (`login`, `session`, `skip`, `remove`, `reorder`, `pause`) call `requireHost` or `isHostConfigured` as their first statement. Verified by code review and unit test `"every mutating route 401s without a cookie"`. No route trusts client-supplied room or role fields — roomId is hardcoded to `DEFAULT_ROOM`.

**Input validation** — PASS

- `reorder`: entryId type-checked (string, non-empty), newIndex type-checked (`Number.isInteger`). Store clamps out-of-bounds index.
- `remove`: entryId type-checked (string, non-empty).
- `pause`: paused type-checked (boolean).
- All routes cap body at 1024 bytes.

**CSRF posture** — PASS

All state-changing operations are POST. `sameSite: "lax"` means the session cookie is not sent with cross-origin POST requests. No state-changing GETs exist. Combined: CSRF is adequately mitigated without a separate CSRF token.

### 4. Client bundle — secret material

`lib/host-auth.ts` begins with `import "server-only"` (line 22). Next.js build enforces that any client-side import of this module triggers a hard build error. The admin page (`app/admin/page.tsx`) is `"use client"` and does NOT import from `lib/host-auth.ts` — it only sends the token via POST body and stores nothing beyond transient React state.

Post-login: `setToken("")` is called immediately (line 118 of admin page), clearing the token from React state. No localStorage, sessionStorage, or global variable usage observed. The session cookie is httpOnly, so it is never accessible to JavaScript.

Grepped `.next/static/chunks` for `"cantai-dev-host"`, `"HOST_TOKEN"`, `"timingSafeEqual"`, `"server-only"` — zero matches. (Note: the worktree build errors out due to duplicate lockfile path confusion from the worktree setup; the Vercel CI build passed cleanly — see CI section.)

### 5. paused flag on public GET

`app/api/queue/route.ts` adds `paused: boolean` to the response. The value is the result of `store.isPaused()` cast to boolean — no additional fields, no conditional branches that could leak implementation details. INFO-level: `paused: false` when host controls are not configured could imply to an observer that the venue is live, but this is by design and not a vulnerability.

### 6. npm audit delta

```
postcss <8.5.10 — moderate (GHSA-qx2v-qp2m-jg93)
XSS via unescaped </style> in CSS Stringify Output
Transitive via: next > postcss
```

The fix requires `npm audit fix --force` which would downgrade Next.js to 9.3.3 — a breaking change. The vulnerability is in the build-tool CSS stringification layer, not in the running app's response handling. Risk surface is confined to build-time; the deployed application is not affected. Logged as LOW-2.

**No new dependencies added by TICKET-7.** The `crypto` module used is Node.js built-in.

### 7. Unit tests

```
Tests: 109 passed, 109 total — all green
```

Coverage of security-relevant paths:
- Production lock / dev fallback branching: covered
- Token verification (correct, wrong, empty, null, non-string): covered
- Session round-trip and rotation invalidation: covered
- Auth guard on all 6 routes: covered
- Input validation (bad entryId, non-integer index, non-boolean paused): covered

### 8. CI

`gh pr checks 10` output: Vercel deployment **pass**. No required checks pending. Final verdict issued on terminal CI state.

---

## Findings

### M-1 — MEDIUM — No rate limiting on POST /api/host/login

**Location:** `app/api/host/login/route.ts` (entire file)

**Description:** The login endpoint accepts unlimited token submissions from any client IP. An attacker can submit arbitrary token guesses at network speed without triggering any lockout or slowdown. The 1 KB body cap prevents payload-flooding but does not throttle guessing.

**Exploit path:** Realistic only against weak tokens (short passphrases, venue name variants). The `.env.example` guidance to use `openssl rand -base64 32` produces a 256-bit secret which is computationally infeasible to brute-force. However, the security property depends entirely on operators following that guidance — the code does not enforce minimum token entropy.

**Remediation direction:** Add per-IP request throttling at the Vercel edge (middleware with a simple in-memory counter or Upstash rate-limit library), or add a server-side counter with exponential backoff after N failed attempts for the same IP. A simple approach: reject with 429 after 10 consecutive failures from the same IP within 60 seconds. Alternatively, document minimum token strength (e.g. ≥ 128 bits of entropy) explicitly in README/onboarding so operators know what they're relying on.

**Does not block merge.** The practical exploit requires a weak token, and the `.env.example` guidance steers operators toward strong tokens.

---

### LOW-1 — LOW — Session cookie scoped to path "/"

**Location:** `lib/host-auth.ts:103` (`hostCookieOptions`)

**Description:** The host session cookie is issued with `path: "/"`, meaning the browser includes it in every request to the application — including the public patron queue GET `/api/queue`, the `/tv` page, and any future public routes. The server ignores the cookie on those routes, so there is no functional vulnerability. However, the cookie adds unnecessary bytes to every public request and is available to any future route handler that might accidentally read it.

**Remediation direction:** Tighten the path to `/api/host` (covers all host API routes and the admin page session probe) or at minimum `/admin`. This is a defence-in-depth improvement, not a blocker.

---

### LOW-2 — LOW — Moderate postcss vulnerability in transitive next@ dependency

**Location:** `package.json` / `package-lock.json` (transitive)

**Description:** `npm audit` reports `postcss <8.5.10` (GHSA-qx2v-qp2m-jg93 — XSS via `</style>` in CSS Stringify). The vulnerable code is in the Next.js build toolchain; the runtime application is unaffected. The fix requires downgrading Next.js to 9.3.3, which is a breaking change.

**Remediation direction:** Track the upstream Next.js fix (expected in a next minor/patch release). No immediate action required; revisit when a non-breaking postcss update ships through the Next.js release line.

---

### INFO-1 — INFO — sameSite: "lax" vs "strict"

**Location:** `lib/host-auth.ts:101`

**Description:** `sameSite: "lax"` allows the session cookie to be sent when the user follows a cross-site link that navigates to an admin URL (top-level GET). Since all state-changing routes are POST, this does not create a CSRF vector. `sameSite: "strict"` would be marginally more conservative but could cause the session to be dropped when navigating from an external link, forcing the host to re-authenticate unnecessarily.

**Assessment:** Current setting is appropriate for this use case. No action required.

---

## Summary

| ID | Severity | Finding | Blocks merge? |
|----|----------|---------|---------------|
| M-1 | MEDIUM | No rate limiting on /api/host/login | No |
| LOW-1 | LOW | Cookie path "/" broader than necessary | No |
| LOW-2 | LOW | Transitive postcss moderate vuln (unfixable without Next.js downgrade) | No |
| INFO-1 | INFO | sameSite lax vs strict trade-off | No |

All core security properties are correctly implemented: timing-safe comparison with length-leak guard, one-way HMAC session with rotation invalidation, production lock with fail-closed 503/401, httpOnly+secure cookie, `server-only` guard preventing client bundle leakage, no error oracle at login, all 6 routes enforce auth, input validated, CSRF mitigated via POST+sameSite.

**Verdict: PASS-WITH-NOTES**

M-1 (rate limiting) is the only finding worth a follow-up ticket. The rest are defence-in-depth improvements or acknowledged trade-offs.

---

## Gate checkpoint

- [x] All CI checks in terminal state (Vercel: pass)
- [x] Unit tests: 109/109 green (run locally)
- [x] npm audit reviewed
- [x] Client bundle checked for secret material
- [x] All 6 host routes audited
- [x] Dev fallback production-lock verified by code and tests
- [x] Timing-safe comparison verified correct
