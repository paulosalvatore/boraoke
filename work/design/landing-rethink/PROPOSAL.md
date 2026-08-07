# Landing rethink + TICKET-66 accent fix — design proposal

**For:** Tech Lead decision. **Scope:** proposal + static mockups only — no product code touched.
**Mockups:** `mockup-1-qualquer-festa.html` · `mockup-2-demo-vivo.html` · `mockup-3-balcao-do-dono.html` (self-contained, open directly in a browser). Screenshots (desktop 1440 / mobile 390) in `screenshots/`, including `current-desktop.png` / `current-mobile.png` for before/after.

## What's wrong with the current page (grounded in `screenshots/current-*.png`)

The live landing is a title, a two-line tagline, one CTA ("Criar a sala do seu bar") and a join-code box. It never mentions: the TV screen, YouTube search, the three rotation modes (the actual differentiator), host controls, sing-vs-listen, the free promise, or any venue beyond a bar. The footer even says "uma sala por bar". A visitor who isn't a bar owner has no reason to stay; a bar owner has no idea what they're getting. It undersells on every axis and the bar-only framing actively fights the Phase-3 multi-venue direction.

Everything the mockups claim is shipped today (verified against `work/roadmap.md` "LIVE" section): QR join + tables, YouTube search + URL paste, /tv auto-advance, 3 rotation modes, host moderation/reorder/pause, read-only analytics, sing/listen entries, pt-BR/en/es. No Phase-2+ feature (accounts, theming presets, payments) is advertised.

## Direction 1 — "Pra qualquer festa" (venue-agnostic manifesto)

**Hook:** *Karaokê com fila justa, em qualquer lugar com uma TV.* The venue-type generalization made explicit today, with a full marketing-page structure.

- **Structure:** header (brand + "Grátis · acesso antecipado" pill) → hero + dual CTA → Como funciona (3 steps: QR → escolhe no celular → TV toca sozinha) → fairness section with the 3 modes as cards ("Ninguém monopoliza o microfone") → venue grid (bar / festa / condomínio / empresa) → host-controls chips → join-code card → free-promise block → footer.
- **Primary CTA:** **"Criar minha sala grátis"** · en "Create my room — free" · es "Crear mi sala gratis". Above the fold, one click to `/new`. Secondary ghost button anchors to the join box.
- **Fairness:** its own named section — the three modes are first-class cards, plus the sing-vs-listen line.
- **QR flow:** step 1–2 of "Como funciona".
- **Venue story:** equal-weight 4-card grid; bar first but not privileged. Honest copy: "é a mesma sala, criada do mesmo jeito" — true today, no presets promised.
- **Cuts vs current:** the "uma sala por bar" footer line; bar-possessive CTA. Keeps SavedRooms slot and join box.
- **Risk:** longest page; the venue grid slightly over-signals generality before per-type presets exist (copy is written to stay honest).

## Direction 2 — "Demo vivo" (show, don't tell) — RECOMMENDED

**Hook:** *A fila do karaokê na TV. O controle, na mão de todo mundo.* The hero IS the product: a mocked /tv screen (now-playing hero + up-next rail with names/tables + a "rodízio: uma por pessoa" tag) with a QR phone card hanging off it. One glance explains QR-join, the queue, tables, sing/listen and fairness before a word is read.

- **Structure:** header → venue chips (No bar · Na festa · No condomínio · Na empresa) → split hero: copy + CTA left, TV+QR mock right → 3 terse bullets (QR sem app / qualquer música do YouTube / rodízio justo) → compact join strip → free-promise footer. That's the whole page.
- **Primary CTA:** **"Começar agora — é grátis"** · en "Start now — it's free" · es "Empezar ahora — es gratis". Microcopy under it: "Sua sala fica pronta em 30 segundos, com TV e QR incluídos."
- **Fairness:** shown, not told — the rotation tag on the TV mock + the up-next rail alternating tables + one bullet naming all three modes.
- **QR flow:** literally pictured (phone card: "Escaneou, entrou").
- **Venue story:** lightweight chips above the H1 — widens the frame without a whole section; ready to become real preset-switching chips in Phase 3.
- **Cuts:** how-it-works steps, mode cards, host-controls section — the demo carries them. Shortest credible page.
- **Why recommended:** boraoke's magic is visual (screen + phones). This is the only direction where a visitor *sees* the product in second one; it's the shortest path to "I get it", it scales naturally into the Phase-3 venue presets (chips), and it keeps the create CTA highest above the fold of all three. If the TL wants a safer/fuller page, Direction 1 is the fallback; the two can also converge later (D2 hero + D1 fairness section).

