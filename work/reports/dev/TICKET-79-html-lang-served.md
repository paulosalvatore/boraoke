# Dev report — TICKET-79: serve the correct `<html lang>` per route

**Branch:** `ticket/79-html-lang-served` · **Worktree:** `.worktrees/ticket-79` · **Port:** 3196

## The problem, restated precisely

`<html lang>` lives in `app/layout.tsx`, the ONE root layout every route renders through, and it reads the next-intl **request** locale (`getLocale()` → `i18n/request.ts` → cookie / `Accept-Language` / pt-BR). But `/[room]/tv` deliberately renders **room-locale** messages: a venue screen serves a whole bar and cannot follow one patron's phone. So a visitor with an `es` cookie opening a pt-BR room's TV was served `lang="es"` on 100% Portuguese copy.

A root layout in the App Router cannot see the URL — Next gives it no `params` and no pathname — and it renders **before** its children, so no page deeper in the tree can influence the `<html>` element that has already been emitted. That is why TICKET-75, which could not touch `app/layout.tsx`, had to patch the attribute from an inline post-hydration script. The gap that left: with JS disabled (screen readers under some configurations, non-executing crawlers, `curl`/view-source), the **served** HTML still carried the wrong value. The same mismatch also went unfixed on `app/(patron)/[room]/page.tsx`.

## The locale chain, as established from the code (not assumed)

Read from `i18n/locales.ts` (`resolveLocale`), `i18n/request.ts`, `app/(patron)/[room]/page.tsx` and `app/(patron)/[room]/tv/page.tsx`. There are **three** distinct chains, and they are deliberately NOT one rule:

| Route | Chain |
|---|---|
| `/<room>/tv` — venue screen | **room language → pt-BR.** Never a cookie, never `Accept-Language`. |
| `/<room>` — patron page | **cookie → room default → `Accept-Language` → pt-BR** (design §3). |
| everything else (`/`, `/new`, `/admin`, `/admin/analytics`, `/<room>/admin`) | **cookie → `Accept-Language` → pt-BR.** Unchanged from before this ticket. |

`/<room>/admin` stays on the app-wide chain on purpose: the host console is a personal device and keeps following the host's own cookie. Only the *shared* screen is pinned to the room.

## The fix

The value the root layout renders is made **route-aware at its source**, upstream of every page, instead of being corrected downstream in the DOM.

1. **`middleware.ts` (new)** — the only supported way to get a pathname into a server component. It forwards `request.nextUrl.pathname` as `x-boraoke-pathname` and does nothing else: no rewrite, no redirect, no cookie read, no response mutation. It is explicitly **not** an i18n routing middleware — `i18n/locales.ts` records the standing decision that rooms stay `/<room>` with the locale in a cookie, and that is untouched. The matcher excludes `/api`, Next's build output and static assets.
2. **`i18n/route-locale.ts` (new)** — pure, edge/client-safe classification of a pathname into `tv` / `room` / `app`. It mirrors `lib/rooms`'s room-id vocabulary rather than importing it (`lib/rooms` is `server-only`, the middleware is edge), with a drift-guard test pinning the mirror against the real `isValidRoomId` / `RESERVED_ROOM_IDS`.
3. **`i18n/resolve-request-locale.ts` (new)** — the three chains as one async function with explicit inputs, so it is unit-testable without a live Next request context.
4. **`i18n/request.ts`** — now calls that resolver instead of `resolveLocale` directly.
5. **`app/(patron)/[room]/tv/page.tsx`** — the TICKET-75 inline script is **removed**, together with the now-dead `documentLangScript` helper in `i18n/locales.ts`.

`app/layout.tsx` is **not modified at all**. That is the deliberate risk posture: the root layout is shared by every route, and its `generateMetadata` / `viewport` re-exports (TICKET-74) are load-bearing. Making `getLocale()` itself correct means the layout keeps its single line of code and every route — including the ones this ticket is not about — gets the right value by construction.

### Two safety properties worth naming

- **Fail-soft.** `classifyLocaleRoute` is total: an absent, malformed or hostile pathname classifies as `app`, i.e. exactly the pre-TICKET-79 behavior. A stripped header can degrade to the status quo; it can never leak a *wrong room's* language.
- **The room tier reads the RAW stored `settings.language`, never `getRoomLanguage`.** The latter normalizes an absent field to pt-BR, which would silently swallow the `Accept-Language` tier for every legacy room that never set a language. `__tests__/served-lang.test.ts` has a named regression guard for exactly this.

### Why removing the inline script does not regress anything

The script's only job was to make the live DOM's `lang` agree with the room locale. That value now arrives in the server response itself, which is a strict superset of what the script covered (it also covers the JS-disabled and non-executing-crawler cases the script could not). The room-scoped `NextIntlClientProvider` on both the TV and patron routes is **kept** — it is what makes the *messages* room-scoped, and it means content and `lang` still agree even in the degenerate case where the pathname header never reaches the request config.

## Tests

- `__tests__/route-locale.test.ts` — classification matrix + the `lib/rooms` drift guard.
- `__tests__/served-lang.test.ts` — the full per-route precedence matrix, including "same room, same visitor, different route → different lang" (the chains must stay distinct), the raw-`settings.language` regression guard, and the no-pathname degradation case.
- `__tests__/tv-html-lang.test.ts` — TICKET-75's scenarios, re-pointed at the server-side resolver, plus explicit "never follows a cookie / never follows Accept-Language" assertions.
- `e2e/served-lang.spec.ts` — the one with real teeth: **raw HTTP GETs, never a browser page**, asserting the `lang` attribute in the response body per route. TICKET-75's client-side script would pass a `page.goto` check and fail every assertion in this file. It also asserts the script string is gone, that the TV's copy really is in the declared language, and re-checks the TICKET-74 metadata guard end to end.
