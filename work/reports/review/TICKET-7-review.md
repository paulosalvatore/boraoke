# Review Report — TICKET-7: Host Controls

- **Reviewer:** Reviewer agent (D-011, first-pass sonnet tier)
- **PR:** #10 — `ticket/7-host-controls`
- **Date:** 2026-07-05
- **Verdict:** APPROVE

---

## Preconditions verified

| Gate | Status | Evidence |
|------|--------|----------|
| App Tester PASS | ✓ | `work/reports/testing/TICKET-7-app-test.md` — all AC tested, 11 screenshots |
| Security PASS-WITH-NOTES | ✓ | `work/reports/security/TICKET-7-security.md` — M-1 + LOW-1 folded in-branch, 8 tests added |
| CI green | ✓ | `gh pr checks 10` → Vercel: pass, Vercel Preview Comments: pass (both terminal-green, zero pending) |
| Dev report current | ✓ | Report read from PR branch; reflects folded security items, 117/117 unit tests, 3 e2e |

---

## Own verification

### Tests (run locally from worktree)

```
npm ci → clean
npm test → 6 suites / 117 passed / 0 failed  ✓
npm run build → Compiled + type-check + lint clean ✓
```

Build output confirms all 6 `/api/host/*` routes (`login`, `pause`, `remove`, `reorder`, `session`, `skip`) and `/admin` are present.

### Token bundle check

```
grep -rl 'cantai-dev-host|HOST_TOKEN|cantai_host|timingSafeEqual' .next/static/
→ empty (exit 0 with no matches)
```

No secret or auth material in the static client bundle. AC#6 independently confirmed.

---

## Keystone review: lib/host-auth.ts

**timingSafeHexEqual** — correct. Both operands are hashed through HMAC-SHA256 before calling `timingSafeEqual`, producing fixed-length 32-byte digests regardless of input length. This eliminates the length-leak that a bare `timingSafeEqual` on variable-length strings would expose. The "cmp" key is a constant and serves its purpose as a length normalizer.

**HMAC session derivation** — correct. `sessionValue(token)` = `HMAC(token, "cantai-host-session-v1").digest("hex")`. Token is the key; the constant string acts as a domain separator. One-way: cookie observer cannot reverse the token. The unit test `"rejects a session minted for a different token"` verifies that rotating `HOST_TOKEN` immediately invalidates outstanding sessions — confirmed passes at 117.

**Dev fallback / production lock** — safe. `resolveRoomToken` reads `process.env.NODE_ENV` at call time (runtime, not build-time); server-side Next.js code reads the live env, so `NODE_ENV=production` on the Vercel runtime correctly locks the fallback out. The `import "server-only"` at the top of the file enforces that Next.js will hard-error at build time if any client-side code tries to import from this module. Build passes clean with `/admin` as a `"use client"` component that does NOT import from `lib/host-auth.ts` — confirmed from the diff.

**Throttle logic** — correct.
- Window arithmetic: stale window detected by `Date.now() - bucket.windowStart >= THROTTLE_WINDOW_MS`; stale entries are evicted on `isLoginThrottled` check and rebuilt fresh on next failure.
- LRU eviction: `loginFailures.delete(ip)` + `loginFailures.set(ip, ...)` correctly refreshes Map insertion order for existing IPs; new-IP capacity check (`!loginFailures.has(ip) && loginFailures.size >= MAX`) fires before insert. Size stays bounded at `THROTTLE_MAX_TRACKED_IPS`.
- Success-reset: `resetLoginThrottle(ip)` deletes the bucket; subsequent failures start a fresh window. Verified by test `"resets the failure bucket on a successful login"` (confirmed passing).
- Note: throttle is per-process/in-memory — correctly documented in both the dev report and the code comment. Not a hard global cap on serverless, but a meaningful attack-surface reduction for the practical threat.

**Cookie constants coherence** — set and clear paths both use `HOST_COOKIE_PATH` constant (`"/api/host"`). The security-gate-caught logout clear-path trap (where a mismatched path silently fails to clear) is correctly resolved: `app/api/host/session/route.ts` POST uses `{ path: HOST_COOKIE_PATH, maxAge: 0 }`. The `httpOnly` flag is correctly set on issue. The `setToken("")` call in the admin page runs immediately in the `if (res.ok)` branch, clearing the token from React state before setting `auth` to `"authed"`. No other token stash observed.

