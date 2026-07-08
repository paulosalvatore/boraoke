# TICKET-30 — Full user-facing string audit

- **Date:** 2026-07-08 · **Author:** Dev agent · **Ticket:** TICKET-30 (i18n)
- **Purpose:** the TL's "review missing translated languages" — sweep every user-facing string on every surface, flag current-language, and mark what is in the WRONG language (post-rebrand). Source of truth locale = `pt-BR`; launch set = `pt-BR`, `en`, `es`.
- **Method:** read every route/component; classified each string as **pt-BR** (correct), **EN-WRONG** (English shipped on a pt-BR product — must be pt-BR then translated), or **technical** (validation error a normal user never trips; low priority, English acceptable but keyed).

## Headline finding — the patron page is half English (matches the UX audit flag)

`app/(patron)/[room]/PatronRoom.tsx` is the single biggest wrong-language surface. Post-rebrand it is a **pt-BR/EN mix**: the venue chip, mode hints, and TV-hint are pt-BR, but the entire song-submission flow and live-queue are **English**. Confirmed current state (verified 2026-07-08):

| String (current) | Location | Status | Correct pt-BR |
|---|---|---|---|
| `Karaoke queue for` | nickname gate | EN-WRONG | Fila de karaokê do/da |
| `Your nickname` | nickname gate label | EN-WRONG | Seu apelido |
| `e.g. Maria, Table 4 Guy…` | nickname placeholder | EN-WRONG | ex.: Maria, Mesa 4… |
| `Join queue` | nickname CTA | EN-WRONG | Entrar na fila |
| `Hi,` | header greeting | EN-WRONG | Oi, |
| `Add a song` | form heading | EN-WRONG | Adicionar música |
| `✓ Selected:` | selected hint | EN-WRONG | ✓ Selecionada: |
| `Song title (optional)` | label | EN-WRONG | Título da música (opcional) |
| `e.g. Bohemian Rhapsody` | placeholder | EN-WRONG | ex.: Evidências |
| `Table # (optional)` / `Table number` | label / aria | EN-WRONG | Mesa (opcional) / Número da mesa |
| `Mode` | label / aria | EN-WRONG | Modo |
| `🎤 Sing` / `💃 Listen / Dance` | select options | EN-WRONG | 🎤 Cantar / 💃 Só curtir |
| `Paste a valid YouTube URL first.` | submit error | EN-WRONG | Cole um link do YouTube válido primeiro. |
| `Enter a nickname first.` | submit error | EN-WRONG | Digite um apelido primeiro. |
| `Failed to add song.` | submit error fallback | EN-WRONG | Não deu para adicionar a música. |
| `Network error — please try again.` | submit error | EN-WRONG | Erro de rede — tente de novo. |
| `Adding…` / `Add to queue` | submit CTA | EN-WRONG | Adicionando… / Entrar na fila |
| `✓ Song added to the queue!` | success | EN-WRONG | ✓ Música na fila! |
| `Live queue` | section heading | EN-WRONG | Fila ao vivo |
| `(N song / N songs)` | count | EN-WRONG + **needs ICU plural** | ({count} música/músicas) |
| `No songs yet — be the first!` | empty state | EN-WRONG | Ninguém na fila — seja o primeiro! |
| `song` / `songs` | plural inline | EN-WRONG + ICU | música / músicas |
| `Sing` / `Dance` | row badge | EN-WRONG | Cantar / Curtir |
| `· Table N` | row meta | EN-WRONG | · Mesa N |
| `Venue screen ↗` | footer | EN-WRONG | Tela do bar ↗ |
| `Early-access prototype — queues are per-room` | footer | EN-WRONG | Protótipo (early access) — filas por sala |
| `📍 {venue} · Mesa {table}` | venue chip | pt-BR ✓ | — |
| `Sala:` | room label | pt-BR ✓ | — |
| `Modo:` + `modeLabel` | mode hint | pt-BR ✓ | — |
| `O vídeo toca na tela do bar. Assistir na TV ↗` | player hint | pt-BR ✓ | — |
| `Fila reordenada — modo mudou para …` | toast | pt-BR ✓ | — |

