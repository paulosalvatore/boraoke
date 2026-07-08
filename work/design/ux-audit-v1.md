# cantai — UX audit of the live v1 (TICKET-23)

- **Date:** 2026-07-07 · **Author:** Designer agent · **Ticket:** TICKET-23 (design v2)
- **Audited:** LIVE product at https://cantai-snowy.vercel.app (landing, /new, room-created, patron room, /tv, /admin) + local dev serve of the same code for patron-flow states + committed evidence archives (ticket-8/10/11/18).
- **Evidence:** `work/evidence/ticket-23/live-audit/` (01–09, indexed at the bottom).
- **Out of scope (assumed fixed):** the TICKET-20 P0s — join-code input, room-404 honesty, slug suffixes — and the Upstash persistence work. They are noted where they surfaced but v2 is designed assuming they are fixed.

## Verdict in one line

The product works, but it reads as three different apps stitched together: a pt-BR brand voice on TV/admin, an English prototype on the patron page, and an unbranded dev stub on the landing — with three different accent palettes (flat red, blue/indigo, pink→orange gradient) fighting each other. v2's job is one coherent, professional, personality-driven system.

## Priority scale

- **P0 — embarrassment:** actively damages trust with a paying venue; fix before showing anyone.
- **P1 — unprofessional:** visibly rough; fix in the first v2 build wave.
- **P2 — rough edge:** noticeable to a careful eye.
- **P3 — polish:** nice-to-have refinement.

## Screen-by-screen findings

### 1. Landing `/` (evidence 01)

| # | Priority | Finding |
|---|---|---|
| L1 | **P0** | **Language salad starts at the `<title>`:** "Cantai — Karaoke Queue" (EN) over a pt-BR page. Every tab, bookmark, and share card shows English. |
| L2 | **P0** | **Zero product sell.** One paragraph + two boxes. No screenshot, no how-it-works, no social proof, no vertical flexibility (bar-only copy), no pricing hint. A venue owner deciding in 10 seconds gets nothing to decide with. |
| L3 | **P1** | **No brand presence.** Emoji-mic + plain-text heading instead of the gradient wordmark the TV page already ships. The only branded element on screen is… the feedback button. |
| L4 | **P1** | Flat red CTA (`#e-red`) instead of the v1 stage gradient; disabled "Entrar" renders as dark maroon that reads as *pressed*, not disabled. |
| L5 | **P1** | Join-code box was broken at audit time (tiny square input) — TICKET-20 scope, listed for completeness. |
| L6 | **P2** | Bar-only framing ("do seu bar") — the TL direction is venue-flexible (parties, weddings, corporate). Copy and imagery must flex. |
| L7 | **P3** | Footer micro-copy "uma sala por bar, filas isoladas" is internal architecture-speak, not user benefit. |

### 2. Create room `/new` (evidence 02)

| # | Priority | Finding |
|---|---|---|
| N1 | **P1** | **Default input has a red border** — the resting state looks like a validation error before the user typed anything. (Same pattern on patron join and admin gate: it is the system-wide input style.) |
| N2 | **P1** | Disabled CTA = maroon "pressed" look (system-wide button problem). |
| N3 | **P2** | "Nome do bar" label — should be "Nome do lugar/evento" (venue flexibility) with examples spanning bar/festa/empresa. |
| N4 | **P2** | No expectation setting: nothing tells the creator they're 60 seconds from a working room (steps/preview). |

### 3. Room created (confirmation) (evidence 03)

| # | Priority | Finding |
|---|---|---|
| C1 | **P1** | **No copy-to-clipboard** on the two things the user must transport (public URL, host code). The host code says "anote agora!" and then makes writing it down the only option. |
| C2 | **P1** | Public URL wraps mid-slug ("…boteco-design-v2-r kar") — looks broken, invites transcription errors. |
| C3 | **P1** | "Abrir admin" and "Abrir /tv" as two equal-weight red primaries — no hierarchy, and "/tv" is developer route-speak in a button label. |
| C4 | **P2** | The one-time host code is a huge liability with no recovery story; v2's auth model ("claim the room with an account") is the real fix — the confirmation screen should plant that seed. |
| C5 | **P3** | QR is unbranded black/white — fine functionally, but a themed QR (accent corners, wordmark) is cheap personality. |

