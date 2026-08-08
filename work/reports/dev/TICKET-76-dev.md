# TICKET-76 — Dev report

## Changes

| File | Change |
| --- | --- |
| `lib/host-auth.ts` | `SESSION_MAX_AGE_SECONDS` 12h → 30d, now exported (tests assert against it). Documented the rejected alternatives and the shared-device tradeoff. |
| `app/api/host/session/route.ts` | `GET` re-sets the just-verified cookie with a fresh window on success only. 400/401 branches return before it and set no cookie. Every response now carries `Cache-Control: private, no-store` (review LOW-1). |
| `components/SavedRooms.tsx` | Comment only — corrected the stale "~12h", recorded why `MAX_HOST_PROBES` stays at 3. No behavioural or copy change. |
| `__tests__/host-api.test.ts` | New `describe` covering lifetime, rolling refresh, no-refresh on 401/400, cookie attributes, logout clearing. |

No new user-facing copy. No `messages/*.json` change.

## Verification

### Unit

```
Test Suites: 43 passed, 43 total
Tests:       694 passed, 694 total
```

### e2e (full suite, `PORT=3188`)

```
81 passed (3.4m)
```

Clean first run, **post-merge with `main`** (81 rather than the earlier 77 — `main` brought 4 new specs). Ports and the injected `localStorage` file are cleared before each run: Playwright's `webServer` injects `/tmp/boraoke-ls-3188.json`, and leaving manual-probing state in it is what produced a contaminated run earlier in this ticket.

### tsc

Pre-existing baseline is missing `@types/jest`, so all errors are jest globals inside `__tests__`. Measured with `tsconfig.tsbuildinfo` deleted on both sides:

- main: 2230 lines, branch: 2265 lines (+35, entirely jest-global noise from the new test block).
- Errors in `lib/`, `app/`, `components/`: **0 on main, 0 on branch — no delta.**

### Build

`npm run build` succeeded.

## Real HTTP evidence

Observed against a **production** build (`next start`, `HOST_TOKEN` set), not read from source.

Login:

```
HTTP/1.1 200 OK
set-cookie: cantai_host=b011362a…70e2; Path=/api/host; Expires=Mon, 07 Sep 2026 22:18:44 GMT; Max-Age=2592000; Secure; HttpOnly; SameSite=lax
```

`Max-Age=2592000` = 30 days. `Secure; HttpOnly; SameSite=lax; Path=/api/host` all retained.

The probe is also uncacheable on both branches:

```
=== 200 probe ===   cache-control: private, no-store
=== 401 probe ===   cache-control: private, no-store
```

Rolling refresh on a successful probe (dev run, showing the window genuinely moving — first `Expires` 22:15:24 at login, second 22:15:40 on the probe 16s later, i.e. a fresh 30 days from *now*, not a replayed expiry):

```
HTTP/1.1 200 OK
set-cookie: cantai_host=2944b673…3539; Path=/api/host; Expires=Mon, 07 Sep 2026 22:15:40 GMT; Max-Age=2592000; HttpOnly; SameSite=lax
```

A 401 never mints or extends — no `set-cookie` at all, with either no cookie or a forged one:

```
=== PROBE with NO cookie ===        HTTP/1.1 401 Unauthorized   (no set-cookie)
=== PROBE with FORGED cookie ===    HTTP/1.1 401 Unauthorized   (no set-cookie)
```

Logout clears, and the cleared jar no longer authenticates:

```
POST /api/host/session  →  HTTP/1.1 200 OK
set-cookie: cantai_host=; Path=/api/host; Max-Age=0

curl cookie jar after logout: 0 cantai_host entries left
GET /api/host/session -b <post-logout jar>  →  HTTP/1.1 401 Unauthorized
```

## Composed behaviour: the 30-day rolling session vs. the NEW logout control

`origin/main` (which now carries the TICKET-77 "Sair" control) was merged into this branch — **clean, no conflicts**; the two changesets are file-disjoint (#77 touched `AdminRoom.tsx`, `admin.module.css`, `e2e/render-and-links.spec.ts`; none are mine).

The logout control was verified against a 12-hour session, so the composition with a rolling 30-day one was re-proven end to end in a **real Chromium browser** — real `localStorage`, a room created through the actual `/new` UI, the real "Sair" button, and the browser's own cookie jar. Every host-session request/response was recorded off the wire.

| Step | Result |
| --- | --- |
| Login at `/<room>/admin` | cookie `Max-Age=2592000`, `expiresInDays=30.0000` — **PASS** |
| Rolling refresh (reload = successful GET probe) | expiry moved **+6s** forward, **same** session value (rolled, not re-minted) — **PASS** |
| Host code in `localStorage` | `[{"id":…,"name":…,"role":"created","lastTouched":…,"claimable":true}]` — no code — **PASS** |
| New "Sair" control (confirm-gated) | `POST /api/host/session` → `200`, `set-cookie: cantai_host_<room>=; Path=/api/host; Max-Age=0` — **PASS** |
| Cookie after logout | `ABSENT` from the browser jar — **PASS** |
| **Post-logout visit to the public landing page** | probe fired and returned `401`, `set-cookie: NONE`; cookie still `ABSENT` — **PASS, session NOT re-armed** |
| Re-open admin after logout | login gate, not the dashboard — **PASS** |
| SavedRooms admin link after logout | `/<room>/admin?expired=1` — correct hint — **PASS** |

The rolling probe on the wire:

```
GET /api/host/session?room=bar-teste-msl1082j -> 200
set-cookie: cantai_host_bar-teste-msl1082j=f4c86c25…33aa; Path=/api/host; Expires=…23:50:07 GMT; Max-Age=2592000; HttpOnly; SameSite=lax
cache-control: private, no-store
```

Logout, then the landing page failing to re-arm:

```
POST /api/host/session?room=… -> 200   set-cookie: cantai_host_…=; Path=/api/host; Max-Age=0
GET  /api/host/session?room=… -> 401   set-cookie: NONE   cache-control: private, no-store
```

**Why it cannot re-arm** (the mechanism, not just the observation): the roll re-sends the cookie value taken *from the request* and only after `requireHost()` has verified it. Logout removes that cookie from the browser, so the landing-page probe arrives with **nothing to verify**, 401s, and returns before the refresh line. A session can only be extended by a caller that already holds a valid one — so the mitigation is real, not illusory.

## Host code still never persisted

`grep -rn hostCode app components lib` (minus `hostCodeHash`) returns only: the one-time render in `app/new/page.tsx`, the one-time `POST /api/rooms` response field, an i18n label in `AdminRoom.tsx`, and the stripping code/comments in `lib/room-memory.ts`. Nothing writes it to any storage. The invariant test passes:

```
SECURITY INVARIANT — never stores host code
  ✓ does not persist a hostCode even if smuggled into the input object
```