**resolveRoomToken as TICKET-9 seam** — clean single-seam claim holds. Six call sites all go through `resolveRoomToken(roomId)` / `requireHost(req, roomId)`; TICKET-9 only needs to swap the lookup inside that one function, not touch any route or the admin page.

---

## Host routes — requireHost discipline

All six routes (`login`, `session`, `skip`, `remove`, `reorder`, `pause`) call `requireHost` or `isHostConfigured` as the first statement before any body read or store call. This is verified in the diff and by the unit test `"every mutating route 401s without a cookie"` (confirmed passing in the parametrized `it.each` test).

**Input validation:**
- `reorder`: `typeof entryId !== "string" || !entryId` + `!Number.isInteger(newIndex)` → 400. Store clamps out-of-range index (TICKET-6 contract).
- `remove`: `typeof entryId !== "string" || !entryId` → 400. Returns `{ok, removed}` where `removed=false` for unknown id — correctly idempotent.
- `pause`: `typeof paused !== "boolean"` → 400.
- All routes: body capped at 1024 bytes before parse.

**Response shapes:** consistent across all routes (`{ok: true, ...}`). No drift from the store type contract — routes call exactly the TICKET-6 frozen ops (`advance`, `removeEntry`, `reorder`, `setPaused`) without touching `lib/store.ts`.

---

## Admin page quality

**State machine:** `Auth = "checking" | "gate" | "authed"` — three states, all rendered distinctly. No state where controls appear before auth is confirmed.

**Error surfaces:** login shows `"Token inválido — tente de novo."` on 401, `"Controles do host ainda não configurados para este bar."` on 503, and `"Erro de rede — tente de novo."` on network failure. Distinct, actionable messages.

**Two-step remove confirm:** clicking "remover" sets `confirmingId = entry.id`; only that row shows Confirmar/Cancelar; other rows are unaffected. `remove(id)` calls `setConfirmingId(null)` before the async action. Cancelar just calls `setConfirmingId(null)`. Correct per-row isolation.

**Stats derivation:** `computeStats` in `components/host/stats.ts` is a pure function (no side effects, no storage calls). Tested in isolation: empty queue → all-zero; distinct patronUuid → correct singer count; blank/whitespace tables correctly excluded from table count. Three passing tests confirm.

**Mode-switcher placeholder:** rendered as `role="radio" aria-checked="false" aria-disabled="true"` with no `onClick` handlers. The "em breve" tag and note copy are present. No dead controls. AC#7 met.

**pt-BR:** all host-facing UI text is in pt-BR. Patron-facing English is a pre-existing design choice, not a regression.

**CSS module:** scoped to `app/admin/admin.module.css`. No global style leakage.

---

## Cross-boundary touches

**`app/api/queue/route.ts`** — the additive `paused` field is a genuine addition: `const [items, current, paused] = await Promise.all([...store.isPaused(DEFAULT_ROOM)])`. The GET response gains `paused: boolean`; all existing fields (`items`, `nowPlaying`) are unchanged. No wave owner conflict since this file is owned by `cantai/queue` wave, and the change is append-only to the JSON response.

**`.env.example`** — correctly appended (8 lines added at end). Documents the `HOST_TOKEN` pattern, dev fallback behavior, production lock, and `openssl rand -base64 32` generation command. No existing lines modified.

---

## E2e quality

The `host-controls.spec.ts` covers: login → remove (with confirm) → reorder → pause → patron-submit-while-paused → unpause. The `warmUp()` helper correctly pre-compiles every route before seeding to prevent the memory-driver singleton reset under `next dev`. The `drain()` helper resets state between tests using `/api/queue/advance` (route confirmed present in build output).

The unauthenticated-401 guard test covers all 4 mutating POST routes; GET /session 401 is covered by unit test `"session probe → 401 unauthenticated"` (confirmed passing).

Assertions are meaningful: remove is verified by `toHaveCount(0)` on the text; reorder is verified via API poll `toEqual(["Charlie", "Alpha"])`; pause is verified by both UI chip (`toBeVisible("Pausado")`) and API poll (`paused === true`); patron-submit-while-paused is verified by the `seed()` returning 201.

