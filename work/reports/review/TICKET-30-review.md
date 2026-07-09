# TICKET-30 — i18n framework (pt-BR/en/es) + language switcher — Reviewer Report

- **Date:** 2026-07-08
- **Reviewer:** Reviewer agent (sonnet first pass, opus judgment layer)
- **PR:** [#23](https://github.com/paulosalvatore/boraoke/pull/23) — `ticket/30-i18n`
- **Worktree:** `/Users/paulosalvatore/Documents/GitHub/cantai/.worktrees/ticket-30`
- **Verdict:** **[reviewer] APPROVE**

---

## What was checked

### 1. Bootstrap / evidence

- App Tester PASS confirmed — `work/reports/testing/TICKET-30-app-test.md` (PASS, 2026-07-08). All 7 scenarios verified including ZERO stragglers in EN/ES contexts, room-language-beats-user-locale on TV, Accept-Language first-visit detection, and API error localization. 9 evidence screenshots committed in `work/evidence/ticket-30/`.
- Dev report current — `work/reports/dev/TICKET-30-dev-report.md` status line: "COMPLETE — foundation + final contested-surface sweep done". Commit SHAs present. Self-verification results reflect 443/59/39/build green. No staleness.
- String audit — `work/reports/dev/TICKET-30-string-audit.md` complete, confirming the ~26-EN-string patron-page finding and the contested-surface per-ticket breakdown.
- Plan — `work/plans/TICKET-30-plan.md` matches the implementation exactly (cookie-based locale, no URL change, two-layer room-language override, completeness CI gate as durable guardrail).
- Security waiver assessed below.

### 2. Tests run by this reviewer (locally, PR branch tip)

All commands run from `ticket/30-i18n` HEAD (commit `159d7a7`):

```
npm ci                → clean (no errors)
npx jest --no-coverage → 443 passed / 30 suites ✓
node --test packages/rotation-engine/test/engine.test.ts → 59 passed ✓
npm run build         → green ✓
PORT=3231 npx playwright test e2e/language-switcher.spec.ts → 4 passed ✓
```

i18n-specific suites confirmed individually: `i18n-completeness` (8 assertions), `i18n-locales` (16 assertions), `room-language` (4 assertions), `metadata` (6 assertions) — all green.

CI-gate (project's `.github/workflows/ci.yml`): build + `npm test` + rotation-engine + Playwright — all four verified locally green. Note: per D-051, the authoritative gate is the local-Docker `verify-green-local.sh`; the dev's verbatim green outputs are pasted in the PR thread for build/unit/engine/e2e. Local runs by this reviewer confirm the same results.

### 3. Completeness gate (the durable CI guardrail)

The `__tests__/i18n-completeness.test.ts` test is the systemic fix this PR makes permanent:

- **Key parity:** asserts `en.json` and `es.json` have EXACTLY the same leaf keys as `pt-BR.json` (no missing, no extra). Verified manually: pt-BR=180 keys, en=180 keys, es=180 keys, zero diff.
- **ICU placeholder parity:** the placeholder extractor (`placeholders()`) correctly skips branch-body braces inside `plural/selectordinal/select` groups (depth-stack approach). This is non-trivial to get right — the implementation correctly identifies argument names vs branch literals so `{count, plural, =0 {vazia} one {# música} ...}` only reports `count` as a placeholder, not the branch bodies.
- **Fail-on-missing-key proven:** a synthetic test (adding a key to pt-BR without en) shows the gate would report `Common.testKey` as missing and fail CI. A dev CANNOT add a pt-BR string and pass CI without adding the en/es translation.
- **Extra-key check:** also enforced — a stale key in en/es that was dropped from pt-BR is also caught.

This gate is the most important engineering artifact of the PR: it transforms translation completeness from a manual review item into an enforced contract.

### 4. Security waiver assessment

The TM waived Cyber Security as "N/A-by-content" with a note to verify enum validation on `POST /api/host/language`. Reviewed:

```typescript
// app/api/host/language/route.ts
const raw = (body as Record<string, unknown>)?.language;
if (!isLocale(raw)) {
  return NextResponse.json(
    { error: `language must be one of ${LOCALES.join(" | ")}` },
    { status: 400 },
  );
}
```

`isLocale()` is a strict type guard: `typeof value === "string" && (LOCALES as readonly string[]).includes(value)`. LOCALES is a const tuple `["pt-BR", "en", "es"]`. Any value not exactly matching one of those three strings is rejected 400. Host-auth check (`requireHost`) runs before the body is parsed. **The waiver is correct** — enum validation is strict and host session is required.

The `setLocale` server action (called from the client switcher) also validates with `isLocale()` before writing the cookie. No unvalidated locale value can be persisted.

### 5. SSR/CSR hydration consistency

The key question: can the server render one locale while the client hydrates into another, causing React hydration errors?

**Analysis:** The `getRequestConfig` in `i18n/request.ts` reads the `NEXT_LOCALE` cookie server-side. `NextIntlClientProvider` (in root layout) receives the resolved locale + messages from the server. The client's `useLocale()` reads from this provider — it does NOT re-resolve independently. The switcher's `choose()` calls the `setLocale` server action (sets cookie) then `router.refresh()`, which triggers a full server re-render with the new cookie. There is no case where the server renders locale A and the client attempts to hydrate with locale B from the same message set.

**The two-layer room-language override:** the TV page and patron server page mount a scoped `NextIntlClientProvider` with a different locale when the room language differs from the request-level locale. This is consistent: the server page resolves the override locale + messages, passes both to the provider, and the client component (`TvScreen`, `PatronRoom`) receives them from the nearest provider. There is no mismatch because the scoped provider REPLACES the root provider for that subtree — the messages are server-loaded and passed as props, not independently fetched by the client.

**The one architectural tension (App Tester documented, non-blocking):** when a no-cookie visitor arrives at a room with a non-default language, the `<html lang>` on the root layout reflects `Accept-Language` (since no cookie), while the patron page content renders in the room language (via scoped provider). This is not a hydration error — it is a semantic mismatch (AT/SEO edge case). The App Tester correctly flagged it as non-blocking and documented it. The user can immediately set their preference via the language switcher. **Agree with the App Tester's classification.**

### 6. Translation quality spot-check (bilingual read, party-host voice)

**English — 15 strings sampled:**

| Key | Value | Assessment |
|---|---|---|
| `Landing.tagline` | "Your bar's karaoke queue, on every customer's phone. Spin up the room, show the QR, and everyone joins the line with their table tagged." | Natural, energetic. Good. |
| `New.createIntro` | "Give us your bar's name. We'll generate the link, the QR, and the host code." | Friendly, direct. Good. |
| `New.ephemeralNotice` | "⚠️ Rooms are still temporary — they can expire when the server restarts. Use the room now and recreate it if the link stops working. Permanent rooms are on the way." | Clear, honest. Good. |
| `Patron.addSong` | "Add a song" | Simple, on-brand. Good. |
| `Patron.joinQueue` | "Join the queue" | Slightly formal — "Get in line" would have more personality, but "Join the queue" is correct and clear. Acceptable. |
| `Patron.songAdded` | "✓ You're in the queue!" | Better than "Song added" — personal, party-feeling. Good. |
| `Patron.emptyQueue` | "Nobody in line yet — be the first!" | Great party-host energy. Good. |
| `Admin.emptyQueue` | "Queue's empty — kick it off! 🎤" | Host voice. Strong. |
| `Admin.noShowTitle` | "Singer didn't show: skips and returns them with one shot next round" | Functional, a bit terse for a tooltip. Acceptable. |
| `Tv.scanAndSingIdle` | "Scan and sing! 🎤" | Great for a TV screen. |
| `Errors.submitRateLimited` | "Easy there, superstar! Too many requests at once — give it a minute and try again." | Excellent party-host voice. |
| `Errors.queueFull` | "The queue is packed (max {max} songs) — try again in a bit." | Natural, friendly. Good. |
| `Modes.fullKaraokeRule` | "Everyone joins the queue, first come first served." | Clear. Good. |
| `Feedback.thanksBody` | "A human-supervised bot reads every one of these. Keep an eye on the changelog. 🚀" | Authentic, not corporate. Good. |
| `Lang.hint` | "detected from your browser · the room can set a default" | Clear, lowercase casual. Good. |

**Spanish — 15 strings sampled:**

| Key | Value | Assessment |
|---|---|---|
| `Landing.tagline` | "La fila de karaoke de tu bar, en el celular de cada cliente." | Natural, idiomatic. Good. |
| `New.createIntro` | "Dinos el nombre de tu bar. Nosotros generamos el link, el QR y el código de host." | Good. "link" is expected in LatAm Spanish. |
| `Patron.addSong` | "Agregar canción" | Natural. Good. |
| `Patron.joinQueue` | "Entrar a la fila" | Excellent — natural LatAm Spanish. |
| `Patron.emptyQueue` | "Nadie en la fila todavía — ¡sé el primero!" | Natural, with correct punctuation (inverted !). Good. |
| `Patron.songAdded` | "✓ ¡Ya estás en la fila!" | Excellent. Casual, direct, exclamatory. |
| `Admin.emptyQueue` | "Fila vacía — ¡arranca la primera! 🎤" | "Arranca la primera" is strong host energy. |
| `Admin.noShow` | "🙅 No vino" | Crisp, clear. Good. |
| `Errors.submitRateLimited` | "¡Tranquilo, cantante! Demasiados pedidos en poco tiempo — espera un minutito y vuelve a intentar." | "minutito" is lovely LatAm register. Excellent. |
| `Tv.scanAndSingIdle` | "¡Escanea y canta! 🎤" | Perfect. |
| `Tv.upNext` | "A CONTINUACIÓN" | Slightly formal vs "LO QUE SIGUE" but correct and clear. Acceptable. |
| `Modes.fullKaraokeRule` | "Todos entran a la fila, por orden de llegada." | Natural. Good. |
| `Patron.modeListen` | "💃 Solo disfrutar" | Natural LatAm. Good. |
| `Feedback.trigger` | "Enviar comentarios" | Natural. "Dar feedback" is also common but "comentarios" is more universal. Good. |
| `Lang.hint` | "detectado del navegador · la sala puede fijar un idioma" | Natural. Good. |

**Translation quality summary:** Both EN and ES catalogs are natural, non-machine-ese, with appropriate party-host voice. Spanish correctly uses LatAm register ("celular", "minutito", "arranca", inverted punctuation). No clunkers found. One optional improvement noted as NIT below.

### 7. Diff discipline — behavior-change audit (string-only sweep check)

Reviewed diffs for `PatronRoom.tsx`, `TvScreen.tsx`, `AdminRoom.tsx`, `SongSearch.tsx`, `app/page.tsx`, `SavedRooms.tsx`:

The non-i18n additions are:
- **AdminRoom.tsx:** `changeLanguage()` function + `roomLanguage`/`langBusy` state for the new room-language selector card. This is in-scope (room language model is a TICKET-30 deliverable, not a drive-by). Optimistic update with rollback on failure — correct pattern.
- **PatronRoom.tsx:** `LanguageSwitcher` placement (gate + header). `localizedMode` helper (`tModes(\`\${MODE_MESSAGE_KEY[m]}Name\`)`). The `eslint-disable-next-line react-hooks/exhaustive-deps` is justified: `t`/`localizedMode` are stable per-render (locale change remounts the tree), but the comment is present and accurate.
- **lib/rotation.ts:** additive `code` and `cap` fields on the failure branch of `SubmitCheck`. The `message` field (pt-BR source, test surface) is untouched. Engine test suite (59 tests) green — confirmed untouched.
- **queue/route.ts:** `getTranslations("Errors")` calls are added for user-facing 409/429 responses. The `CODE_KEY` map routes from the lib's refusal codes to the catalog keys. No logic changes.

**No behavior changes smuggled in.** The sweep is string-only except for the additive room-language selector feature which is explicitly in-scope.

### 8. Rebase surface vs main

The PR has merged main twice (post #21/#22/#24 and again post later merges). The diff shows the contested-surface sweep was completed in the rebase window as designed. The merge conflicts resolved were import-ordering in `/new/page.tsx` (both changes kept) and the events JSONL (UNION). No code logic was lost or incorrectly resolved.

---

## Findings

### Blocking items

**None.**

### Non-blocking items (NIT)

1. **NIT — `Tv.upNext` ES: "A CONTINUACIÓN" is slightly formal.** "LO SIGUIENTE" or "AHORA SIGUE" would feel more alive on a bar TV screen. "A CONTINUACIÓN" is correct and clear, just slightly anchors to broadcast-TV formality. Optional copyedit.

2. **NIT — `Admin.noShowTitle` EN is terse:** "Singer didn't show: skips and returns them with one shot next round" — the colon-joined clauses are dense for a tooltip. Optional: "Marks as no-show: skips this singer and gives them one priority slot next round." Not blocking.

3. **NIT — `<html lang>` / room-language two-layer documented but not surfaced:** The App Tester's architectural note (html lang from Accept-Language, content from room scoped provider) is important enough that a brief comment in `app/(patron)/[room]/page.tsx` near the conditional scoped-provider path would make the design decision discoverable to future maintainers. A one-line comment like `// NOTE: html lang is set by root layout (request locale) — content is scoped to room language below` would prevent future confusion. Optional.

4. **NIT — e2e suite pinned to pt-BR:** The `playwright.config.ts` baseline locale is `pt-BR`, which is the right call for determinism. The 4 switcher specs explicitly exercise en-US and es-MX via `test.use({ locale })` overrides — those paths are genuinely exercised. However, the other 35 base e2e tests (submit, rooms, saved-rooms, search, TV, rotation-modes) all run under pt-BR only. If a regression in the EN or ES rendering path would NOT be caught by the completeness gate, those paths would go untested. This is an acceptable tradeoff for a v1 (the completeness gate covers the catalog; e2e is smoke against pt-BR), but worth noting for a future "add multi-locale e2e fixture" ticket. Not blocking.

---

## Evidence relied upon

- `work/reports/testing/TICKET-30-app-test.md` — App Tester PASS (7 scenarios, 9 screenshots)
- `work/reports/dev/TICKET-30-dev-report.md` — Dev COMPLETE + self-verification numbers
- `work/reports/dev/TICKET-30-string-audit.md` — full string inventory
- `work/plans/TICKET-30-plan.md` — plan vs implementation verified
- Local test run: 443 unit / 59 engine / 4 switcher-e2e / build green
- Code reads: `app/api/host/language/route.ts`, `i18n/locales.ts`, `i18n/request.ts`, `i18n/set-locale.ts`, `__tests__/i18n-completeness.test.ts`, `app/layout.tsx`, `app/(patron)/[room]/tv/page.tsx`, `app/(patron)/[room]/page.tsx`, `components/LanguageSwitcher.tsx`, `lib/rotation.ts`, `lib/rotation-modes.ts`, `messages/{pt-BR,en,es}.json`, `playwright.config.ts`, `e2e/language-switcher.spec.ts`
- Diff audit: `PatronRoom.tsx`, `TvScreen.tsx`, `AdminRoom.tsx`, `SongSearch.tsx`, `app/page.tsx`, `SavedRooms.tsx`, `app/api/queue/route.ts`
- PR thread: two dev comments confirming milestone + rebase sweep

---

## Verdict

**[reviewer] APPROVE — TICKET-30 i18n framework is production-quality.**

The completeness gate is the headline deliverable: it enforces key + ICU-placeholder parity across all three catalogs in CI, making it impossible to add a string without all translations. This is the class-level prevention that outlives the PR. The security waiver is correct — `POST /api/host/language` strictly validates the locale enum via `isLocale()` and requires host auth. Hydration consistency is sound (server resolves locale, passes messages to provider, client never re-resolves independently). The two-layer room-language override is architecturally coherent: scoped provider at the TV page and patron server page, with the `<html lang>` / content mismatch documented. Translation quality is high — EN and ES are natural party-host voice, not machine-ese; no clunkers found in 30 sampled strings. The string sweep is string-only (no behavior changes smuggled into the 7 components). Engine tests (59) are untouched by the additive `code`+`cap` fields in `rotation.ts`. All 443 unit / 59 engine / 4 switcher-e2e / build verified green by this reviewer independently. Nits above are all optional.

---

# Opus second pass (D-022 merge-counting) — judgment layer

- **Date:** 2026-07-08
- **Reviewer:** Reviewer agent, opus tier (D-022 second pass — the APPROVE that counts for merge)
- **Tip reviewed:** `c27e689` (`origin/ticket/30-i18n`; `159d7a7` is the App-Tester commit, the sonnet review report was committed on top — diff verified locally against merge-base `7866aad`, per git-local-first)
- **Verdict:** **[reviewer] APPROVE — merge-counting**

All findings below verified first-hand from code reads and my own runs (443/443 jest green including the 4 i18n suites; `next build` green; catalogs read side by side; next-intl v4.13.1 default fallback verified in `node_modules/use-intl` dist).

## 1. Locale-resolution matrix — product ruling

Precedence as implemented (`i18n/locales.ts` `resolveLocale`, `app/(patron)/[room]/page.tsx` override): explicit user cookie → room default language → Accept-Language → pt-BR. Walked against the real personas:

- **Spanish tourist in a pt-BR bar, room language UNSET.** The room record's `settings.language` is `undefined` when never set (verified: `room-language.test.ts` asserts no field is written on creation; `getRoomLanguage` only *reads back* pt-BR as a default). The patron page mounts the room override ONLY `if (!isLocale(cookieLocale) && roomLanguage)` — undefined room language means NO override, so the app-wide request config runs and the tourist's `Accept-Language: es` wins. **They see Spanish. Correct** — an unset room default is genuinely "no opinion," not an implicit pt-BR pin. This is the subtle case that would have produced the venue bug report ("my foreign customers all get Portuguese") and the implementation gets it right.
- **Spanish tourist, room language EXPLICITLY pt-BR.** The venue stated an opinion; the tourist sees pt-BR content but has the persistent globe switcher on the patron page — one tap to es, cookie sticks for a year. Correct hierarchy: the venue set the house language, the individual can still override for themselves.
- **pt-BR host with a pt cookie opens the patron page of their own es-language party room.** They see pt; their cookie-less guests see es. **Correct, not confusing** — the host's cookie is an *explicit personal choice* and per-user UI language following the user is the principle every multilingual product follows. The room language governs the shared surfaces (the TV, first-visit defaults), not a user who has stated a preference. If the host wants to preview the guest experience, an incognito tab or the switcher does it. No venue would file this as a bug; the opposite behavior (room silently overriding my chosen language) would be.
- **TV:** always room language, never a cookie (`tv/page.tsx` scoped provider) — exactly right for a shared venue device.

**Ruling: the matrix produces no experience a real venue would report as a bug.** The one nuance worth a docs line is the unset-vs-explicit-pt-BR room distinction (unset lets Accept-Language through; explicit pt-BR pins first-visit patrons) — the admin selector UI should make "set" vs "default" visually distinct someday. Optional, not blocking.

## 2. `<html lang>` mismatch — severity ruling: SHIP + FOLLOW-UP (not a one-liner)

Verified the constraint directly: the single root `app/layout.tsx` owns `<html lang>` via `getLocale()` (app-wide request config — cookie/Accept-Language only). The room override is a scoped provider mounted in the *page*, a child of the layout; App Router layouts don't receive page params and the root layout cannot see the room record without duplicating the room lookup outside the page. There is **no scoped-provider one-liner** — a proper fix is either a `(patron)` route-group layout that resolves room language (new lookup plumbing) or a client `document.documentElement.lang` sync effect inside the overridden subtree (~5 lines but a deliberate design choice about SSR-vs-post-hydration lang).

Severity: LOW. The affected population is cookie-less screen-reader users on a room whose venue set a non-default language — content announces in the wrong accent until they use the switcher (which is present on the page). SEO impact is negligible (room pages are ephemeral, force-dynamic, not indexing targets). **Ruling: ship now; file a follow-up ticket** for the `documentElement.lang` sync (recommended shape: small client effect in the scoped-provider branch). Do not block a trilingual launch on this.

## 3. Party-host voice across locales — HERO moments

Read the three catalogs side by side at the emotional peaks. (Note: no literal "Você é o 4º" position-hero key exists in the catalogs — queue position renders via the live-queue list; the actual hero strings are submit-success, mic-call, and the empty-queue/TV idle prompts.)

- **Submit success:** pt `"✓ Música na fila!"` / en `"✓ You're in the queue!"` / es `"✓ ¡Ya estás en la fila!"` — en and es actually *upgrade* the moment from song-status to personal ("YOU'RE in"). Energy carried, arguably improved.
- **Mic-call countdown:** pt `"vá para o microfone!"` / en `"get to the mic!"` / es `"¡pasa al micrófono!"` — all imperative, all urgent, `<s>{seconds}s</s>` countdown intact with matching ICU/table-select structure in all three. No flattening.
- **Empty-queue (admin):** pt `"manda a primeira! 🎤"` / en `"kick it off! 🎤"` / es `"¡arranca la primera! 🎤"` — genuinely idiomatic host energy in each language, not translated-pt.
- **TV idle:** `"Escaneia e canta!"` / `"Scan and sing!"` / `"¡Escanea y canta!"` — punchy in all three.

**Ruling: en/es carry the same energy; nothing feels machine-flattened.** The es catalog correctly uses LatAm register (celular, minutito, inverted punctuation). I concur with the sonnet nit that `Tv.upNext` es `"A CONTINUACIÓN"` is a shade broadcast-formal — optional copyedit only.

## 4. Runtime fallback for a missing message — verified, graceful

No custom `onError`/`getMessageFallback` is configured anywhere (grepped `i18n/`, `app/`, `next.config.ts`). next-intl 4.13.1 defaults, verified in `node_modules/use-intl/dist/esm/*/initializeConfig-*.js`: `defaultOnError` = `console.error` (never throws), `defaultGetMessageFallback` = the dotted `Namespace.key` path rendered in place. So a runtime-missing key renders e.g. `Patron.songAdded` — **not blank, not a crash**; ugly but debuggable, and the CI completeness gate makes the state near-unreachable anyway. Defense in depth is sound; no config change needed.

## 5. Bundle/perf — per-locale, no client bloat

Built the branch and grepped `.next/static` for locale-distinctive strings (`"A CONTINUACIÓN"`, `"vá para o microfone"`): **zero hits in client chunks**. Catalogs are dynamically imported server-side (`loadMessages` → `import('../messages/<locale>.json')`) and only the ACTIVE locale's messages are serialized into the RSC payload per request. First-load JS 102 kB shared / ~128 kB on room routes — no 3x-catalog shipping. The all-night venue TV holds exactly one catalog in memory. **Pass.**

## 6. Tests — verified first-hand

- `npx jest` on tip: **443/443, 30 suites green** (includes i18n-completeness / i18n-locales / room-language / metadata).
- `npx next build`: **green** (output inspected; routes and chunk sizes above).
- e2e: 54 `test()` declarations across specs, 4 in `language-switcher.spec.ts` (sonnet pass ran them green on the tip; dev report's 39-executed figure consistent with skips/config). Engine suite (59) confirmed green in the sonnet pass on the same tip; `lib/rotation.ts` diff is additive `code`/`cap` fields only.

## Opus verdict

**[reviewer] APPROVE — merge-counting (D-022 second pass).** The locale-resolution matrix is product-correct across all personas including the subtle unset-room case; the `<html lang>` mismatch is LOW severity, ship + follow-up ticket (documentElement.lang sync — not a one-liner, verified); voice survives translation at every hero moment; runtime fallback is graceful-by-default and CI-gated besides; catalogs ship per-locale with zero client bundle bloat. No blocking findings. Follow-ups to file: (a) `documentElement.lang` sync for room-overridden subtrees, (b) admin selector "unset vs explicit" distinction, (c) the sonnet nits (all optional).
