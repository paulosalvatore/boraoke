# TICKET-79 — Reviewer gate report

**Verdict: APPROVE WITH COMMENTS**

Branch `ticket/79-html-lang-served` (`49b0067`), reviewed against `origin/main` in `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-79`.

The approach is right, the three precedence chains are preserved and provably distinct, the inline client-side patch is genuinely gone, and the served HTML is correct over raw HTTP on every route I tested. There is one real correctness hole (F1, MEDIUM) that I reproduced live: the middleware matcher's `api` exclusion is an unanchored prefix, so a mintable room slug beginning with `api` gets no pathname header and its TV silently reverts to the pre-TICKET-79 bug. It is a one-token fix plus one test. Everything else is nits.

---

## 1. The locale chain, re-derived from source

Derived from `i18n/locales.ts`, `app/(patron)/[room]/page.tsx`, `app/(patron)/[room]/tv/page.tsx`, `app/(patron)/[room]/admin/page.tsx` and `lib/rooms.ts` **before** reading `i18n/resolve-request-locale.ts`.

The app runs next-intl **without** i18n routing — locale lives in the `NEXT_LOCALE` cookie, never in the path (`i18n/locales.ts:10-14`). `<html lang>` is set once, in the one root layout, from `getLocale()` (`app/layout.tsx:21-23`). Pages then override *messages* for their subtree with a scoped `NextIntlClientProvider`. So there are three de-facto chains, one per surface:

| Surface | Chain (highest precedence first) |
|---|---|
| `/<room>/tv` — venue screen | **room language → pt-BR.** `tv/page.tsx:44` calls `getRoomLanguage(room)`, which is `normalizeLocale(room?.settings?.language)` (`lib/rooms.ts:424`) — an absent record or absent field reads pt-BR. No cookie tier, no Accept-Language tier, by design: one screen serves a whole bar. |
| `/<room>` — patron page | **cookie → room `settings.language` → Accept-Language → pt-BR.** `[room]/page.tsx:53-62` mounts the room-locale provider only when the cookie is absent *and* `record?.settings.language` is truthy; otherwise it falls through to the app-wide config, which is `resolveLocale({cookie, acceptLanguage})`. Critically it reads the **raw** `settings.language`, not `getRoomLanguage` — so a legacy room that never set a language falls through to Accept-Language rather than being pinned to pt-BR. |
| everything else — `/`, `/new`, `/admin`, `/admin/analytics`, `/<room>/admin` | **cookie → Accept-Language → pt-BR.** No room tier. `[room]/admin/page.tsx` mounts no provider: the host console is a personal device and follows the host's own cookie, unlike the shared TV. |

`resolveLocale` (`i18n/locales.ts:118-128`) skips any tier whose value is not in the fixed `LOCALES` enum, so an unsupported value is ignored rather than honoured.

**The implementation matches this exactly.** `resolveRequestLocale` (`i18n/resolve-request-locale.ts:39-64`) reproduces all three chains, keeps them distinct, and preserves the raw-vs-normalized distinction (`getRoomLanguage` for `tv`, `record?.settings.language` for `room`) — which is the subtle part and the author got it right, with an explicit regression test for it (`__tests__/served-lang.test.ts:80-89`). **No precedence anywhere was changed or flattened.** The scoped message providers are left in place, so lang/content agreement survives even if the header never arrives.

## 2. Per-route observed `lang`, raw HTTP

Dev server on `127.0.0.1:3196` from this worktree. All routes warmed first; room record re-confirmed via `GET /api/rooms?id=…` before **and** after the assertions (`settings.language = "en"` both times). `lang` and page copy extracted from the same response body. No browser, no JS.

Room `reviewer-room-79`, `settings.language = en`.