**~26 English strings on the patron page.** This is contested (TICKET-40 owns SongSearch + patron form) → **audited now, extracted in the final rebase**.

## Surface-by-surface inventory

### Landing — `app/page.tsx` (client) — pt-BR ✓ — **contested: TICKET-43**
`🎤 Boraoke`, hero paragraph, `Criar a sala do seu bar`, `Já tem um código?`, `Digite o código da sala (ou cole o link…)`, `Código da sala` (aria), `ex.: bar-do-ze`, `Entrar`, `Última sala:`, footer `Boraoke — early access · uma sala por bar, filas isoladas`. All pt-BR. Switcher must be added here. **Extract in rebase.**

### /new — `app/new/page.tsx` (client) — pt-BR ✓ — **MINE, extract now**
Success view: `🎤 Sala criada!`, `… está no ar.`, `Entrada do público`, `QR de {name}` (title), `Mostre esse QR no bar ou deixe na tela /tv.`, ephemeral notice (`⚠️ As salas ainda são temporárias …`), `Código do host (anote agora!)`, `É com ele que você controla a fila em /admin. Ele aparece uma única vez — guarde num lugar seguro.`, `Abrir admin`, `Abrir /tv`, `Ver a sala do público →`. Create view: `🎤 Criar sala`, `Dê o nome do seu bar. A gente gera o link, o QR e o código do host.`, `Nome do bar` (label/aria), `ex.: Bar do Zé`, `Não deu para criar a sala. Tente de novo.` (fallback), `Erro de rede — tente de novo.`, `Criando…` / `Criar sala`, `← Voltar`. **All pt-BR — extract now.**

### Patron — see headline table — **contested: TICKET-40**

### TV — `components/tv/TvScreen.tsx` (client) — pt-BR ✓ — **contested: TICKET-41**
`Boraoke`, `noite de karaokê` (fallback venue), `Tocando agora`, mic-call `🎤 {nick}, Mesa {t} — vá para o microfone! {s}s`, `Fila reordenada — modo mudou`, `A SEGUIR`, `Escaneia para entrar na fila` (QR title), `Escaneia e canta!`, `powered by Boraoke`, `Escaneia e canta! 🎤` (idle), `Pular ⏭`, `Tela cheia (F)`, `Esc para sair`, `· Mesa {t}`. All pt-BR. **TV follows room language — NO switcher.** Extract in rebase; must read the room-language locale (not the user cookie).

### Admin — `app/(patron)/[room]/admin/AdminRoom.tsx` (client) — pt-BR ✓ — **contested: TICKET-43**
Gate: `Carregando…`, `🎤 Boraoke · admin`, `Entre com o código do host para controlar a fila.`, `Controles do host ainda não configurados para este bar.`, `Código do host` (label/aria), `Token inválido — tente de novo.`, `Erro de rede — tente de novo.`, `Entrando…` / `Entrar`. Dashboard: `Boraoke`, `⏸ Pausado` / `AO VIVO`, `Sala do público ↗`, `Abrir /tv ↗`, `Fila`, `Fila vazia — manda a primeira! 🎤`, `· Mesa {t}`, `· 🎶 só curtir`, aria `Subir/Descer/Remover {nick}`, `remover`, `Confirmar` / `Cancelar`, controls `▶ Retomar`/`⏸ Pausar`/`⏭ Pular música`/`🙅 Não veio` (+ title), `A noite em números`, `na fila hoje`/`cantores`/`mesas ativas`, `Entrada do público`, `QR na tela /tv ou link direto:`, `Modo alterado para {mode} — fila reordenada.`. All pt-BR. **Room-language selector to be added here** (host sets room default language, additive). Extract in rebase.

### ModeSwitcher + rotation-modes — `components/host/ModeSwitcher.tsx`, `lib/rotation-modes.ts` — pt-BR ✓ — **shared, source mine now**
`Modo da noite` (×2 + aria), `Modo de rodízio` (aria), `ATIVO` chip. `MODE_META`: `🎤 Karaokê completo` + rule, `🍻 2 por mesa` + rule, `🙋 1 por pessoa` + rule; `modeLabel` fallback. Copy is "verbatim from mockup / doubles as rotation-rule docs" — translate carefully. Source strings extracted now; consumer wiring (admin/patron) in rebase.

