# TICKET-30 — i18n framework (pt-BR/en/es) + language switcher — Plan

- **Date:** 2026-07-08 · **Author:** Dev agent · **Status:** Proposed (plan gate)
- **Branch:** `ticket/30-i18n` · **Worktree:** `.worktrees/ticket-30` · **App port:** 3030
- **Rebases LAST** (roadmap): TICKET-40 (SongSearch + patron form), TICKET-41 (TV components), TICKET-43 (landing + admin session UX) all touch the same component files on different lines. Build everything non-colliding now; do the full string sweep of contested components in the final rebase pass.

## Framework choice

**next-intl, App Router, WITHOUT i18n routing (no locale-prefixed URLs).**

Rationale:
- Room URLs MUST stay `/<room>` (design + ticket). next-intl's "without i18n routing" mode determines locale from a **cookie** (`NEXT_LOCALE`) via `getRequestConfig`, so **zero URLs change** — no `[locale]` segment, no middleware rewrite of room paths.
- House-quality default; first-class ICU (plurals + `selectordinal` for the position hero), server + client component support, build-time message loading, TypeScript augmentation.
- Locale resolution order (design §3): explicit user cookie → room default language → `Accept-Language` → `pt-BR`. Implemented in `i18n/request.ts`.

**No-URL-change decision is documented** in `docs/` (a short note in the PR body + a comment block in `i18n/request.ts`).

## Locale model

- Locales: `pt-BR` (source of truth), `en`, `es`.
- Cookie: `NEXT_LOCALE` (1 year, `SameSite=Lax`, `Path=/`). Set by a server action from the switcher.
- First-visit (no cookie): parse `Accept-Language`, match to a supported locale, else `pt-BR`.
- Room default language: additive `RoomSettings.language` (default `pt-BR`); when a patron/TV loads a room with no explicit user cookie, the room language wins over Accept-Language (per resolution order). TV **always** follows room language (no cookie, no switcher).

## Files touched

### Infra (new, nobody else touches)
- `next.config.ts` — wrap with `createNextIntlPlugin('./i18n/request.ts')` (additive; keep existing redirect).
- `i18n/request.ts` — `getRequestConfig`: resolve locale (cookie → Accept-Language → pt-BR), load messages. Room-language override is applied per-surface (see below) since request config can't see the `[room]` param cleanly; TV/patron/admin pages pass locale via a scoped provider when a room default differs and no user cookie is set.
- `i18n/locales.ts` — `LOCALES`, `DEFAULT_LOCALE`, native names, `NEXT_LOCALE` cookie name, `resolveLocale(acceptLanguage, roomLang?, cookie?)` pure fn (unit-tested).
- `i18n/set-locale.ts` — server action `setLocale(locale)` writing the cookie (validated against LOCALES).
- `messages/pt-BR.json`, `messages/en.json`, `messages/es.json` — message catalogs.
- `components/LanguageSwitcher.tsx` — globe pill + bottom-sheet/popover; native names; calls `setLocale`.
- `app/layout.tsx` — `<html lang={locale}>` (dynamic), `NextIntlClientProvider`.
- `app/metadata.ts` — `generateMetadata`-style per-locale OG lookup with pt-BR fallback (`og-image-<locale>.png`; only pt-BR exists now → fallback).

### Data model (additive)
- `lib/rooms.ts` — extend `RoomSettings` with `language?: Locale`; add `getRoomLanguage`/`setRoomLanguage` (mirrors `getRoomMode`/`setRoomMode`); default `pt-BR`; legacy records read back as default (no migration).
- `app/api/host/language/route.ts` — host-authed POST to set room language (mirrors `/api/host/mode`).

### Extract NOW (non-contested surfaces)
- `app/new/page.tsx` — fully mine. Extract all strings.
- `lib/rotation-modes.ts` `MODE_META` / `modeLabel` — shared vocab; move copy to messages (careful: consumed by contested admin/patron — extract the *source* now, wire consumers in rebase).
- `components/feedback/FeedbackSheet.tsx`, `components/FeedbackWidget.tsx` — feedback copy (non-contested).
- `app/api/**` user-facing error strings (search/rooms/queue/host) — the ones surfaced to UI. Technical 400 validation messages (malformed-request guards a normal user never trips) stay as-is / English (documented in audit); user-facing ones (rate-limit, "lotados", degraded reasons) become keys returned as codes the client maps, OR kept server-localized via `getTranslations`.
- Landing switcher placement + `<html lang>` wiring.

### Extract in FINAL REBASE (contested — audit only now)
- `app/page.tsx` (landing) — TICKET-43.
- `app/(patron)/[room]/PatronRoom.tsx` — TICKET-40. **The wrong-language surface** (heavy English).
- `components/SongSearch.tsx` — TICKET-40.
- `components/tv/TvScreen.tsx` — TICKET-41.
- `app/(patron)/[room]/admin/AdminRoom.tsx` + `ModeSwitcher.tsx` — TICKET-43.

## Message namespace design

Namespaces mirror surfaces: `Landing`, `New`, `Patron`, `Tv`, `Admin`, `Feedback`, `Modes`, `Errors`, `Lang`, `Common`. ICU:
- `Patron.queueCount` → `{count, plural, =0 {...} =1 {# música} other {# músicas}}`.
- Position hero → `{position, selectordinal, one {#º} other {#º}}` per locale (pt/es/en ordinal forms).

## Test strategy

1. **Unit** — `resolveLocale` (cookie > roomLang > Accept-Language > default; unsupported → default), cookie name constant, native-name map.
2. **Completeness (CI-enforced)** — a jest test asserts `en.json` + `es.json` have EXACTLY the same key set as `pt-BR.json` (deep key diff). Missing/extra key = red. This is the "missing translations can never ship silently" gate.
3. **Room language** — `get/setRoomLanguage` additive persistence + legacy default.
4. **Metadata** — per-locale OG lookup falls back to pt-BR when variant absent.
5. **e2e (Playwright)** — switch language on landing → strings change → reload persists (cookie); switcher shows native names; TV has no switcher.

## Risks

- **Rebase collision** is the headline risk — mitigated by design (audit-only on contested files now; the final sweep is mechanical string→`t()` replacement guided by the committed audit checklist).
- next-intl + Next 15 client/server provider boundary — the `NextIntlClientProvider` must wrap client trees; server components use `getTranslations`. Patron/TV/Admin are client components under server page wrappers — provider goes in root layout so all trees get messages.
- Server-localized API errors need the request locale; `getTranslations()` reads it from the same cookie/Accept-Language path, so API routes localize consistently.

## Rollout

Draft PR opened after first meaningful commit; marked REBASES-LAST. Full string sweep + e2e green before ready-for-gates. `verify-green-local.sh` GREEN before any gate request.