### 4. Patron room `/[room]` (evidence 07–09; ticket-8 archive)

| # | Priority | Finding |
|---|---|---|
| P1 | **P0** | **The entire patron surface is in ENGLISH** ("Your nickname", "Join queue", "Add a song", "Song title (optional)", "Table # (optional)", "Mode: Sing / Listen / Dance", "Live queue", "Hi, Paulo", "No songs yet — be the first!") while TV/admin/landing speak pt-BR. This is the single most embarrassing thing in the product: the surface EVERY patron sees is the one not in their language. |
| P2 | **P0** | **Raw room slug shown to patrons:** "Sala: boteco-auditoria-v2-ps1m". The suffix is an implementation detail; patrons should see the venue display name only. |
| P3 | **P1** | **Off-brand blue/indigo accents** on queue rows and "SING" chips (see ticket-8 archive) — a third accent family that exists nowhere in the design system. |
| P4 | **P1** | **The v1-designed 3-step flow was never built.** Live is one cramped form: no mode-selector cards at join, mode became a `<select>` dropdown, table number is buried in the add-song form, and there is no post-submit "Você é o 4º da fila 🔥" position hero — the core delight moment of the product is missing. |
| P5 | **P1** | **"Song title (optional)" manual text field** — data-entry chore that produces garbage queue rows (raw "youtu.be/dQw4w9WgXcQ" titles on TV). Song metadata should come from search/oEmbed resolution, never typed. |
| P6 | **P1** | Search results (when they render) have no thumbnails/channel/duration — the v1 song-row spec wasn't implemented. |
| P7 | **P2** | "Hi, Paulo" (EN) + wordmark capitalized "Cantai" — brand rule is lowercase `cantai`. |
| P8 | **P2** | Degraded-search notice ("Busca indisponível — cola o link do YouTube") is the right idea but appears as a bare status line; needs the paste-link affordance surfaced, not implied. |
| P9 | **P3** | Footer "Early-access prototype — queues are per-room" — internal-speak leaking to patrons. |

### 5. TV `/[room]/tv` (evidence 06; ticket-18 archive)

| # | Priority | Finding |
|---|---|---|
| T1 | **P0** | **The venue name never appears on the venue's own screen.** Idle TV shows generic "noite de karaokê" + the cantai wordmark ×3 (top-left, hero, "powered by"). The screen the venue paid to put up celebrates *us*, not *them*. Room branding is the v2 headline feature. |
| T2 | **P1** | Host chrome ("Pular ⏭", "Tela cheia (F)") **overlaps the QR join card and the powered-by line** when visible (ticket-18 archive) — collision, looks broken on the most public surface. |
| T3 | **P1** | The QR on TV points to the patron URL that intermittently 404s (persistence P0, TICKET-20/Upstash) — noted because the TV is where the failure becomes public. |
| T4 | **P2** | No progress bar on now-playing (v1 spec had it) — patrons can't tell how long until their turn advances. |
| T5 | **P2** | TV gradient is pink→orange; v1 tokens say pink→amber. Minor, but it's the brand mark — one gradient, everywhere. |
| T6 | **P3** | Idle screen is static — a venue-name marquee / rotating tips ("peça no seu celular", top songs of the night) would make idle screens sell harder. |

### 6. Admin `/[room]/admin` (evidence 04–05; ticket-10 archive)

| # | Priority | Finding |
|---|---|---|
| A1 | **P1** | **Raw slug as venue identity** in the header chip and on the gate screen ("boteco-design-v2-rkar") — the admin is the paying customer; greet them by their venue's name. |
| A2 | **P1** | **No host add-song.** The #1 host superpower (grab a request shouted at the bar, queue it directly) doesn't exist. |
| A3 | **P1** | **No history at all.** Close the tab, the night is gone. Nothing happened "yesterday". No sessions, no played-songs log, no aggregates — the TL's core v2 ask. |
| A4 | **P2** | Reorder via tiny ▲▼ arrow taps (ticket-10 archive) — moving an entry 5 positions = 5 taps; no drag, no "sing next" pin. |
| A5 | **P2** | "A noite em números" showed "0 mesas ativas" with table-tagged entries in the queue — stat bug or stale definition; either way numbers a customer sees must be trustworthy. |
| A6 | **P2** | Empty-state "Fila vazia — manda a primeira! 🎤" floats untethered mid-panel; controls below it look orphaned. |
| A7 | **P2** | No link to open the patron page (only "Abrir /tv"); host can't see what patrons see without typing the URL. |
| A8 | **P3** | "remover" lowercase ghost link — destructive action with no visual weight hierarchy vs. the arrows beside it. |
| A9 | **P3** | Host-gate placeholder "••••••••" suggests a password; the host code is a room key, not a secret the user chose — microcopy should say so. |

