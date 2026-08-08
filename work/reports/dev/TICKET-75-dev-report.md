# TICKET-75 — Dev report

Branch: `ticket/75-room-language-seed` (worktree `.worktrees/ticket-75`, off `origin/main` @ `a2c47bc`).

## Diagnosis verification (done before touching anything)

Every claim in the brief was re-checked against the code, and all held:

| Claim | Verified |
| --- | --- |
| `/[room]/tv` follows the ROOM's language, by design | `app/(patron)/[room]/tv/page.tsx` — `const locale = await getRoomLanguage(room)`, wrapped in a scoped `NextIntlClientProvider`; intent documented at `i18n/request.ts:8-13` |
| `createRoom` never writes `language` | `lib/rooms.ts` — the record literal was `settings: { mode: DEFAULT_ROOM_MODE }`, no `language` key on any path |
| So every room reads back pt-BR | `getRoomLanguage` → `normalizeLocale(room?.settings?.language)` → `normalizeLocale(undefined)` → `DEFAULT_LOCALE` |
| Only the admin dashboard ever set it | `setRoomLanguage` is the sole writer of `settings.language`; its only caller is the host-authed admin route |
| `<html lang>` follows the COOKIE locale app-wide | `app/layout.tsx` — `const locale = await getLocale()` (i18n/request.ts → NEXT_LOCALE / Accept-Language), so it disagrees with the TV subtree's room-locale messages |

The existing test `room-language.test.ts` even asserted the bug's mechanism as intended behaviour ("the additive field is NOT written on creation"). That assertion is still true and still passes — the field is only written when a locale is explicitly supplied.

## Changes

1. `lib/rooms.ts` — `createRoom(name, creatorUuid?, language?: Locale)`; seeds `settings.language` only when `isLocale(language)`, otherwise omits the key entirely.
2. `app/api/rooms/route.ts` — reads + validates the creator's `NEXT_LOCALE` cookie and passes it through.
3. `i18n/locales.ts` — new `documentLangScript(locale)` helper (normalized + JSON-encoded, single-sourced).
4. `app/(patron)/[room]/tv/page.tsx` — emits that script from the same resolved room locale it feeds the message provider.
5. Tests: `__tests__/room-language.test.ts`, `__tests__/api-rooms.test.ts`, new `__tests__/tv-html-lang.test.ts`.

`app/layout.tsx` is **untouched** (`git diff --stat` proves it) — the mismatch is corrected inside the TV route, as required.

## Verification (observed output)

**`npm test`**

```
Test Suites: 44 passed, 44 total
Tests:       712 passed, 712 total
Snapshots:   0 total
Time:        12.524 s
```

**`npx tsc --noEmit`** — measured as a DELTA against `main`, `tsconfig.tsbuildinfo` deleted on both sides:

```
main (stashed):   2230 error lines
branch:           2292 error lines
```

The +62 lines are 100% artifacts of the pre-existing missing-`@types/jest` baseline in my added test blocks — `Cannot find name 'expect'/'describe'/'it'` plus the `TS7006` "implicitly any" callback params that follow from an untyped `it.each` (`main` already carries 15 of those same TS7006s). Filtering the diff for new errors under `app/`, `lib/`, `i18n/`, `components/` returns **zero**:

```
$ diff <(sort tsc-main.txt) <(sort tsc-75.txt) | grep '^>' | grep -E "^> (app|lib|i18n|components)/"
(no output)
```

**`npm run build`**

```
✓ Compiled successfully in 5.2s
✓ Generating static pages (31/31)
```

**Full e2e suite** (`PORT=3187 npx playwright test`, foreground, 89 tests): see the "e2e" section below.

## e2e

First full run: **76 passed, 1 failed** in 9.7m — the failure was `render-and-links.spec.ts:261` aborting inside `warmUp` (`page.goto: net::ERR_ABORTED; maybe frame was detached?`), a Next-dev compile-time navigation abort. Re-running that file made a *different* pair of tests fail at the same `warmUp` helper, and each of those passed when run in isolation — a load-dependent dev-server flake (five sibling ticket worktrees were compiling on the same machine), not a behavioural failure. None of the affected assertions touch room language or the TV locale.

Final clean run on a freshly restarted dev server (`rm -rf .next`), full suite, foreground:

```
77 passed (5.2m)
```

Zero failures — confirming the earlier two failures were environmental.

## Gates

- **App Tester:** PASS on all five cases (`work/evidence/TICKET-75/README.md` + five screenshots). pt-BR/en/es each render in their own language with a matching `<html lang>`; a no-cookie room stores no `language` key and renders pt-BR. The decisive case E — a room created in `en` viewed by a browser carrying `NEXT_LOCALE=es` — still rendered **English** with `lang="en"`, proving the TV follows the ROOM and not the viewer.
- **Reviewer (opus, clean context):** `VERDICT: APPROVE`, no blocking findings — `work/reports/review/TICKET-75-review.md`. It re-derived the root cause independently, re-ran the suite itself (712 tests), and verified `app/layout.tsx` and every other sibling-owned file are untouched.
