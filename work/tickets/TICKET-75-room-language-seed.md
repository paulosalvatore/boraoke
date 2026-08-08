# TICKET-75 — Seed the room language from the creator's locale + fix the TV `<html lang>` mismatch

- **Product:** boraoke
- **Status:** in progress → PR
- **Reported by:** the Tech Lead — "https://boraoke.com/karaoke-party/tv — TV isn't following previously selected language" and "Room language should match user's selected language."

## Root cause (verified against the code, not assumed)

The TV route following the ROOM rather than the visitor is **correct and stays**: a venue screen is a different device from any patron's phone, and 40 phones with 3 locales cannot arbitrate one screen. That intent is documented at `i18n/request.ts:8-13` and implemented at `app/(patron)/[room]/tv/page.tsx` (`const locale = await getRoomLanguage(room)`).

The actual defect is that **the room's language was never populated**. `createRoom` wrote `settings: { mode: DEFAULT_ROOM_MODE }` and no `language` key, ever, so `getRoomLanguage` → `normalizeLocale(undefined)` → `"pt-BR"` for every room in existence. The room language the TV faithfully obeys was permanently pt-BR unless the host went into `/[room]/admin` and changed it by hand.

The TL's second report ("room language should match my selection") is the **same** root cause seen from the admin side — an English-speaking host opens the dashboard and reads "Idioma da sala: Português (Brasil)". The patron room route itself already follows the visitor's cookie correctly; that half was never broken.

**Independent bug found alongside it:** `app/layout.tsx` sets `<html lang>` from the cookie-driven REQUEST locale, while the TV subtree renders ROOM-locale messages. A visitor with `NEXT_LOCALE=es` opening a pt-BR room's TV got `lang="es"` on 100% Portuguese content — wrong for screen readers, browser auto-translate and SEO.

## Change 1 — seed `settings.language` at creation

- `lib/rooms.ts` — `createRoom(name, creatorUuid?, language?)`. The new third parameter is optional and is re-validated with `isLocale` **at the storage boundary**, so an untrusted value (a spoofed cookie, an untyped JS caller) can never land in stored room state. When it is absent or unsupported the key is omitted entirely and the written record is byte-identical to before.
- `app/api/rooms/route.ts` — reads the creator's `NEXT_LOCALE` cookie, validates it with `isLocale`, and passes it through. No cookie / unsupported value → `undefined` → unchanged behaviour.

**The admin override is untouched and still wins.** `setRoomLanguage` writes after creation, so a host's manual choice overwrites the seed — asserted in tests at both the store and the API level.

**Backward compatibility.** `language` remains optional and additive on `RoomSettings`; `getRoomLanguage` already normalizes an absent field to `DEFAULT_LOCALE`. Pre-existing rooms are never read-migrated and never written to — they keep rendering pt-BR exactly as today. No migration, no backfill.

## Change 2 — `<html lang>` agrees with the rendered copy on `/[room]/tv`

Fixed **inside the TV route**, without touching `app/layout.tsx` (a shared app-wide surface owned elsewhere; changing it would affect every route). The page emits `documentLangScript(locale)` — a new single-sourced helper in `i18n/locales.ts` — from the SAME resolved room locale it hands to `NextIntlClientProvider`, so the document language and the rendered messages cannot disagree by construction.

The script is inline in the SSR body and runs during HTML parse, before first paint and long before assistive tech or an auto-translate heuristic reads the document. The value is passed through `normalizeLocale` and JSON-encoded, so only a member of the fixed `LOCALES` set can ever reach the document (injection test included).

## Side effect worth knowing about (intended, by design)

`app/(patron)/[room]/page.tsx` already honored `settings.language` as the middle tier of the design §3 resolution order (explicit cookie → **room default** → Accept-Language → pt-BR). That tier was **dead code** in practice, because nothing ever wrote the field. Seeding it wakes it up: a patron with **no** locale cookie who joins a room created by an English-speaking host now sees the room in English instead of falling through to Accept-Language. That is exactly what the design specified, and an explicit user cookie still wins — so "the patron route follows the user's selection" is preserved.

## Adjacent issue NOT fixed here (out of scope, needs its own ticket)

The same `<html lang>` mismatch class exists on `app/(patron)/[room]/page.tsx`: when a cookie-less visitor is scoped to the room locale, the root layout still reports the Accept-Language locale. That file is outside this ticket's boundary (owned by another agent's scope), so it is flagged rather than touched. The fix is one line — reuse `documentLangScript(locale)` in the same branch that mounts the scoped provider.

## Tests

- `__tests__/room-language.test.ts` — seeding for each of pt-BR/en/es; omitted arg preserves the legacy record shape (no `language` key); unsupported values rejected at the storage boundary; mode untouched; **manual override wins** over the seed.
- `__tests__/api-rooms.test.ts` — cookie-driven seeding per locale through the real `POST /api/rooms`; absent cookie → pt-BR with nothing stored; spoofed/unsupported cookie values (`de`, `en-US`, `pt`, `xx`, ``, `%%%`) ignored; override still wins.
- `__tests__/tv-html-lang.test.ts` — `documentLangScript` contract, fallback, and hostile-value injection; plus lang/content agreement across a seeded room, a legacy room with no stored language, an overridden room, and an unknown room id.