### 7. System-wide

| # | Priority | Finding |
|---|---|---|
| S1 | **P0** | **Three accent systems in production:** flat red (landing/patron/admin), blue/indigo (patron queue chips), pink→orange gradient (TV/feedback FAB). One token system must win — v2 defines it. |
| S2 | **P1** | Wordmark chaos: "🎤 Cantai", "🎤 cantai", gradient "cantai", "cantai · admin". One swappable wordmark component (TL flagged a possible rename — cantai.com is taken) used everywhere. |
| S3 | **P1** | No i18n infrastructure at all — strings are hardcoded in two mixed languages. Blocks the multi-language requirement. |
| S4 | **P2** | No light theme (v1 scoped it out for bars; v2's venue flexibility — daytime corporate/wedding events — brings it back in). |
| S5 | **P2** | Input/button state grammar is inverted across the app (error-red resting inputs, pressed-looking disabled buttons); needs one componentized state system. |
| S6 | **P3** | Emoji as icons everywhere (🎤🍻🙋💬) — charming in bar vibe, wrong for corporate vibe; icon strategy must be theme-aware. |

## Top-10, ranked (what v2 must kill first)

1. **P1 patron page in English** while the product speaks pt-BR (P0 · patron).
2. **T1 venue name absent from TV** — no room branding anywhere (P0 · TV; the v2 headline feature).
3. **S1 three competing accent systems** — red vs blue vs gradient (P0 · system).
4. **L1/L2 landing is an unbranded dev stub** with an EN title and no product sell (P0 · landing).
5. **P2/A1 raw slugs shown as venue identity** to patrons and admins (P0/P1).
6. **P4 missing position hero + 3-step flow** — the product's delight moment was never built (P1 · patron).
7. **A2/A3 admin has no add-song and no history** — the paying customer's surface is a remote control, not a cockpit (P1 · admin).
8. **P5 manual "Song title" field** producing raw-URL titles on the public TV (P1 · patron/TV).
9. **N1/N2/S5 inverted state grammar** — error-looking inputs, pressed-looking disabled buttons, everywhere (P1 · system).
10. **T2 TV host-chrome overlapping the QR card** — visible collision on the most public screen (P1 · TV).

## Evidence index (`work/evidence/ticket-23/live-audit/`)

| File | What it shows |
|---|---|
| `01-live-landing-desktop.png` | Landing: no brand, flat red, broken join-code box, EN title |
| `02-live-new-desktop.png` | /new: error-red resting input, pressed-looking disabled CTA |
| `03-live-room-created-desktop.png` | Confirmation: URL wrap, no copy buttons, twin red CTAs |
| `04-live-admin-gate-desktop.png` | Admin gate: raw slug identity, password-style placeholder |
| `05-live-admin-desktop.png` | Admin: mode cards, empty queue float, stats, no add-song/history |
| `06-live-tv-idle-1080p.png` | TV idle: wordmark ×3, generic "noite de karaokê", no venue name |
| `07-live-patron-room-mobile.png` | Patron join (live): EN strings, raw slug "Sala: …-ps1m", red-border input |
| `08-local-patron-join-mobile.png` | Patron join (local serve): same surface, pre-TICKET-20 state |
| `09-local-patron-main-mobile.png` | Patron main (local): "Add a song" form, Mode dropdown, EN/pt salad |

Archive references: `work/evidence/ticket-8/` (patron flow with queue + blue chips), `work/evidence/ticket-10/` (admin arrows reorder, mode switching), `work/evidence/ticket-18/` (TV playing + host-chrome overlap).