---

## AC verification

| AC | Status | Basis |
|----|--------|-------|
| 1. `/admin` no token → login gate; host APIs 401 | ✓ | e2e + unit auth-guard tests |
| 2. Remove asks confirm, entry disappears within one poll | ✓ | e2e + App Tester screenshots 05/06 |
| 3. Reorder moves entry, views converge | ✓ | e2e API poll assertion + App Tester screenshot 07 |
| 4. Pause + paused flag; submits keep working | ✓ (partial) | Backend + flag shipped, submit-while-paused e2e verified; TV player-freeze explicitly deferred to post-#9 per ticket scope |
| 5. Skip advances mid-video | ✓ | unit test (skip advances head) + e2e warmup path |
| 6. Token never in client JS/source/logs | ✓ | `grep .next/static` empty (own check) + server-only import |
| 7. Mode-switcher inert placeholder | ✓ | aria-disabled, no onClick, "em breve" copy |

AC#4's TV player-freeze deferral is explicitly scoped in the ticket (`/tv player-pause consumption arrives with rooms (TICKET-9 extends this)`). The backend flag is shipped and e2e-verified; this is not a gap.

---

## Opus second-pass (D-022 merge-counting judgment layer)

- **Reviewer:** Reviewer agent — opus tier (`claude-opus-4-8`)
- **Date:** 2026-07-06
- **Context:** venue admin plane onto the live product; **repo made PUBLIC** (source now readable by attackers).
- **Verdict:** APPROVE (this is the merge-counting APPROVE).

Independently re-ran: `npx jest` → 6 suites / **117 passed** (reproduced). CI terminal-green: `gh pr checks 10` → Vercel **pass**, Vercel Preview Comments **pass**, zero pending. Build authority is the green Vercel CI (the local worktree build hits the known duplicate-lockfile path confusion, unrelated to the code — same note the security gate recorded). Secret sweep of the full PR diff, `__tests__/`, `e2e/`, and branch file-adds: no real tokens, no `.env`/secret files, no long/real-looking token literals; the only in-source token is `DEV_FALLBACK_TOKEN` (explicitly a non-secret constant).

### 1. PUBLIC-REPO recheck — CLEAN

- **No obscurity dependence.** Session = `HMAC(HOST_TOKEN, "cantai-host-session-v1")`. The domain-separator constant and the entire algorithm being public does not weaken anything — security rests solely on `HOST_TOKEN` entropy (the HMAC key). Kerckhoffs-compliant; publishing the source changes nothing.
- **Dev fallback genuinely dead in production.** `DEV_FALLBACK_TOKEN = "cantai-dev-host"` is now public but is reachable only when `NODE_ENV !== "production"` (read at runtime). Vercel sets `NODE_ENV=production` at build **and** runtime for **every deployed environment — Production and Preview alike** (only local `vercel dev` / `npm run dev` is `development`). So on any public deployment URL, including public preview deploys, `resolveRoomToken` returns `null` → controls locked. Confirmed by unit tests "is LOCKED (null) in production" / "rejects everything when locked". Residual is purely operational and fail-closed: the owner must set `HOST_TOKEN` in Vercel or controls stay locked — a safe deny, not an exploit.
- **No token material in fixtures/evidence.** Diff/fixture grep clean; login screenshots show a masked password field.

### 2. Session lifecycle — acceptable, one runbook note

Cookie is stateless `HMAC(token, const)`, `maxAge` 12 h, `httpOnly` + `secure`(prod) + `sameSite=lax`. A stolen cookie is valid until 12 h expiry **or** `HOST_TOKEN` rotation (which changes the HMAC and invalidates **all** sessions at once). There is **no per-session revocation** — rotation is the only kill-switch and it logs every host out. Judgment: acceptable for a single-host bar shift — theft requires device access or TLS MITM (`httpOnly` blocks XSS read, `secure` forces HTTPS), and a server-side session store / jti-blocklist for per-cookie revocation is not warranted at PMF. **Non-blocking.** One doc heads-up (FOLLOW-UP-C): capture "kill-switch = rotate `HOST_TOKEN` in Vercel + redeploy (logs out all hosts)" in the operator runbook so the venue knows the only lever.

