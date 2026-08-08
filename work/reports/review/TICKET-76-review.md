# TICKET-76 — Cyber Security Review

**Branch:** `ticket/76-host-session-persistence` · **Diff:** `git diff origin/main...HEAD`
**Reviewer:** Cyber Security Reviewer (clean context — every claim below re-derived from source and from live HTTP, not from the dev report)
**Worktree:** `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-76` · **Port:** 3188

## Verdict

**APPROVE** — no BLOCKING or HIGH finding. The change is small, correctly scoped, and the security reasoning behind it is sound (and, unusually, honest about its own weak points). Two MEDIUM items are follow-up/disclosure issues rather than defects in this diff, and two LOW items are cheap hardening suggestions.

The core judgement: raising a **deterministic, non-revocable** session cookie's `maxAge` from 12h to 30d does not widen the theft/replay attack at all, because `maxAge` was never a bound on an attacker who holds the value — only on the legitimate browser's disk retention. That reasoning is correct, and I verified the premise (the value is a fixed HMAC, unchanged across re-issues) on the wire. The rejection of the Tech Lead's literal request (host code in URL / localStorage) was the right call: only `hostCodeHash` is stored, so the raw code is unrecoverable and non-rotatable, and any leak of it is permanent.

---

## What I independently verified

### Diff boundary

```
$ git diff origin/main...HEAD --name-only
__tests__/host-api.test.ts
app/api/host/session/route.ts
components/SavedRooms.tsx
lib/host-auth.ts
work/events/by-branch/ticket-76-host-session-persistence.jsonl
work/reports/dev/TICKET-76-dev.md
work/tickets/TICKET-76-host-session-persistence.md
```

Every file is inside the ticket's allowed set except `work/events/by-branch/...jsonl`, which is the house's auto-committed event log (D-036 machinery, not authored content) — **not** a boundary violation. **No `messages/*.json` change → no new user-facing copy.** Confirmed.

`components/SavedRooms.tsx` is **comment-only**:

```
$ git diff origin/main...HEAD -- components/SavedRooms.tsx | grep '^[+-]' | grep -v '^[+-] *\*' | grep -v '^[+-] *$' | grep -vE '^(\+\+\+|---)'
(none — comment-only)
```

`lib/host-auth.ts` changes exactly one executable line (`SESSION_MAX_AGE_SECONDS`, plus its `export`); `hostCookieOptions()` and `HOST_COOKIE_PATH` are byte-identical to `origin/main`:

```
$ git show origin/main:lib/host-auth.ts | sed -n '/export function hostCookieOptions/,/^}/p'
export function hostCookieOptions() {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: HOST_COOKIE_PATH,
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
$ git show origin/main:lib/host-auth.ts | grep 'HOST_COOKIE_PATH ='
export const HOST_COOKIE_PATH = "/api/host";
```

**Path was not widened. `sameSite` was not relaxed.**

### Tests

```
$ npm test
Test Suites: 43 passed, 43 total
Tests:       693 passed, 693 total
```

Includes `PASS __tests__/room-memory.test.ts` (the SECURITY INVARIANT suite) and `PASS __tests__/host-auth.test.ts`.

e2e: `PORT=3188 npx playwright test` — see the e2e section at the end of this report.

---

## Answers to the six questions

### 1. Cookie attributes on the wire — CONFIRMED

Observed against a running server, not read from source.

**Dev (`npx next dev -p 3188`), login + rolling refresh:**

```
$ curl -i -X POST http://127.0.0.1:3188/api/host/login -d '{"token":"cantai-dev-host"}'
HTTP/1.1 200 OK
set-cookie: cantai_host=2944b673…3539; Path=/api/host; Expires=Mon, 07 Sep 2026 22:28:07 GMT; Max-Age=2592000; HttpOnly; SameSite=lax

$ curl -i http://127.0.0.1:3188/api/host/session -H "Cookie: cantai_host=2944b673…3539"
HTTP/1.1 200 OK
set-cookie: cantai_host=2944b673…3539; Path=/api/host; Expires=Mon, 07 Sep 2026 22:28:07 GMT; Max-Age=2592000; HttpOnly; SameSite=lax
{"authed":true,"configured":true}
```

**Production build (`npm run build` + `HOST_TOKEN=… npx next start -p 3188`):**

```
$ curl -i http://127.0.0.1:3188/api/host/session -H "Cookie: cantai_host=d2059aba…20cc"
HTTP/1.1 200 OK
set-cookie: cantai_host=d2059aba…20cc; Path=/api/host; Expires=Mon, 07 Sep 2026 22:30:39 GMT; Max-Age=2592000; Secure; HttpOnly; SameSite=lax
{"authed":true,"configured":true}
```