| Route | cookie | Accept-Language | observed `lang` | expected | ✓ |
|---|---|---|---|---|---|
| `/` | — | — | pt-BR | pt-BR | ✓ |
| `/` | es | — | es | es | ✓ |
| `/` | — | en-US,en;q=0.9 | en | en | ✓ |
| `/` | es | en-US,en;q=0.9 | es | es (cookie wins) | ✓ |
| `/new` | (same 4 cases) | | pt-BR / es / en / es | same | ✓ |
| `/admin` → 307 `/default/admin` | (same 4 cases) | | pt-BR / es / en / es | same | ✓ |
| `/admin/analytics` | (same 4 cases) | | pt-BR / es / en / es | same | ✓ |
| `/reviewer-room-79` | — | — | **en** | room default | ✓ |
| `/reviewer-room-79` | — | es-ES,es;q=0.9 | **en** | room outranks header | ✓ |
| `/reviewer-room-79` | es | — | es | cookie outranks room | ✓ |
| `/reviewer-room-79` | pt-BR | — | pt-BR | cookie outranks room | ✓ |
| `/reviewer-room-79/tv` | — | — | **en** | room | ✓ |
| `/reviewer-room-79/tv` | es | — | **en** | room, never cookie | ✓ |
| `/reviewer-room-79/tv` | es | es-ES,es;q=0.9 | **en** | room, never either | ✓ |
| `/reviewer-room-79/tv` | pt-BR | pt-BR | **en** | room, never either | ✓ |
| `/reviewer-room-79/admin` | es | — | es | cookie (app chain) | ✓ |
| `/reviewer-room-79/admin` | — | en-US,en;q=0.9 | en | header | ✓ |
| `/reviewer-room-79/admin` | — | — | pt-BR | fallback | ✓ |
| `/default` | es | — | es | app chain (reserved) | ✓ |
| `/default` | — | en-US | en | app chain | ✓ |
| `/default/tv` | es | en-US | **pt-BR** | legacy room screen | ✓ |
| `/default/tv` | — | — | pt-BR | legacy room screen | ✓ |
| `/sala-nao-existe-rev79` | — | en-US,en;q=0.9 | en | unknown room → visitor chain | ✓ |
| `/sala-nao-existe-rev79` | es | — | es | cookie | ✓ |

**lang/content agreement in one document** — `GET /reviewer-room-79/tv` with `Cookie: NEXT_LOCALE=es`: `<html lang="en"`, body contains `Scan to join the queue` (1 hit), contains `Escaneia para entrar na fila` (0 hits), contains `documentElement.lang` (0 hits). This is exactly the bug TICKET-75 was filed for, now fixed in the served bytes.

**Header hygiene** — `x-boraoke-pathname` is not echoed on the response. The middleware uses `headers.set(...)`, not `append`, so a **client-forged** `x-boraoke-pathname` on a matched route is overwritten and ignored: I sent `x-boraoke-pathname: /reviewer-room-79/tv` with `Cookie: NEXT_LOCALE=es` to `/new` and got `lang="es"` (cookie), not `en`. Forgery is closed on every matched route. See F1 for the unmatched ones.

## 3. Findings

### F1 — MEDIUM (fix before merge) · the middleware matcher's `api` exclusion is an unanchored prefix, so `api*` rooms keep the TICKET-79 bug

`middleware.ts:35` — `matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)"]`.

`api` here matches any path whose first segment *starts with* `api`, not the `/api` route tree. `api` itself is in `RESERVED_ROOM_IDS`, but `api-bar`, `apiaca`, `apice` are **not reserved and are mintable** — a venue named "API Bar" or "Apiacás" slugifies straight into that space. Those requests skip the middleware, arrive with no pathname header, and `classifyLocaleRoute(null)` correctly degrades to the app-wide chain — which for a TV is precisely the bug this ticket exists to kill.

Reproduced live:

```
POST /api/rooms  {"name":"Api Bar"}  → id=api-bar, settings.language=en  (re-confirmed after warming)
GET /api-bar/tv   Cookie: NEXT_LOCALE=es          → <html lang="es"   (expected "en")
GET /api-bar      Accept-Language: es-ES,es;q=0.9 → <html lang="es"   (expected "en", room default)
```

Same root cause makes header forgery live on those paths: `GET /api-bar` with `Cookie: NEXT_LOCALE=es` and a forged `x-boraoke-pathname: /default/tv` returned `lang="pt-BR"`, i.e. the forged value steered the classification. Security impact is **nil** (the only reachable outputs are the three members of `LOCALES`, and nothing authorizes off it), but it confirms the matcher is the sole guard.

