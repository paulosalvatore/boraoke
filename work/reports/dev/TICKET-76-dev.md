# TICKET-76 — Dev report

## Changes

| File | Change |
| --- | --- |
| `lib/host-auth.ts` | `SESSION_MAX_AGE_SECONDS` 12h → 30d, now exported (tests assert against it). Documented the rejected alternatives and the shared-device tradeoff. |
| `app/api/host/session/route.ts` | `GET` re-sets the just-verified cookie with a fresh window on success only. 400/401 branches return before it and set no cookie. |
| `components/SavedRooms.tsx` | Comment only — corrected the stale "~12h", recorded why `MAX_HOST_PROBES` stays at 3. No behavioural or copy change. |
| `__tests__/host-api.test.ts` | New `describe` covering lifetime, rolling refresh, no-refresh on 401/400, cookie attributes, logout clearing. |

No new user-facing copy. No `messages/*.json` change.

## Verification

### Unit

```
Test Suites: 43 passed, 43 total
Tests:       693 passed, 693 total
Time:        29.411 s
```

### e2e (full suite, `PORT=3188`)

```
77 passed (5.7m)
```

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

## Host code still never persisted

`grep -rn hostCode app components lib` (minus `hostCodeHash`) returns only: the one-time render in `app/new/page.tsx`, the one-time `POST /api/rooms` response field, an i18n label in `AdminRoom.tsx`, and the stripping code/comments in `lib/room-memory.ts`. Nothing writes it to any storage. The invariant test passes:

```
SECURITY INVARIANT — never stores host code
  ✓ does not persist a hostCode even if smuggled into the input object
```