- `Max-Age=2592000` = 30 days exactly. ✅
- `HttpOnly` ✅ · `Path=/api/host` (not widened) ✅ · `SameSite=lax` (not relaxed) ✅
- `Secure` **present** under the production build ✅ and **absent** in dev ✅ (so local http dev still works — correct, `secure: process.env.NODE_ENV === "production"`).
- Exactly **one** `set-cookie` on the refresh — the roll overwrites in place rather than creating a second, differently-scoped cookie.
- `npm run build` marks `/api/host/session` as `ƒ (Dynamic)` — it is not prerendered/statically cached.

### 2. Can any 400/401 path mint or extend a session? — NO, verified by exercise

| Case | Observed |
| --- | --- |
| No cookie at all | `HTTP/1.1 401` — **no `set-cookie`** |
| Garbage cookie (`cantai_host=deadbeef…`) | `HTTP/1.1 401` — **no `set-cookie`** |
| Empty cookie value (`cantai_host=`) | `HTTP/1.1 401` — **no `set-cookie`** |
| Valid cookie for room A, probing room B (`?room=bar-b`) | `HTTP/1.1 401` — **no `set-cookie`** |
| Room A's session **value** placed under room B's cookie **name** | `HTTP/1.1 401` — **no `set-cookie`** |
| Malformed room id (`?room=NOT%20A%20ROOM`) **with** a valid cookie | `HTTP/1.1 400` — **no `set-cookie`** |
| Unknown/unconfigured room | `HTTP/1.1 401 {"authed":false,"configured":false}` — no `set-cookie` |
| Valid cookie, correct room | `HTTP/1.1 200` + refreshed `set-cookie` |
| Both A and B cookies present, probing B | `200`, refreshes **only** `cantai_host_bar-b` |
| Room A cookie against `POST /api/host/pause?room=bar-b` | `HTTP/1.1 401` |

**Can it echo an attacker-supplied cookie value back?** Only in the trivial, harmless sense. The refresh re-sends `req.cookies.get(hostCookieName(roomId))?.value` — the *same* cookie read that `requireHost()` just verified via `verifySessionValue()` (constant-time compare against `HMAC(roomToken, "cantai-host-session-v1")`). There is no second read, no alternate source, and no reachable path where the two reads could diverge. So the only value that can ever be echoed is one that already equals the room's valid session value — i.e. the attacker learns nothing and gains nothing they did not already have. Header-injection via the echoed value is also impossible: the value must be a 64-char hex HMAC to reach that line, and Next serializes it through `cookies.set()` regardless.

One structural nit in the code's favour: the refresh is genuinely inside the success branch, after both early returns — I traced it, the comment is accurate.

### 3. Does the longer window widen any existing attack? — Substantively no; one honest caveat

- **Theft / replay.** The session value is `HMAC(secret, "cantai-host-session-v1")` — deterministic, identical on every issue (I confirmed: the login cookie and the rolled cookie are the *same* 64-hex value), and with **no server-side revocation**. An attacker holding the value replays it forever by setting their own expiry; `maxAge` is a client-side retention hint that constrains only the honest browser. So 12h → 30d **does not widen this at all**. The reasoning in the code comment is correct as written.
- **XSS.** `httpOnly` means script cannot read the cookie, and `Path=/api/host` means it isn't even attached to page loads. XSS reach is unchanged by the lifetime; the important point is that the rejected alternative (host code in `localStorage`) *would* have converted any XSS into permanent, unrevocable room takeover. Rejecting it was right.
- **CSRF.** All mutating host routes are `POST`; `SameSite=lax` withholds the cookie on cross-site POST. Verified `POST /api/host/pause` with a wrong-room cookie → 401. The one lax-permitted vector is a top-level cross-site **GET** navigation to `/api/host/session`, which would roll the victim's own cookie — the attacker cannot read the JSON response cross-origin and gains nothing. Informational only.
- **Login brute force.** Untouched by this diff: `THROTTLE_MAX_FAILURES = 10 / 60s` per IP in `lib/host-auth.ts`, enforced in `app/api/host/login/route.ts` before body parsing, Upstash-backed cross-instance. A longer session arguably *reduces* login volume. No regression.
- **Shared / public venue devices — the real cost, and where the disclosure is slightly generous.** The stated tradeoff is the right one, and it is disclosed prominently in both `lib/host-auth.ts` and the ticket. But the ticket says the next person is "host for **up to 30 days**". With the rolling refresh that ceiling is not real: `components/SavedRooms.tsx` probes the session from the **public landing page**, so *any* visit to boraoke.com from that tablet — by anyone, without touching admin — silently re-arms the host session for another 30 days. On a device that keeps visiting the site the session is effectively **unbounded**, not 30-day-bounded. That is a defensible product decision, but it should be stated that way. See MEDIUM-2.