Degradation is safe in every case — never a *wrong room's* language, only the pre-ticket behaviour — which is why this is MEDIUM and not a blocker. Fix is one token plus a test:

```
matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)"]
```

(`/api` bare then gets the middleware, which is harmless — `api` is reserved and classifies as `app`.) Please add a `classifyLocaleRoute`/matcher test pinning that a room id merely *prefixed* `api` still reaches the room chain.

### F2 — LOW · the room record is now fetched twice per request

`resolveRequestLocale` calls `getPublicRoom(route.room)` (patron) or `getRoomLanguage(route.room)` (TV), and then the page component calls `getPublicRoom(room)` / `getRoomLanguage(room)` again for the venue name and message provider. On the in-memory driver that is free; on the Upstash driver it is a second network round-trip on the hot patron and TV paths. Wrapping the room read in React's `cache()` would dedupe it within a request. Not a correctness issue.

### F3 — LOW · the fix silently widens beyond `<html lang>` to page metadata

`app/generate-metadata.ts:18` also reads `getLocale()`. Making the request locale route-aware therefore changes `<title>`/`description`/`og:locale` on `/[room]` and `/[room]/tv` to follow the room's language too. I consider this *correct* — metadata now agrees with the copy, which is the same defect class the ticket targets — but it is a behaviour change the ticket text does not mention and the dev report does not call out. Worth one line in the PR body so it is not a surprise. Verified non-regressive: `og:locale content="pt_BR"` still renders on `/`, and the TICKET-74 `cantai` negative assertion still holds in the served HTML and in `__tests__/metadata.test.ts` (42 passed).

### F4 — LOW · the mirror drift-guard is one-directional

`i18n/route-locale.ts:54-60` hand-mirrors `RESERVED_ROOM_IDS`, deliberately (the module must stay edge-safe; `lib/rooms` is `server-only`). The guard test (`__tests__/route-locale.test.ts:92-96`) asserts every `RESERVED_ROOM_ID` classifies as `app`, but not the converse. Adding an entry to `RESERVED_FIRST_SEGMENTS` that is *not* reserved in `lib/rooms` would misclassify a real venue's patron page as app-wide and no test would catch it. `expect(new Set(RESERVED_FIRST_SEGMENTS)).toEqual(RESERVED_ROOM_IDS)` — export the constant and assert set equality.

### F5 — INFO · introducing middleware is justified; I checked the alternatives

This repo had none, so I looked for a way to avoid it. There isn't one. Next's App Router gives a root layout no `params` and no pathname, and the root layout renders before its children, so nothing downstream can influence the already-emitted `<html>` element — per-route `generateMetadata` cannot reach `lang` either. The one structural alternative, **multiple root layouts** via route groups, does not help here: `/[room]` and `/[room]/tv` live in the *same* group and need *different* chains, and it would cost a full page reload on every cross-group navigation. A middleware-forwarded request header is the sanctioned mechanism and is what next-intl itself documents for a no-routing setup. The implementation is minimal and correct: it never redirects, never rewrites, never reads cookies, never touches the response body, forwards the request unchanged plus one header, and `set` (not `append`) closes forgery on matched routes. `i18n/route-locale.ts` is genuinely dependency-free, so the edge bundle stays clean (`ƒ Middleware 34.1 kB` in the build output). API routes, static assets and any extension-bearing path are excluded, so `/robots.txt`, `/sitemap.xml`, `/icon.png` are untouched.

## 4. Inline script removal

`documentLangScript` is deleted from `i18n/locales.ts` and its call site in `app/(patron)/[room]/tv/page.tsx`. Grep over `app components i18n lib e2e __tests__` finds only comments plus the e2e's *negative* assertion (`e2e/served-lang.spec.ts:132`) — no live consumer. Nothing the script covered is lost: the only surface that emitted it was `/[room]/tv`, and the server value now covers it, including the legacy `/default/tv` case (`classifyLocaleRoute("/default/tv")` → `{kind:"tv",room:"default"}`, `getRoomLanguage("default")` → pt-BR, confirmed pt-BR over HTTP under an `es` cookie + `en-US` header). Note `default` is reserved for the **one-segment** form only, which is the right asymmetry: `/default` is a static-ish legacy page, `/default/tv` is a real venue screen.