## Direction 3 — "Balcão do dono" (operator conversion, bar-first)

**Hook:** *Aposenta o caderninho do karaokê.* Speaks only to tonight's actual buyer — the bar owner — with a pain-led headline and a what-you-get checklist. Deliberately the counter-proposal: it argues today's traffic is bar owners and generalization belongs in Phase 3, not on the homepage yet.

- **Structure (single 620px column):** header → pain headline + sub ("pronta em 30 segundos, grátis") → big CTA + trust microcopy (sem cadastro / sem app / grátis) → checklist card (tela de TV, QR, rodízio justo 3 modos, painel do host, estatísticas) → one-line venue widening ("Não é um bar? Funciona igual em festas, condomínios e empresas") → join box → free promise → footer.
- **Primary CTA:** keeps **"Criar a sala do meu bar"** ("Create my bar's room" / "Crear la sala de mi bar").
- **Fairness:** one checklist row naming all 3 modes. **QR flow:** one checklist row.
- **Venue story:** demoted to a single dashed-border aside.
- **Risk:** perpetuates the bar-only first impression the roadmap is moving away from; weakest strategic fit, strongest single-persona conversion.

## Common to all three (proposed copy-level fixes)

Free-forever promise stated on-page ("Tudo o que existe hoje é grátis — e continua grátis"); trilingual signal; "pronta em 30 segundos"; join-code box kept but demoted below the create CTA; the `create → /new` action never more than one click and never below the first viewport.

## TICKET-66 — accent contrast (full math in `CONTRAST.md`)

A single darkened accent hex is **mathematically impossible**: white-on-accent ≥4.5:1 needs a darker red, accent-as-text-on-dark ≥4.5:1 needs a lighter one. Any one-hex "fix" breaks the other direction (and the audit found a third, latent failure the suite doesn't test yet: `#e63946` as text on `--surface` = **4.18:1** — admin/patron error text, SavedRooms links).

**Recommended (Option B — role split, ~6-line CSS diff):** keep `--accent #e63946` for borders/focus/large text; add
`--accent-strong: #d92330` for CTA backgrounds and `--accent-text: #ee5a64` for accent-as-text.

| Pair | Ratio | Verdict |
|---|---|---|
| `#fff` on `--accent-strong #d92330` (`.btn-primary`) | **4.96:1** | PASS (was 4.17) |
| `#fff` on `#c1121f` hover (unchanged) | 6.22:1 | PASS |
| `--accent-text #ee5a64` on mode-switcher tint `rgb(33,17,18)` | **5.45:1** | PASS (was 4.37) |
| `--accent-text #ee5a64` on `--bg` / `--surface` | 5.81 / 5.21 | PASS (fixes the latent 4.18) |
| `--accent #e63946` as non-text UI (borders/focus) on bg/surface | 4.66 / 4.18 | PASS (3:1 bar) |

`#d92330` is the same hue family, ~7% darker luminance — side-by-side in the mockups it still reads as the brand red (all three mockups already use this palette). Unskips both `test.fixme` blocks AND pre-empts the third failure.

**Minimal-change alternative (Option A — no new tokens, 3 lines):** `.btn-primary` background → existing `--accent-hover #c1121f` (white = **6.22:1**), hover → `#a50e19` (7.85:1); mode-switcher tint alpha `.09` → `.05` (accent label = **4.52:1**, margin of only 0.02). Leaves the latent surface failure unfixed and the CTAs go noticeably darker than the brand red.

**Decision needed from the TL:** Option B (recommended) vs Option A (smallest diff). Either way the fix is a token-level CSS change; the implementing dev unskips the two `test.fixme` blocks in `e2e/contrast.spec.ts` as acceptance.

## Decision list (everything this proposal needs from the TL)

1. Landing direction: **2 (recommended)** / 1 / 3 — or a named hybrid.
2. Primary CTA wording (per chosen direction; all keep one-click create).
3. TICKET-66: **Option B (recommended)** or Option A.