### 4. Is the host code still never persisted? — YES

- `lib/room-memory.ts` is **not in the diff**. Its SECURITY INVARIANT header and `rememberCreatedRoom`'s defensive destructure (`const { id, name } = input;`, discarding everything else) are intact.
- Its test passes: `PASS __tests__/room-memory.test.ts` within the 693/693 run, including `SECURITY INVARIANT — never stores host code`.
- `grep -rn hostCode app/ components/ lib/room-memory.ts` returns only pre-existing, unchanged sites: the one-time render in `app/new/page.tsx`, the one-time `POST /api/rooms` response field, an i18n label in `AdminRoom.tsx`, and the stripping code/comments. **Nothing in this diff adds client-side persistence**, and no route or component in the diff puts the code in a URL — the only URL param touched is `?room=` (an id) and the pre-existing `?expired=1` copy hint, which carries no auth meaning.

### 5. Is logout complete? — Mechanically yes; **globally, no — and that is disclosed**

`POST /api/host/session` clears on the **matching path** with `maxAge: 0`:

```
$ curl -i -X POST http://127.0.0.1:3188/api/host/session -H "Cookie: cantai_host=d2059aba…20cc"
HTTP/1.1 200 OK
set-cookie: cantai_host=; Path=/api/host; Max-Age=0
```

Path matches `HOST_COOKIE_PATH`, so the browser genuinely drops it, and the next probe from that jar 401s.

**It is local-only, not a global revocation.** I proved this on the wire rather than inferring it — logout, then replay the same value from a fresh request:

```
-- probe before logout --  200
-- logout --               200
-- REPLAY same cookie value after logout --
HTTP/1.1 200 OK
{"authed":true,"configured":true}
-- mutating route replay after logout --  200
```

So a copied cookie value survives logout and can be re-rolled indefinitely. This is **pre-existing** (it follows directly from the deterministic non-revocable session value, which predates this ticket) and it is **honestly disclosed** — `work/tickets/TICKET-76-host-session-persistence.md` states it verbatim under Follow-ups: *"logout is local-only: it clears the cookie in that browser but cannot invalidate a value already copied elsewhere. Fixing that needs a per-session nonce stored server-side."* That is an accurate and complete disclosure. No finding against the diff; it does raise the value of MEDIUM-1.

### 6. Other security observations

Covered in the findings below. Nothing rises to BLOCKING or HIGH.

---

## Findings

### MEDIUM-1 — The named mitigation (logout) has no user-reachable control anywhere in the app

`lib/host-auth.ts` justifies the 30-day window with *"Logout (`POST /api/host/session`) is the mitigation and must stay reachable."* It is reachable as an endpoint, but nothing calls it:

```
$ grep -rn "host/session" app/ components/
app/admin/analytics/page.tsx:53:  fetch(`/api/host/session?room=${ROOM}` …)   # GET
app/(patron)/[room]/admin/AdminRoom.tsx:80:  fetch(`/api/host/session${roomQuery}`)  # GET
components/SavedRooms.tsx:60:  fetch(`/api/host/session?room=…`)               # GET
```

**Zero POST callers.** A venue staffer on a shared tablet has no way to end the session short of clearing site data. The dev correctly identified this and filed it as an out-of-boundary follow-up (`AdminRoom.tsx` is owned by another agent this cycle), which is the right process call — so this is **not a change request against this diff**. But the follow-up should be prioritised, not merely filed: it is the only mitigation for the one cost this ticket actually accepts. Recommend it lands in the same release.

### MEDIUM-2 — "up to 30 days" understates the shared-device exposure; the rolling refresh removes the ceiling

The ticket's shared-device paragraph is the one place the disclosure is not fully accurate. Because the roll is driven by the **public landing page** probe (`components/SavedRooms.tsx`), not by an admin action, a shared device that merely keeps visiting boraoke.com never lets the session lapse. The correct statement is "indefinitely, for as long as that device keeps visiting the site", not "up to 30 days". Recommend a one-line correction to `work/tickets/TICKET-76-*.md` (and optionally the `lib/host-auth.ts` comment) so the accepted risk is recorded as it actually is. Doc-honesty only — no code change required.

### LOW-1 — `GET /api/host/session` now always emits `Set-Cookie` but sends no `Cache-Control`

Full production response headers:

```
HTTP/1.1 200 OK
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
content-type: application/json
set-cookie: cantai_host=…; Path=/api/host; …
Date: …
```