## 5. Test quality

The tests assert the **server-rendered** value, not a client-corrected one. `e2e/served-lang.spec.ts` never calls `page.goto` — every case is a raw `pwRequest` GET whose body is regex-matched for `<html … lang="…">`, with a per-case isolated request context so cookies cannot leak between the cookie-sensitive and cookie-immune routes. That is exactly the JS-disabled view, and it is the property TICKET-75's script would have failed. The unit matrix (`__tests__/served-lang.test.ts`) pins all three chains *and* that they stay distinct (same room, same visitor, three routes, three answers), the header-absent degradation, and hostile pathnames. `__tests__/tv-html-lang.test.ts` carries every TICKET-75 scenario over to the resolver rather than dropping them.

## 6. Gates I ran

| Gate | Result |
|---|---|
| `npm test` | **47 suites, 827 tests, all passed** |
| `npx tsc --noEmit` | 2505 errors — see delta below |
| `npm run build` | **Success.** All routes compiled, `ƒ Middleware 34.1 kB` |
| `PORT=3196 npx playwright test` | **101 passed** (4.9m) |
| `npx playwright test e2e/served-lang.spec.ts` | 7 passed |

**tsc delta assessment — clean.** Errors attributable to this branch: `__tests__/route-locale.test.ts` 27, `__tests__/served-lang.test.ts` 39 (≈66 total). Every one is the repo's pre-existing `@types/jest`-not-installed baseline class — `TS2582 Cannot find name 'describe'/'it'`, `TS2304 Cannot find name 'expect'`, plus `TS7006` on an `it.each` callback parameter, which is a direct consequence of the same missing types. **Zero errors in `app/`, `i18n/`, `lib/`, or `middleware.ts`** — each of those files reports 0. The only non-`__tests__` error in the whole run is `e2e/advance-auth.spec.ts(12,60)` which is pre-existing and untouched by this branch.

**On the two e2e failures you may see reported elsewhere:** my first full run showed `advance-auth.spec.ts` failing 2/2 because it reused a pre-existing dev server on 3196 that was not started with `ADVANCE_AUTH=enforce` (playwright.config injects that env only when *it* spawns the server, and `reuseExistingServer` was true). I confirmed the env was absent on the running process, restarted so Playwright spawned its own, and got **101/101 green**. Environmental, not the diff.

## 7. Negative control — reproduced independently

I did not read `work/evidence/TICKET-79/negative-control.md`; I built two of my own.

**Control A — flatten the classifier.** Inserted an early `return APP_ROUTE;` at the top of `classifyLocaleRoute`, i.e. exactly the "the three chains got flattened into one" failure mode:

```
Test Suites: 3 failed, 3 total
Tests:       14 failed, 36 passed, 50 total
```

Failures were on the right behaviours, not incidental: *"NEVER follows a patron cookie — the whole point of the route"*, *"the legacy /default room's screen stays pt-BR"*, *"room default outranks Accept-Language"*, *"same room, same visitor, different route → different lang"*, and the classifier + drift-guard cases. Restored from a byte-copy; the three suites went back to **50 passed**.

**Control B — remove the middleware** (the "header never arrives" failure mode), then re-ran the e2e against the served HTML:

```
✘ the venue TV serves the ROOM's language, never the visitor's   Expected "en", Received "es"
✘ the legacy /default screen stays pt-BR for any visitor         Expected "pt-BR", Received "es"
✘ the patron room keeps its full chain                           Expected "en", Received "es"
3 failed, 4 passed
```

The three room-dependent tests go RED on the served value and the three visitor-chain tests correctly stay GREEN. Restored.

`git status` is **clean** — verified after each control and again at the end of the review. Both transient edits were reverted from byte-exact copies; no source file was left modified.

---

## Recommendation

Fix F1 (one-token matcher anchor + one test) and merge. F2–F4 are fine as follow-ups. F5 is informational: I went looking for a simpler mechanism than middleware and concluded there isn't one.
