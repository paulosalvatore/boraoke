# TICKET-30 — i18n framework + language switcher — Dev report

- **Status:** COMPLETE — foundation + final contested-surface sweep done (rebase-last window executed after #21/#22/#24 merged). PR #23 undraft-ready.
- **Branch:** `ticket/30-i18n` · **Worktree:** `.worktrees/ticket-30` · **App port:** 3030 requested but OCCUPIED by another product's dev server — used **3230** for local e2e (note in Friction).
- **PR:** https://github.com/paulosalvatore/boraoke/pull/23

## Framework choice + URL decision
**next-intl 4.13.1, App Router, WITHOUT i18n routing.** Locale in the `NEXT_LOCALE` cookie (resolution: cookie → room default language → `Accept-Language` → pt-BR). **Zero URL changes** — rooms stay `/<room>`, no `[locale]` segment, no middleware. Documented in `i18n/locales.ts` header + `next.config.ts` comment.

## What's implemented (this PR — non-contested)
- **Infra:** `i18n/locales.ts` (pure resolution fns), `i18n/request.ts` (getRequestConfig, cookie+Accept-Language), `i18n/set-locale.ts` (server action), next-intl plugin in `next.config.ts`, `NextIntlClientProvider` + dynamic `<html lang>` in `app/layout.tsx`.
- **Catalogs:** `messages/{pt-BR,en,es}.json` — FULL (all surfaces incl. contested), pt-BR source of truth; en/es authored natural + party-host voice.
- **Metadata:** `app/generate-metadata.ts` (locale-aware title/description/OG image, pt-BR fallback) split from CJS-testable `app/metadata.ts`; `ogImageForLocale` helper.
- **Switcher:** `components/LanguageSwitcher.tsx` (+`.module.css`) — globe pill, native names, no flags, popover/bottom-sheet, logical-properties CSS (RTL pre-work). Live on `/new`.
- **Room language (additive):** `RoomSettings.language?` + `get/setRoomLanguage` in `lib/rooms.ts`; `POST /api/host/language` (host-authed, mirrors `/api/host/mode`).
- **Extracted now:** `/new` (full), `FeedbackWidget` + `FeedbackSheet` (full), rooms API user-facing 429/503 errors (server `getTranslations`).

## Implementation log (commit SHAs)
- `827ea0f`→ infra + /new + catalogs + switcher + room-lang model + plan + audit (first commit).
- feedback + rooms errors + i18n tests (locale/room-lang/completeness) + metadata split + next-intl-server jest mock.
- e2e language-switcher spec (this commit).
(SHAs on the PR branch; see `gh pr view 23`.)

## Self-verification (proof, not prose) — FINAL (post-sweep)
- **Unit:** `npx jest` → **443 passed / 30 suites** (incl. i18n-locales, i18n-completeness [CI gate: key + ICU placeholder parity across all 3 catalogs — re-verified after the sweep's catalog patch], room-language, metadata OG fallback, plus main's merged suites).
- **Rotation-engine:** `node --test` → **59 passed** (additive refusal-code change did not touch the engine).
- **Build:** `npm run build` → GREEN.
- **E2E:** full suite → **39 passed** (34 base + 4 switcher + 1 net new from merged specs), suite pinned to pt-BR.
- **Note on the CI-green gate:** boraoke's gate is `.github/workflows/ci.yml` (rotation-engine `node --test` + build + `npm test` + Playwright e2e). All four verified locally green post-sweep.

## Contested-components sweep — DONE (rebase-last window, 2026-07-08)
Merged `origin/main` (conflicts: `app/new/page.tsx` imports — kept both; events jsonl UNION). Then:
- [x] `PatronRoom.tsx` — all ~26 EN strings → `Patron` catalog; switcher on gate + header; rich `queueForVenue`/`playerHint`; ICU `queueCount`; localized mode names (`Modes` + `MODE_MESSAGE_KEY`). Kept #40's jump-to-CTA intact.
- [x] `SongSearch.tsx` — `Search` catalog incl. degraded copy (single key, live pt-BR verbatim) + paste-link sentinel via `t("youtubeLink")`.
- [x] `TvScreen.tsx` — `Tv` catalog incl. #24's NEW `skipNotice` ("Pulando vídeo indisponível…"); `/[room]/tv` wraps in a room-language-scoped `NextIntlClientProvider` (TV follows the ROOM, never a user cookie; pt-BR when unset). Watchdog logic untouched.
- [x] `app/page.tsx` + `SavedRooms.tsx` (#22's card) — `Landing` catalog (+ NEW `saved*` keys) + switcher.
- [x] `AdminRoom.tsx` + `ModeSwitcher.tsx` — `Admin`/`Modes` catalogs incl. #22's NEW `sessionExpired`; NEW room-language selector card (native names, optimistic POST `/api/host/language`, seeded from `getRoomLanguage` by the server page).
- [x] Patron server page — `RoomNotFound` localized; room default language override when the visitor has NO cookie (design §3 order: cookie → room → Accept-Language → pt-BR).
- [x] API errors per request locale: search 429; queue 429 (`submitRateLimited`, live pt-BR verbatim), 409s (rotation.ts gains ADDITIVE `code`+`cap` refusal fields; pt-BR `message` stays the lib source/test surface), queue-full 429 (was ENGLISH in prod — now localized).
- [x] e2e suite pinned to `locale: "pt-BR"` (deterministic baseline; Playwright's en-US default would flip the app to EN via Accept-Language); patron-page assertions updated from the old English copy to the now-correct pt-BR.

### New strings from the merged PRs — authored en/es (party-host voice)
- `Tv.skipNotice` (#24), `Admin.sessionExpired` (#22), `Landing.savedTitle/savedHint/savedEnter/savedAdmin/savedTv/savedForget` (#22), `Errors.queueFull` + 5 submit-refusal keys, `Patron.notFound*` (4 keys), `Tv.table`. pt-BR reconciled verbatim to live copy where they differed (`Search.label`, `Errors.submitRateLimited`); dropped unused keys (`positionHero`, 3 degraded variants, `noResults`).

## Translation coverage
- **Whole app: 100% extracted + wired + translated** (3/3 locales, CI-completeness-gated: key parity + ICU placeholder parity). Every user-facing surface (landing, /new, patron, TV, admin, feedback, API errors) renders from the catalogs. Technical 4xx guards (malformed body, invalid uuid…) stay English by documented decision (never surfaced by a working UI).
- Known scoping note: the Feedback FAB lives in the root layout (outside room-scoped providers) so it follows the USER locale even when a room override is active — deliberate (app chrome follows the user).

## Friction
- **Port 3030 collision:** the assigned app port was already held by another product's `next dev` (served desapega's 404 page). Had to hunt a free port (3230). A `port-allocate` skill / per-product port ranges would prevent this.
- **Memory-driver first-compile resets** bit the evidence script twice (room/hash lost when a later route compiled): warmed all routes first — same caveat the e2e warmUp already documents.
- **next-intl ESM under ts-jest:** `next-intl/server` is ESM and breaks CJS jest on import. Resolved by (a) splitting `generateMetadata` out of the testable `metadata.ts`, (b) a `__mocks__/next-intl-server.ts` stub mapped in jest config (returns real pt-BR copy so route tests still assert user-facing strings).