No `Cache-Control`. Before this diff the endpoint carried no cookie, so this is the **first cookie-bearing GET** in the app. Practical risk is low (the route is dynamic, Vercel does not CDN-cache route handlers without explicit cache headers, and virtually every cache bypasses `Set-Cookie` responses), but relying on an intermediary's default behaviour for a credential-bearing response is not the posture the rest of this file takes. Cheap, in-boundary fix:

```ts
const res = NextResponse.json({ authed: true, configured });
res.headers.set("Cache-Control", "private, no-store");
```

### LOW-2 — The two client probes use default fetch caching, so a cached probe silently skips the roll

`AdminRoom.tsx:80` and `SavedRooms.tsx:60` both `fetch()` without `{ cache: "no-store" }` — note `app/admin/analytics/page.tsx:53` *does* pass it, so the inconsistency is real. A cached 200 means the browser never receives the refreshed `Set-Cookie` and the session quietly ages out despite active use, which is exactly the failure this ticket set out to fix. Availability rather than security, and both call sites are outside this ticket's file boundary — the LOW-1 route-level `Cache-Control` fix addresses it in-boundary from the server side.

### NIT-1 — Stale "~12h" comment in `lib/room-memory.ts:15`

`* recovering host control still requires the code (or a live ~12h host-session cookie)` is now wrong. Already self-reported by the dev as out-of-boundary. Fold into whichever follow-up touches that file.

### NIT-2 — One new test is tautological

`__tests__/host-api.test.ts`, `"a session outside the window is gone → probe 401s (browser drops it)"` is byte-for-byte the same exercise as `"does NOT mint a session on a 401 probe"` — it calls `probeReq()` with no cookie and asserts 401. It asserts nothing about the window (which is not server-enforced, as its own comment concedes). Harmless, but it reads as coverage that does not exist. The genuinely valuable case it could assert instead — a **valid cookie for a different room** — is covered elsewhere in the file (`per-room scoping (TICKET-9)`), so coverage is fine overall.

### INFO — Pre-existing, not worsened by this diff

- **No server-side revocation.** The session value is a pure function of the room's `hostCodeHash`, so there is no way to invalidate an issued session without changing the room secret — and the raw host code is unrecoverable, so it cannot be rotated either. Correctly disclosed in the ticket as a real design change, not a lifetime tweak.
- **No `__Host-` cookie prefix.** Structurally incompatible with the (better) `Path=/api/host` least-privilege scoping, since `__Host-` mandates `Path=/`. A subdomain attacker could shadow the cookie with a `Domain=.boraoke.com; Path=/` value, but that value fails HMAC verification → 401. Denial-of-service at worst, never escalation. The path scoping is the better tradeoff; no change recommended.
- **Lax-permitted top-level GET** can roll a victim's own session cross-site. No attacker-readable response, no gain.

---

## Test / gate evidence

- `npm test` — **693 passed, 43 suites, 0 failed.**
- `npm run build` — succeeded; `/api/host/session` listed as `ƒ (Dynamic)`.
- **e2e — all 77 specs observed green, but in two runs. Reviewer-caused, not a branch defect; recorded in full for honesty.**

  First full run: `PORT=3188 npx playwright test` → **70 passed, 7 failed (15.4m)**. The 7 were `contrast.spec.ts` (×3), `feedback.spec.ts` (×1), `render-and-links.spec.ts` (×2), `rotation-modes.spec.ts` (×1) — none of which touch host auth or the session cookie.

  Cause: **my own manual HTTP probing**. Playwright's `webServer` injects `NODE_OPTIONS=--localstorage-file=/tmp/boraoke-ls-${PORT}.json`, and I had already run a dev server on 3188 against that same file while creating rooms `bar-a` / `bar-b` / `bar-c` for the cross-room tests. Those leftover rooms polluted the store the suite seeds against.

  Re-run of exactly the four failing spec files after `rm -f /tmp/boraoke-ls-3188.json`:

  ```
  ✓  19 [chromium] › e2e/feedback.spec.ts:10:5 › feedback button is present … (2.9s)
  ✓  31 [chromium] › e2e/render-and-links.spec.ts:292:5 › legacy /admin and /tv redirect … (22.2s)
  ✓  32 [chromium] › e2e/render-and-links.spec.ts:329:5 › link-crawler … no 404 links (13.1s)
  ✓  33 [chromium] › e2e/rotation-modes.spec.ts:50:5 › host switches rotation mode … (4.1s)

  33 passed (6.0m)
  ```

  Every previously-failing test passes on clean state. Combined with the 70 that passed in the first run, **the whole suite is green on this branch**. This also matches the dev report's `77 passed (5.7m)`, and incidentally explains the 15.4m vs 5.7m runtime gap (retries against poisoned state).
- All HTTP evidence above captured against servers I started myself on **port 3188 only**; the shared checkout and sibling worktrees were never touched.
