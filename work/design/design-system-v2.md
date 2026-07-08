# cantai — Design System v2: professional + personality (TICKET-23)

- **Date:** 2026-07-07 · **Author:** Designer agent · **Status:** Proposed (W-design gate)
- **Supersedes:** `design-system.md` (v1) — v1 tokens survive as the **bar vibe, dark theme**; v2 wraps them in a theming architecture instead of replacing them.
- **Reference implementation:** `work/design/mockups-v2/` (`cantai-v2.css` is the token source of truth; open `index.html`).
- **Companion docs:** `ux-audit-v1.md` (what v2 fixes), `design-handoff-v2.md` (build order).

## 0. The v2 thesis

"More professional" and "more personality" are the same fix: **one token system, executed consistently, with personality moved into swappable theme layers.** v1's personality was right but only shipped on the TV; the rest of the app fell back to unstyled red/blue defaults. v2 makes the system the only way to build a surface — and makes the system itself flex from boteco to boardroom.

## 1. Theming architecture — two axes + one brand slot

Every surface is themed by **two independent HTML attributes** plus one venue-set accent:

```html
<html data-theme="dark" data-vibe="bar" style="--venue-accent: #FF3D71">
```

### Axis 1 — `data-theme`: dark | light

Sets the *neutral* stack only: backgrounds, surfaces, borders, text ramps, shadows. Never sets accents.

| Token | dark | light |
|---|---|---|
| `--bg` | `#0D0A14` | `#FAF7FD` |
| `--surface` | `#1A1424` | `#FFFFFF` |
| `--surface-2` | `#251C33` | `#F1EBF8` |
| `--border` | `#372B4A` | `#DCD3E8` |
| `--text` | `#F7F3FC` | `#231A31` |
| `--text-muted` | `#A79BC0` | `#6A5D80` |
| `--text-dim` | `#6E6288` | `#9488A8` |

Rules: patron/admin default to **system preference** with a manual override (persisted per device); **TV defaults to dark** in bar/party vibes and **light is allowed** in festa/corporate vibes (daytime weddings, office lobbies); the landing page follows system.

### Axis 2 — `data-vibe`: bar | party | festa | corporate

The personality layer. Sets accents, gradient, display-font feel, radius, emoji policy, and copy tone. The venue picks the vibe at room creation (changeable in admin → room settings).

| | 🍻 `bar` (default) | 🎉 `party` | 💍 `festa` | 💼 `corporate` |
|---|---|---|---|---|
| Story | neon boteco stage | balada / birthday | wedding / celebration | office event, all-hands |
| `--accent` | `#FF3D71` pink | `#8B5CF6` violet | `#C99A5B` champagne gold | `#3B82F6` blue (or venue brand) |
| `--accent-2` | `#FFC24B` amber | `#22D3EE` cyan | `#E8B4B8` rose | `#94A3B8` slate |
| `--g-brand` | pink→amber 135° | violet→cyan 135° | gold→rose 135° | none — flat `--accent` |
| Radius scale | 16/12/pill | 20/14/pill (rounder) | 14/10/pill | 10/8/12 (squarer, **no pill**) |
| Display voice | bold 800, tight | extra-bold 800, italic energy | serif display (e.g. Fraunces), 600 | semibold 600, roomy tracking |
| Emoji policy | on (🎤🍻🔥) | on, extra (🎉🪩) | sparing (✨🥂) | **off** — line icons only |
| Copy tone (pt-BR) | "Bora cantar!" | "Solta a voz!" | "Uma música para os noivos?" | "Adicione sua música" |
| Live badge | mint `#2EE6A8` | mint | sage `#9CB89C` | green `#22C55E` |

Vibe rules:

- A vibe changes **zero layout** — only tokens + copy-tone strings + emoji policy. One DOM, four skins. This is what keeps 4 vibes maintainable.
- `--danger` stays constant (`#FF5C5C` dark / `#DC2626` light) across vibes — destructive is never on-brand.
- Contrast floor: every `--accent` must pass 4.5:1 against `--surface` for text-size usage in its default theme, 3:1 for large text/UI. The four accents above pass; a custom venue accent is auto-darkened/lightened until it passes (show the adjusted swatch in settings, never silently fail).
- Copy tone ships as a **string-variant layer on top of i18n** (see §3): each locale file has a base string + optional per-vibe overrides for the ~20 personality strings (CTAs, empty states, TV headlines). Everything else is shared.