### Feedback — `components/FeedbackWidget.tsx`, `components/feedback/FeedbackSheet.tsx` — pt-BR ✓ — **MINE, extract now**
`Enviar feedback` (aria ×2). Sheet: sentiments `Amei`/`Curti`/`Meh`/`Odiei`, categories `Busca de música`/`Fila / vez`/`Player da TV`/`Outro`, `Não consegui te identificar. Recarrega a página e tenta de novo.`, `Deu ruim ao enviar. Tenta de novo em instantes.`, `Sem conexão? Tenta de novo em instantes.`, `Valeu!`, `Como tá sendo? 🎶`, `Fechar` (aria), `Sentimento`/`Categoria` (aria), `Quer contar mais? (opcional)`, `Sobre o quê? (opcional)`, send/close CTAs. **All pt-BR — extract now.**

### SongSearch — `components/SongSearch.tsx` — pt-BR ✓ — **contested: TICKET-40**
`Muitas buscas — aguarde um instante.` (fallback), `Link do YouTube` / `Link colado`, `Buscar música ou colar link do YouTube` (aria), `Ex.: evidências — ou cole um link do YouTube` (placeholder), plus degraded/empty/results copy. All pt-BR. Extract in rebase.

### Metadata — `app/metadata.ts` — pt-BR ✓ — **MINE, extract now**
Title `Boraoke — a fila de karaokê do seu bar`, template `%s · Boraoke`, description, OG/twitter title+description, `locale: pt_BR`, `og-image-pt-BR.png`, `alt: Boraoke`. Wire per-locale OG lookup (`og-image-<locale>.png`, pt-BR fallback since en/es cards in flight) + per-locale title/description.

### API error strings — `app/api/**`
Two classes:
- **Technical validation (400s a normal UI never trips)** — English, LOW priority, keyed but acceptable: `Invalid room id`, `Unauthorized`, `Request body too large`, `Invalid JSON`, `Body must be an object`, `paused must be a boolean`, `entryId is required`, `newIndex must be an integer`, `uuid must be a valid UUID`, `patronUuid must be a valid UUID`, `mode must be one of …`, `Room not found`, `Venue name is required`, `Valid YouTube URL or videoId is required`, `nickname is required`. These are guard rails; the client shows its own pt-BR fallback for most (`err.error ?? "<pt-BR>"`). **Keep as-is for now, documented; not user-copy.**
- **User-facing (surfaced verbatim to patrons)** — must be localized: `Muitas buscas — aguarde um instante e tente de novo.` (search 429), `Muitas salas criadas — tente de novo em uma hora.` (rooms 429), `Estamos lotados por enquanto — tente de novo mais tarde.` (rooms 503), `SUBMIT_RATE_MESSAGE` (queue 429, in `lib/queue-rate-limit.ts`), degraded `reason` codes (`no-api-key`/`quota`/`error`) that SongSearch maps to pt-BR copy, `Controles do host ainda não configurados para este bar.` (host 503). Already pt-BR; localize via server `getTranslations` keyed to request locale so an `en`/`es` client gets matching copy. **Non-contested route files — wire now where the route file isn't otherwise touched.**

## Coverage plan / contested-components checklist (tracked in dev report)

- [x] Audit complete (this file)
- [ ] **Now:** infra, messages (3 files), switcher, layout `<html lang>`, metadata, room-language model + API, `/new`, feedback, rotation-modes source, user-facing API errors
- [ ] **Rebase (after 40/41/43 merge):** PatronRoom (the ~26 EN strings), SongSearch, TvScreen, landing, AdminRoom+ModeSwitcher consumers

## `<html lang>` note (design audit L1)
Currently `<html lang="pt-BR">` is hardcoded — CORRECT for the default, but must become **dynamic** (`lang={locale}`) so an `en`/`es` visitor gets the right value for SEO / screen readers / autotranslate. Fixed as part of the layout change.
