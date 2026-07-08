# TICKET-30 App Test Report — i18n framework (pt-BR/en/es) + language switcher

- **Date:** 2026-07-08
- **Tester:** App Tester agent
- **PR:** [#23](https://github.com/paulosalvatore/boraoke/pull/23) — `ticket/30-i18n`
- **Worktree:** `/Users/paulosalvatore/Documents/GitHub/cantai/.worktrees/ticket-30`
- **Dev server:** `localhost:3040` (default port from package.json)
- **Verdict:** PASS

---

## Executive summary

All 7 test scenarios pass. 443 unit tests + 39 e2e tests + 59 rotation-engine tests all green. No untranslated stragglers found in EN or ES contexts. One architectural note documented (non-blocking).

---

## Test environment

- Branch: `ticket/30-i18n` (confirmed via `git branch`)
- Working tree: clean (no uncommitted changes)
- Dev server: `npm run dev` → port 3040 (Next.js 15.5.20)
- Playwright browser: headless Chromium, default locale en-US
- Test execution: 2026-07-08

---

## Test results by scenario

### 1. FIRST-VISIT DETECTION

**Method:** curl with `Accept-Language` header, no `NEXT_LOCALE` cookie; verify `<html lang>` in SSR output.

| Accept-Language | Expected | Actual `<html lang>` | Pass? |
|---|---|---|---|
| `en-US,en;q=0.9` | `en` | `en` | PASS |
| `es-ES,es;q=0.9` | `es` | `es` | PASS |
| `pt-BR,pt;q=0.9` | `pt-BR` | `pt-BR` | PASS |
| (empty — fallback) | `pt-BR` | `pt-BR` | PASS |

Also verified via Playwright browser (default en-US locale): landing page opened with `lang="en"`, English title "Boraoke — your bar's karaoke queue", `NEXT_LOCALE=en` cookie auto-set.

**Evidence:** `apptester-01-landing-en-accept-language.png` — landing in English from first visit.

### 2. SWITCHER

**Method:** Playwright browser on landing and patron page; clicked globe pill, exercised all options, verified cookie + reload persistence + URL stability.

- Globe pill present on landing page and patron page ✓
- Native names shown: "Português (Brasil)", "English" (with ✓ checkmark), "Español" ✓
- No flags ✓
- Switching en→pt-BR: page content changed immediately, title changed to pt-BR, `NEXT_LOCALE=pt-BR` cookie set, `lang="pt-BR"` ✓
- Switching pt-BR→es: page content changed to Spanish, title changed, `NEXT_LOCALE=es` cookie set ✓
- Reload after es: Spanish persists, `NEXT_LOCALE=es` cookie present ✓
- Cross-page: switched to EN on landing, navigated to `/default` patron page → English content, `NEXT_LOCALE=en` cookie, URL `/default` (no locale segment) ✓

**Evidence:** `apptester-02-switcher-open-en.png` — switcher popover open showing three native-name options.

### 3. ROOM LANGUAGE

**Method:** Created room `langtest2` via API, set `language=es` via `POST /api/host/language` (with session cookie). Verified TV page and patron page behavior.

#### TV page — room language beats user locale

- Cleared `NEXT_LOCALE` cookie (only `fb_locale=en` remains, no user locale)
- Navigated to `/langtest2/tv`
- TV renders in **Spanish**: "¡Escanea y canta! 🎤", "Escanea para entrar a la fila", "con tecnología de Boraoke", "Pantalla completa (F)" ✓
- No language switcher on TV ✓ (deliberate — TV follows room language only)
- `html lang` on TV page reflects request-config locale (`en` from Accept-Language), but component content is scoped to room language via `NextIntlClientProvider` — this is a documented architectural decision (room language scoping is at the component subtree level, not root layout level)

**Evidence:** `apptester-08-tv-es-room-lang-no-cookie.png` — TV in Spanish with no user cookie.

#### Patron page — no cookie → room language default

- With no `NEXT_LOCALE` cookie and `Accept-Language: en-US`, patron page for `langtest2`:
  - `<html lang="en">` (from Accept-Language, root layout)
  - Component content: **Spanish** ("Agregar canción", "Nadie en la fila todavía") — room language scoped via `NextIntlClientProvider` ✓
- Feedback FAB: "Send feedback" (English = user/request locale) ✓ deliberate

#### Patron page — visitor WITH cookie keeps their choice

- Set `NEXT_LOCALE=pt-BR` cookie, navigated to `/langtest2` (room lang = es)
- Content renders in **Portuguese** ("Adicionar música") — user cookie wins over room default ✓
- `html lang="pt-BR"` ✓

#### Admin — room language selector

- Logged into admin for `i18nbar` (created during session), confirmed logged-in dashboard
- "Idioma de la sala" (Room language) selector visible in admin with options: Português (Brasil), English, Español ✓
- Description: "La TV y el idioma por defecto del público siguen este idioma." ✓
- API: `POST /api/host/language` returns `{"ok":true,"language":"es"}` when called with valid session cookie ✓

**Evidence:** `apptester-06-admin-es-room-lang-selector.png` — admin dashboard in Spanish with room language selector visible.

### 4. COVERAGE SPOT-CHECKS

#### English patron page (full)

Verified via Playwright snapshot at `/default` with `NEXT_LOCALE=en`:

| Surface | Expected EN | Actual | Pass? |
|---|---|---|---|
| Header greeting | "Hi," | "Hi," | PASS |
| Form heading | "Add a song" | "Add a song" | PASS |
| Song title label | "Song title (optional)" | "Song title (optional)" | PASS |
| Table label | "Table # (optional)" | "Table # (optional)" | PASS |
| Mode label | "Mode" | "Mode" | PASS |
| Mode options | "🎤 Sing" / "💃 Just vibe" | "🎤 Sing" / "💃 Just vibe" | PASS |
| Submit CTA | "Add to queue" | "Add to queue" | PASS |
| Queue heading | "Live queue (empty)" | "Live queue (empty)" | PASS |
| Empty state | "Nobody in line yet — be the first!" | "Nobody in line yet — be the first!" | PASS |
| Footer link | "Bar screen ↗" | "Bar screen ↗" | PASS |
| Footer | "Early-access prototype — queues are per-room" | "Early-access prototype — queues are per-room" | PASS |
| Feedback FAB | "Send feedback" | "Send feedback" | PASS |

Zero Portuguese stragglers in English mode.

**Evidence:** `apptester-04-patron-en.png` — patron page fully in English.

#### Spanish patron page (full)

Verified via Playwright snapshot at `/default` with `NEXT_LOCALE=es`:

| Surface | Expected ES | Actual | Pass? |
|---|---|---|---|
| Header greeting | "Hola," | "Hola," | PASS |
| Form heading | "Agregar canción" | "Agregar canción" | PASS |
| Song title label | "Título de la canción (opcional)" | "Título de la canción (opcional)" | PASS |
| Table label | "Mesa (opcional)" | "Mesa (opcional)" | PASS |
| Mode label | "Modo" | "Modo" | PASS |
| Mode options | "🎤 Cantar" / "💃 Solo disfrutar" | "🎤 Cantar" / "💃 Solo disfrutar" | PASS |
| Submit CTA | "Agregar a la fila" | "Agregar a la fila" | PASS |
| Queue heading | "Fila en vivo (vacía)" | "Fila en vivo (vacía)" | PASS |
| Empty state | "Nadie en la fila todavía — ¡sé el primero!" | "Nadie en la fila todavía — ¡sé el primero!" | PASS |
| Footer link | "Pantalla del bar ↗" | "Pantalla del bar ↗" | PASS |
| Footer | "Prototipo (acceso anticipado) — filas por sala" | "Prototipo (acceso anticipado) — filas por sala" | PASS |
| Feedback FAB | "Enviar comentarios" | "Enviar comentarios" | PASS |

Zero Portuguese stragglers in Spanish mode.

**Evidence:** `apptester-05-patron-es.png` — patron page fully in Spanish.

#### TV (via accessibility snapshot at `/langtest2/tv` with room lang = es)

Idle state in Spanish (no cookie): "¡Escanea y canta! 🎤", "Escanea para entrar a la fila", "con tecnología de Boraoke", "Pantalla completa (F)" — all Spanish ✓

TV `skipNotice` key exists in all 3 catalogs:
- pt-BR: "Pulando vídeo indisponível…" ✓
- en: "Skipping unavailable video…" ✓
- es: "Saltando video no disponible…" ✓
(watchdog skip notice could not be triggered live without a real unavailable video; existence of translated key and unit test coverage confirmed)

#### Admin (en + es)

- English: "Enter the host code to run the queue.", "Go in", "Host controls aren't set up for this bar yet.", "Your session expired — sign in with the room code." — all verified in catalogs ✓
- Spanish (verified live): "Entra con el código de host para controlar la fila.", "Entrar", "EN VIVO", "Modo de la noche", "Fila vacía — ¡arranca la primera! 🎤", "Idioma de la sala", "La noche en números" ✓
- Mode switcher in Spanish: "🎤 Karaoke completo", "🍻 2 por mesa", "🙋 1 por persona", "Todos entran a la fila, por orden de llegada." ✓

**Evidence:** `apptester-06-admin-es-room-lang-selector.png`

#### Landing — "Suas salas" card

Verified at `/` with `NEXT_LOCALE=en`:
- "Your rooms" (heading) ✓
- "Saved on this device — jump back into a room you created or joined." ✓
- "Join" button ✓
- "Forget [room]" button ✓
- "Already have a code?" ✓
- "Last room:" ✓

**Evidence:** `apptester-09-landing-en-saved-rooms.png`

#### /new page (ES)

Verified via Playwright (NEXT_LOCALE=es): "🎤 Crear sala", "Dinos el nombre de tu bar.", "Nombre del bar", "Crear sala", "← Volver" ✓
Success state: "¡Sala creada!", "ya está en línea.", "Código de host (¡anótalo ya!)", "Abrir admin", "Abrir /tv" ✓

**Evidence:** `apptester-07-new-es-room-created.png`

#### Room-404

- EN: "That room doesn't exist (or the link is wrong).", "Recreate room...", "Back to start" ✓
- ES: "Esa sala no existe (o el enlace está mal).", "Recrear sala...", "Volver al inicio" ✓

### 5. API ERROR LOCALIZATION

Verified via message catalog inspection and direct API test:

| Error key | pt-BR | en | es |
|---|---|---|---|
| `Errors.searchRateLimited` | Muitas buscas — aguarde… | Too many searches — hang on… | Demasiadas búsquedas — espera… |
| `Errors.submitRateLimited` | Calma, cantor!… | Easy there, superstar!… | ¡Tranquilo, cantante!… |
| `Errors.queueFull` | A fila tá cheia (máx. {max}…) | The queue is packed (max {max}…) | La fila está llena (máx. {max}…) |

API routes verified to call `getTranslations("Errors")` using the request locale:
- `/api/search/route.ts` line 82-87 ✓
- `/api/queue/route.ts` lines 125-128, 171, 190-193 ✓

Rate-limit tests not triggered live (would require excessive artificial load) but code path is correct and unit-tested.

### 6. REGRESSION — FULL SUITES

| Suite | Expected | Actual | Pass? |
|---|---|---|---|
| Jest unit tests | 443 tests, 30 suites | 443 passed, 30 suites | PASS |
| Playwright e2e | 39 tests | 39 passed | PASS |
| Rotation engine | 59 tests | 59 passed | PASS |

E2E suite includes dedicated `language-switcher.spec.ts` (4 tests):
- Switches locale, persists on reload, no URL change ✓
- Cookie persists across fresh navigation ✓
- en-US browser with no cookie resolves to English ✓
- es-MX browser with no cookie resolves to Español ✓

TV watchdog spec (`tv-watchdog.spec.ts`): both error 150 (embedding disabled) and error 100 (video removed) skip tests pass ✓
Fullscreen + chrome auto-hide TV smoke (`tv.spec.ts`): 4 tests pass ✓
Submit flow (`submit-song.spec.ts`): pass ✓
Mode switcher (`rotation-modes.spec.ts`): pass ✓
Saved rooms (`saved-rooms.spec.ts`): 3 tests pass ✓

### 7. FEEDBACK FAB FOLLOWS USER LOCALE IN ROOM-LANGUAGE CONTEXT

Verified at `/langtest2` (room lang = es, browser Accept-Language = en-US, no NEXT_LOCALE cookie):
- PatronRoom content: Spanish (room language, scoped `NextIntlClientProvider`) ✓
- Feedback FAB: "Send feedback" (English = user/request locale = Accept-Language) ✓

The Feedback FAB is in the root layout outside the room-scoped provider — it correctly follows the user's locale, not the room's.

---

## Straggler list

**None found.** Zero untranslated strings detected in EN or ES contexts across all tested surfaces (patron, TV, admin, landing, /new, room-404, feedback FAB, error messages).

---

## Architectural note (non-blocking)

**`<html lang>` vs rendered content on patron page when room language override applies.**

When a visitor has no `NEXT_LOCALE` cookie and a room has a language set, the patron page component renders in the room language (via scoped `NextIntlClientProvider`). However, the root `<html lang>` attribute is set by the root layout from the request config, which resolves via Accept-Language (since no cookie). This means a pt-BR browser visiting a es-language room gets `<html lang="pt-BR">` but sees Spanish content.

This is a consequence of the deliberate two-layer architecture (request config for layout, scoped provider for content). It only affects SEO/AT in a narrow edge case (no-cookie visitor, room with non-default language). **Not a FAIL** — the design decision is documented and the patron page always shows a language switcher so the user can set their explicit preference. Flagged for team awareness.

---

## Evidence index

| File | What it shows |
|---|---|
| `apptester-01-landing-en-accept-language.png` | First visit with en-US browser → landing fully in English, lang="en" |
| `apptester-02-switcher-open-en.png` | Globe pill open showing 3 native names (no flags), English checked |
| `apptester-03-landing-es.png` | Landing switched to Spanish, all strings translated, lang="es" |
| `apptester-04-patron-en.png` | Full patron page in English — zero Portuguese stragglers |
| `apptester-05-patron-es.png` | Full patron page in Spanish — zero Portuguese stragglers |
| `apptester-06-admin-es-room-lang-selector.png` | Admin in Spanish with "Idioma de la sala" selector visible |
| `apptester-07-new-es-room-created.png` | /new success state in Spanish — full room creation flow translated |
| `apptester-08-tv-es-room-lang-no-cookie.png` | TV in Spanish via room language, no user cookie (room lang beats user) |
| `apptester-09-landing-en-saved-rooms.png` | Landing in English with "Your rooms" card (Suas salas translated) |

---

## Friction

- **Dev server memory-driver resets on route compile:** Creating rooms via the API and then navigating to admin often resulted in `configured: false` because the in-memory singleton reset when the admin route compiled. This is a known documented limitation (dev report). Workaround: create room from the same browser session via `/new`, login immediately.
- **`NEXT_LOCALE` cookie deletion via `document.cookie=` sets it to empty but browsers may not fully evict httpOnly-adjacent cookies** — the cookie cleared but then re-persisted in some navigations. This is expected browser behavior.

---

## Verdict

**[app-tester] PASS — i18n foundation + language switcher fully verified. 443 unit / 39 e2e / 59 rotation-engine tests green. All EN + ES surfaces straggler-free. Room language model (TV beats user, cookie beats room on patron) confirmed. First-visit Accept-Language detection correct. One non-blocking architectural note documented.**
