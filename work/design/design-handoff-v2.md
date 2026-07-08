# cantai — Design Handoff v2 (TICKET-23 → Dev tickets)

- **Date:** 2026-07-07 · **Author:** Designer agent
- **Reference implementation:** `work/design/mockups-v2/` (open `index.html`; `cantai-v2.css` is the v2 token source of truth — supersedes `mockups/cantai.css` for new work)
- **Companions:** `ux-audit-v1.md` (what to fix, prioritized), `design-system-v2.md` (theming/i18n/customization architecture)
- **Screenshots:** `work/evidence/ticket-23/` (`live-audit/` = the problem, `mockups-v2/` = the target)
- **Assumed fixed upstream:** TICKET-20 P0s (join-code input, room-404 honesty, slug suffixes) + Upstash persistence. Nothing below designs around those bugs.

## What v2 is, in one paragraph

One token system (`data-theme` dark|light × `data-vibe` bar|party|festa|corporate + `--venue-accent`), executed on every surface; the venue's identity leading every guest-facing screen (name/logo/vibe — slugs never); a patron flow rebuilt to its designed 3-step shape with the position-hero moment; an admin that becomes a cockpit (add-song, drag reorder, live stats, session history behind the account hook); and an i18n foundation shipping pt-BR/en/es. The wordmark is a swappable component — a product rename touches one token.

## Build order (recommendation to the TM)

Ordered by dependency + embarrassment-per-effort. Each wave is one Dev-ticket-sized chunk.

| Wave | Scope | Why this order | Mockup / spec |
|---|---|---|---|
| **W1 — Token foundation + state grammar** | Port `cantai-v2.css` `:root`/`[data-theme]`/`[data-vibe]` tokens into the app (CSS vars, names verbatim); kill the blue/indigo and flat-red one-offs; fix inputs (hairline resting, danger=error-only) and disabled buttons (fade, never darken); one `<Wordmark />` component used everywhere (lowercase + gradient, emoji-mic demoted to illustration). | Everything else sits on it; instantly de-uglifies every screen; audit S1/S2/S5/N1/N2. | `cantai-v2.css`, system doc §1, §4 |
| **W2 — i18n foundation + full pt-BR pass** | String extraction (ICU), `<html lang>` fixed, locale files pt-BR (source) + en + es; globe switcher (sheet/popover per `switchers.html`); room default language setting; locale-aware ordinals for the position hero. | The English patron page is the #1 embarrassment (audit P1); retrofitting i18n later re-touches every string W3–W6 add. | `switchers.html`, system doc §3 |
| **W3 — Venue identity everywhere** | Venue name/monogram header on patron + admin + TV (precedence rules); slug never rendered (URLs only); TV top bar = venue first, cantai once in footer; copy-fields with one-tap copy on room-created + admin. | The "room customization" headline lands here in its cheap form (name presence); audit T1/P2/A1/C1. | `patron.html`, `tv-bar.html`, `admin-live.html`, system doc §2 |
| **W4 — Patron flow restructure** | 3 screens (join w/ mode cards + table; pick w/ thumbnail result rows + paste-link fallback visible; queue w/ position-hero card + my-row/playing-row states); delete the manual "Song title" field (metadata from search/oEmbed only). | The product's delight moment; audit P4/P5/P6. | `patron.html` |
| **W5 — Admin v2 · Ao vivo** | Shell (identity header, tabs, patron-page + TV links, ⚙ Sala); now-playing hero w/ progress; host add-song (search + assign singer/table); drag-handle reorder + "▶ Cantar agora" pin + remove-with-confirm; tonight stat strip (fix "mesas ativas"); entry card (QR + copy link/code). | Host superpowers are pure retention for the paying user; audit A2/A4/A5/A7. | `admin-live.html` |
| **W6 — Sessions history + account hook** | Session (noite) recording — played/skipped/no-show timeline events; Histórico tab: logged-out = tonight + blurred teaser + "crie sua conta para guardar o histórico" banner; logged-in = sessions list, session detail (timeline, top singers/songs, per-hour bars), all-time strip. **Blocks on the auth-model ticket for the logged-in half; the event recording + logged-out hook can ship first.** | The TL's "see what happened before"; designs the signup motivation loop. | `admin-history.html`, `admin-live.html` (hook), system doc §5 |
| **W7 — Room customization + vibes bar/party** | Creation flow: name → vibe picker → accent swatches (contrast-guarded); ⚙ Sala settings (vibe, accent, subtitle, default language, TV footer toggle); ship **bar + party** vibe presets end-to-end (TV + patron + admin). | Architecture from W1 makes this mostly settings UI + token files. | `switchers.html` §3, `tv-party.html` |
| **W8 — Landing refresh + light theme** | Marketing landing per mockup (hero, how-it-works, vibe flexibility grid, product preview, fixed join-code box); enable `data-theme="light"` across patron/admin/landing with the Auto toggle. | Sells the product the earlier waves made true; light theme is a QA pass once W1 tokens exist. | `landing.html`, `switchers.html` §2 |
| **Later** | festa/corporate vibe presets (token files — ship on demand), venue logo upload (monogram fallback ships in W3), fr/de/it/ja/ko/zh, RTL execution, themed QR, TV idle marquee. | Explicitly deferred — see system doc §6. | — |