### The brand slot — swappable wordmark (rename-proof)

TL flagged a possible rename (cantai.com taken). The wordmark is therefore **one component + two tokens**, never inline text:

- `<Wordmark />` renders `var(--brand-name)` ("cantai") in `var(--brand-font)` with `background: var(--g-brand)` text-clip (flat `--accent` in corporate).
- Rule: **always lowercase, always the gradient/accent treatment, never the emoji mic as a logo.** The 🎤 emoji is an *illustration*, not the mark.
- Product-wide rename = change `--brand-name` + the i18n brand entry. Nothing else refers to the name.
- "powered by cantai" appears **once** per surface maximum (TV footer, patron footer) and is demoted to `--text-dim`; the venue identity always outranks it (§2).

## 2. Room customization surface (venue branding)

The venue is the customer; their identity leads on every surface their guests see.

**Creation-time (30 seconds, all optional except name):** venue/event display name → vibe picker (4 cards with live mini-preview) → accent color (preset swatches + free picker, contrast-guarded).

**Admin → room settings (post-creation, richer):** everything above, plus event subtitle ("Festa da Firma 2026", "Casamento Ana & Beto"), venue logo upload (shown on TV top bar + patron header; falls back to styled initial-letter monogram), room default language (§3), TV footer toggle (existing TICKET-18 feature, folded in).

**Identity precedence, everywhere:** 1) venue logo (if set), 2) venue display name (always), 3) event subtitle, 4) cantai wordmark (small, corner/footer). The TV idle screen headline is the VENUE name; "cantai" appears once, small. Patrons see "Boteco da Lua" + "fila por cantai", never a slug (slugs are URLs only).

## 3. i18n design (multi-language)

### Language list

| Tier | Locales | Rationale |
|---|---|---|
| **Launch (v2)** | `pt-BR` (source), `en`, `es` | BR home market; EN = international default + corporate events; ES = LatAm neighbors, near-free from pt-BR. |
| **Fast-follow** | `fr`, `de`, `it` | European private-event market; DE is the text-expansion stress test. |
| **Karaoke-culture** | `ja`, `ko`, `zh-Hans` | The world's deepest karaoke markets; CJK validates the type system. |
| **RTL (flagged, not scheduled)** | `ar`, `he` | Do not ship until an RTL pass is done (below). |

### Design rules (bind Dev + Design)