### 3. Concurrency (host ops vs patron advance) — real-but-low, UPGRADE the accepted LOW to a tracked follow-up

Most substantive finding. Upstash `removeEntry`/`reorder` are non-atomic read-modify-write (`lrange` → `del` → `rpush`, wholesale list rewrite), racing atomic `LPOP` (advance) and `RPUSH` (addEntry). Now that **live mutation callers ship**, the worst case is no longer purely theoretical:

- remove/reorder overlapping an auto-advance (song-end `LPOP`) → the just-finished head can be **resurrected** (the rewrite restores the pre-LPOP snapshot minus the removed id) → **double-play** of the current song at the top.
- remove/reorder overlapping a patron submit (`RPUSH`) → the concurrent new entry is **silently dropped** by the `del`+`rpush`.

Assessment: **low probability** at single-venue PMF volume (RMW window ≈ one-two REST round-trips; advance fires per song-end/skip; submits are sparse), **self-healing** (next action/poll reconciles ordering), and **not data-corrupting nor security-relevant**. So it stays **non-blocking** and does not gate this merge. But it should be **upgraded from "accepted theoretical LOW" to a named tracked follow-up** now that real callers exist and TICKET-9 rooms will multiply the surface: make `removeEntry` atomic (Redis `LREM` by serialized value, or a Lua/`MULTI` transaction) and `reorder` via a scripted transaction. Filed as FOLLOW-UP-A.

### 4. Admin UX as the 1am kill-switch — NIT, agree with sonnet

`hostAction` swallows non-2xx and network errors. Weighing severity for the kill-switch specifically: pause/skip/remove/reorder all mutate state the 3 s poll re-renders (the AO VIVO/Pausado chip, the queue rows), so a failed action gives **implicit** feedback within one poll — a host who taps Pausar and sees the chip stay AO VIVO knows it didn't take. `busy` disables buttons in-flight (no double-fire). Remove has a two-step inline confirm (good destructive affordance); skip has **no** confirm — correct call (frequent intentional action, mirrors `/tv` auto-advance; a per-skip confirm would be friction). The genuine gap is the missing **explicit 401/expired-session** signal (silent no-op instead of "sessão expirou, entre de novo"), but 12 h `maxAge` makes a mid-shift expiry unlikely within one night. Judgment: **NIT/LOW, not a blocker**; recommend the toast-on-non-2xx (esp. 401 → re-auth) sonnet flagged as NIT-2. Filed as FOLLOW-UP-B.

### 5. resolveRoomToken seam for TICKET-9 — genuinely single-seam, one honest caveat

All six call sites route through `resolveRoomToken(roomId)` / `requireHost(req, roomId)`; the token-lookup swap is truly localized, and cross-room isolation **already holds** (a cookie `HMAC(tokenA,const)` fails `verifySessionValue(roomB)` because `tokenB` differs → denied, no code change). Caveat for TICKET-9 to enter with eyes open — the session value does **not** encode `roomId` and there is a single shared cookie name `cantai_host`: (a) if TICKET-9 wants a host logged into multiple rooms simultaneously in one browser, it needs per-room cookie **names**, not just a lookup swap; (b) if it binds `roomId` into the session derivation for defense-in-depth, that changes the session shape and **invalidates all live cookies on deploy** → a one-time re-login per host (low impact, expected on a feature deploy). Neither is a defect here; the code comment's single-seam claim is accurate for the token-lookup change. Heads-up, not a finding.

### Follow-ups to file (all non-blocking)

- **FOLLOW-UP-A (concurrency):** make Upstash `removeEntry` (LREM) + `reorder` (Lua/MULTI) atomic before multi-venue scale — upgrade of the accepted store LOW now that live mutation callers ship.
- **FOLLOW-UP-B (UX):** surface a toast on host-action non-2xx, esp. 401 → re-auth prompt (sonnet NIT-2).
- **FOLLOW-UP-C (ops):** operator-runbook note — kill-switch is `HOST_TOKEN` rotation + redeploy (logs out all hosts); no per-cookie revocation by design.
- Already tracked: M-1 edge/Upstash-backed global throttle; App Tester mobile tap-target on ▲/▼.