Standing rule from W1 onward: **all new CSS uses logical properties** (RTL pre-work, system doc §3.7) — free now, a rewrite later.

## Non-negotiables (v2 acceptance criteria)

1. Token names/values from `cantai-v2.css` verbatim; no hex literals in components.
2. Exactly one accent system per surface, driven by `data-vibe`; `--danger` reserved for destructive/errors.
3. Venue display name on every guest-facing surface; a slug is never rendered as text.
4. Wordmark only via the component: lowercase, gradient (flat in corporate), swappable via `--brand-name`.
5. Every user-visible string comes from a locale file; `<html lang>` matches; position uses ICU `selectordinal`.
6. Disabled = 40% opacity fade; resting inputs = `--border` hairline; focus = accent ring.
7. TV 10-foot rules hold in all vibes/themes (≥28px @1080p equivalent, contrast ≥7:1 for must-read text).
8. Touch targets ≥48px; patron body ≥16px (unchanged from v1 — still binding).
9. Host chrome on TV never overlaps content (reserve rail space or auto-hide, audit T2).
10. Running tonight's queue is never gated behind signup; the account hook sells history, it doesn't block operation.

## Component → mockup map (for ticket-writing)

| New/changed component | Mockup | Notes |
|---|---|---|
| Wordmark | all | `--brand-name` + `--g-brand` text-clip |
| Venue identity header (monogram/logo + name + sub) | patron, admin, tv-* | precedence: logo → name → subtitle → cantai |
| Language sheet + theme toggle + util pills | switchers, all headers | native names, no flags; Auto default |
| Vibe picker + accent swatches | switchers §3 | contrast auto-adjust, show corrected color |
| Position-hero card | patron (tela 3) | ICU ordinal + ETA; per-vibe copy |
| Mode cards (join) / song result row / paste-link fallback card | patron | v1 spec revived, thumbnails required |
| Copy-field (URL / host code) | admin-live | one-tap copy, code masked after first view |
| Queue row + drag handle + "▶ Cantar agora" + remove | admin-live | pin = position 2; confirm on remove |
| Host add-song strip | admin-live | host assigns singer/table; "pedido do palco" default |
| Now-playing hero (admin) | admin-live | progress bar, skip/no-show/pause cluster |
| Tabs (Ao vivo / Histórico 🔒) + hook banner + blurred teaser | admin-live | lock icon only when logged out |
| Session card / timeline row / rank bars / hour bars | admin-history | pure presentational; data from session events |
| TV layout w/ progress + reserved rail | tv-bar/party/corporate | one DOM, vibes via attributes only |

## Open items for the TL (W-design gate)

1. **Vibe set + naming** — bar / festa(party) / casamento / empresa: right four? (Architecture is N-vibe; these are the presets.)
2. **Corporate = no gradient, no emoji** — confirm the sobriety level.
3. **Light theme on TV** allowed for festa/corporate only — or everywhere?
4. **Language tiering** — pt-BR/en/es at launch, ja/ko/zh as the "karaoke-culture" wave: agree?
5. **History retention hook copy** — "as noites somem em 7 dias sem conta": is 7 days the real policy? (Design assumes yes; it's the urgency lever.)
6. **Rename readiness** — wordmark is fully swappable; no new name assumed. Naming research (parallel ticket) plugs into `--brand-name`.