1. **Expansion budget:** every text container tolerates **+35%** over pt-BR (DE/FR reality). CTAs and chips use `min-width` + padding, never fixed width; TV headline auto-scales down one step (`clamp()`) when the string overflows.
2. **No text in images/assets.** QR poster text, TV headlines, empty-state art: live text always.
3. **ICU everywhere:** plurals ("1 música / 2 músicas / 0 songs"), ordinals — the position hero "Você é o 4º" must be an ICU `selectordinal` ("You're 4th", "Eres el 4.º"), never string-concatenated.
4. **Locale-aware formats:** times (23:30 vs 11:30 PM), dates on the history view, list separators.
5. **Emoji don't translate tone:** the vibe emoji-policy (§1) applies per vibe, not per locale; but check gesture emoji for locale safety before adding new ones.
6. **`<html lang>` always correct** (it's `en` today on a pt-BR page — audit L1) — SEO, screen readers, autotranslate all depend on it.
7. **RTL note (pre-work, cheap now / expensive later):** author all new CSS with **logical properties** (`margin-inline-start`, `padding-inline`, `inset-inline-end`, `text-align: start`) and direction-free flex/grid. Do this from v2 day one so `ar`/`he` become a `dir="rtl"` flip + icon-mirroring pass instead of a rewrite. The queue "left-edge" my-row bar becomes `border-inline-start`.

### Language resolution & switch UX

Resolution order: explicit user choice (persisted) → **room default language** (venue-set — a German wedding in Brazil sets `de`) → `Accept-Language` → `pt-BR`.

Switcher (mockup: `switchers.html`): a **globe pill in the header** (`🌐 PT`) on patron/landing/admin → opens a bottom sheet (mobile) / popover (desktop) listing languages as **native names** ("Português (Brasil)", "English", "Español") with a check on the active one. TV has **no on-screen switcher** — it follows the room language (host changes it in admin). The switcher sits beside the theme toggle (sun/moon) in one "display preferences" cluster.

## 4. Type, spacing, components — v2 deltas from v1

Type scale, spacing scale, and TV 10-foot rules carry over from v1 unchanged (they were right; they just weren't applied). Deltas:

- **Display font per vibe** (§1 table) — self-hosted, `font-display: swap`, system-stack fallback stays the guarantee.
- **State grammar fix (audit N1/N2/S5):** inputs rest with `--border` hairline (**red/danger is reserved for errors**); focus = `--accent` ring; disabled buttons = 40% opacity + `--surface-2` fill (**never a darker shade of the enabled color** — dark-of-primary reads as pressed).
- **New components:** wordmark (brand slot), vibe picker card, venue identity header (logo/monogram + name + subtitle), language sheet, theme toggle, copy-field (URL/code with one-tap copy — audit C1), position-hero card (patron delight moment, per-vibe copy), drag-handle queue row + "▶ cantar agora" pin action (admin), host add-song sheet, session card + stat tiles + played-song row (admin history), account-hook banner (logged-out admin), locked/blurred teaser panel (history behind signup).
- **Icon strategy:** emoji in bar/party/festa per policy; corporate swaps to a line-icon set (vendored SVG, `currentColor`) — same slots, `data-vibe`-driven.

## 5. Admin v2 architecture (the TL's "much richer admin")

Two views, one shell (mockups: `admin-live.html`, `admin-history.html`):

**Shell:** venue identity header (name, vibe badge, AO VIVO status) + tabs **Ao vivo | Histórico** + utility cluster (open patron page ↗, open TV ↗, room settings, language/theme).

**Ao vivo:** now-playing hero (thumbnail, singer, table, progress, ⏭ pular / 🙅 não veio / ⏸ pausar) · queue with **drag-handle reorder**, per-row "▶ cantar agora" (pin to position 2) and remove · **host add-song** (inline search sheet; host assigns singer name/table or "pedido do palco"; no patron round-trip) · tonight's stat strip (na fila, cantores, mesas, músicas tocadas) · entry card (QR + copy-link + copy-code).

**Histórico:** sessions ("noites") list — each card: date, duration, songs played, unique singers, peak headline · session detail: played-songs timeline (with skips/no-shows), top singers, top songs, activity-by-hour spark bars · all-time aggregates row.

**Auth progression (design contract with the coming auth model):**

| State | Sees | Hook |
|---|---|---|
| Logged-out host (host-code only) | Ao vivo fully; Histórico tab shows **tonight only** + a blurred teaser of past sessions | Banner: "**Crie sua conta para guardar o histórico** — as noites somem em 7 dias sem conta" + CTA "Criar conta grátis" |
| Logged-in, room claimed | Everything; full history/analytics | Settings gains "sua conta" section |

Design rule: the hook sells the value (the blurred real-shaped teaser shows *their* lost nights), never blocks tonight's operation — running the current night is never behind signup.

## 6. MVP-vs-later (v2 scope guard)

**In v2 build waves (see design-handoff-v2.md for order):** token system + state-grammar fix; wordmark component; venue identity precedence (name everywhere, slug nowhere); patron flow restructure (3-step + position hero); i18n foundation + pt-BR/en/es + switcher; dark/light; vibe architecture with **bar + party** shipped; admin shell + live view (add-song, drag reorder, links); admin history + account hook (behind auth ticket); landing refresh.

**Later:** festa/corporate vibes as *shipped presets* (architecture lands in v2, presets are token files — ship when a customer asks); venue logo upload (monogram fallback ships first); fr/de/it/ja/ko/zh locales; RTL execution (logical-properties pre-work IS in v2); themed QR; TV idle marquee/rotating tips; per-venue custom fonts.