### Verdict (opus, merge-counting)

`[reviewer] APPROVE (opus, D-022 merge-counting) — TICKET-7 host controls. Independently reproduced 117/117 unit tests + terminal-green CI (Vercel pass). PUBLIC-REPO recheck clean: no obscurity dependence (HMAC strength rests on HOST_TOKEN entropy alone), dev fallback genuinely dead in prod (Vercel NODE_ENV=production on every deployed env incl. public previews → resolveRoomToken null-locks), no real tokens in diff/fixtures/evidence/history. Session lifecycle acceptable for a single-host shift (12h + rotation-as-only-kill-switch; runbook note filed). Concurrency: non-atomic remove/reorder RMW vs LPOP/RPUSH can resurrect the just-played head or drop a concurrent submit — real now that live callers ship, but low-probability + self-healing + non-corrupting at PMF; upgraded to a tracked atomicity follow-up, not a blocker. hostAction silent non-2xx is a NIT (3s poll gives implicit feedback; 401-toast follow-up filed). resolveRoomToken is a genuine single-seam for TICKET-9. No blocking findings; all gates aligned.`

---

## Nits (non-blocking)

**NIT-1.** `_clearLoginThrottle` is exported from `lib/host-auth.ts` at module level without a test-environment guard. It's safe (server-only module, cannot reach the client), but a test-only helper living in production code is slightly untidy. A `/* test-only */` comment or a conditional `if (process.env.NODE_ENV !== "production")` guard would make intent explicit. Not a security risk — noting for future hygiene.

**NIT-2.** `hostAction` in the admin page swallows all fetch errors and non-2xx responses silently (`catch { }` and no status check). If a session expires mid-session (12h max age, so unlikely during a single venue night), the host gets a silent no-op instead of a re-auth prompt. The polling reconciliation eventually sends them back to the gate if the session probe fails, but there is no immediate feedback. A follow-up UX improvement (toast on 401 from host actions → trigger re-auth) would improve operator experience. Non-blocking — current behavior is documented.

**NIT-3** (already filed by App Tester). Reorder buttons `▲`/`▼` have correct `aria-label` attributes (`"Subir Alice"`, `"Descer Alice"`) but the visual tap target is the single Unicode character in a default-sized button. On an actual touch device the ~24px hit area is borderline. Ticket filed per App Tester PASS.

---

## Friction (class-level note, W6)

The memory-driver route-compilation singleton reset under `next dev` (first hit of an uncompiled route wipes in-memory state) required both a `warmUp()` helper in the e2e spec and a manual warmup during App Tester live testing. A shared test utility exported from a test-helper module (e.g. `e2e/lib/warm-up.ts`) that any future spec can import would prevent this from being rediscovered. Candidate for a framework friction note / follow-up ticket once a second e2e suite encounters the same need.

---

## Evidence relied upon

- `work/reports/testing/TICKET-7-app-test.md` — full flow + 11 screenshots
- `work/reports/security/TICKET-7-security.md` — timing-safe, HMAC, cookie, throttle, bundle audit
- `work/reports/dev/TICKET-7.md` — implementation log, self-verification, AC mapping
- Own: `npm test` (117/117), `npm run build` (clean), `grep .next/static` (empty), full PR diff read locally

---

## Verdict

`[reviewer] APPROVE — TICKET-7 host controls. 117/117 unit tests pass (independently verified), build clean, token absent from client bundle, CI green. Security keystone (lib/host-auth.ts) is correctly implemented: timing-safe length-leak guard, HMAC session with rotation invalidation, production fail-closed, dev fallback dead in prod (server-only + NODE_ENV runtime gate), throttle window/eviction/reset correct, cookie set/clear paths consistent via constant. All 6 host routes enforce requireHost-first, input-validated, idempotent where appropriate. Admin page state machine, two-step confirm, inert mode-switcher, and pure stats function all meet the ticket spec. AC#4 TV player-freeze is explicitly scoped out (backend+flag shipped; TV surface deferred to post-#9 per ticket design). Two non-blocking nits filed (_clearLoginThrottle export hygiene, hostAction silent swallow); App Tester mobile tap-target nit already filed.`
