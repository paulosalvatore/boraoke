# TICKET-84 — Four visual directions for the boraoke redesign

Context: the current product design was rejected as "AI generated style… very ugly or very basic" (dark gradient, emoji icons, generic components — see `screenshots/current-*.png` for the baseline). The four directions below are four *points of view* on what a karaoke night is, not four colour schemes. Each is judged against the two real surfaces: a venue TV read across a noisy room, and a phone held one-handed in low light at a bar. Only shipped functionality is depicted (QR join with mesa, YouTube search + paste-a-link, `/tv` auto-advance with now-playing hero and up-next rail, three rotation modes, host moderation, sing-vs-listen, pt-BR/en/es).

Every mockup is self-contained HTML in this directory; before/after pairs live in `screenshots/`. All four directions verified `document.documentElement.scrollWidth <= window.innerWidth` at 390px with webfonts loaded (16 file/viewport combinations).

---

## D1 «Letreiro» — the boteco marquee

**Point of view:** karaoke as a neighborhood-bar institution. The TV is the bar's letreiro — warm, cordial, a piece of the furniture. For venues that want the product to feel like it has always belonged there.

**Palette:** `--verde-garrafa #17452B` (bottle green, ground), `--verde-sombra #0E2F1D` (shadow green), `--cal #F4EBD9` (whitewash cream, text/cards), `--cal-suja #E4D8BE` (aged cream), `--amarelo #F2B705` (mustard, accent/CTA), `--vermelho #B33A2B` (brick red, "Agora" stamps).

**Type:** Alfa Slab One (brand and display — the painted-sign slab), Oswald (condensed caps for singer names and labels — the letreiro letters), Asap (body).

**Layout concept:** TV is a framed sign — double-ruled borders, video hero left, "Hoje no palco" bill right, cream now-singing plaque across the bottom. Phone is a green-ground single column with cream cards; landing is the same sign language stretched vertical.

**Aesthetic risk:** nostalgia. It can tip from "beloved boteco" into rustic menu-template kitsch, and the slab-plus-text-shadow voice gets heavy if applied without restraint.

**Implementation cost:** medium-low. Flat CSS, conventional grid, no effects; three webfont families. Ports to the Next app cleanly.

## D2 «Placar» — the night as a live broadcast

**Point of view:** fairness made visible. The queue is a scoreboard and the night is a transmission — "AO VIVO" chip, angled panels, tabular rail. The product-as-utility view: nobody argues with the placar, and everyone can read it from the back of the room.

**Palette:** `--noite #0A1C36` (broadcast navy, ground), `--noite-2 #10294D` (panel navy), `--gelo #E9F1FC` (ice, text), `--ambar #FFB300` (amber, positions/CTA), `--live #34D27B` (live green, status), `--cinza-az #8CA3C3` (steel blue, secondary).

**Type:** Big Shoulders Display (compressed scoreboard caps for names and numbers), Barlow (body), Chivo Mono (mesa tags, labels, the machine parts).

**Layout concept:** TV is a broadcast frame — angled header ribbon, video filling the left, "A seguir" rail right with oversized amber position numbers, lower-third for the current singer. Phone is a dark dashboard with a "você é 3º" hero chip; landing sells the telão with a live placar card.

**Aesthetic risk:** safety. It is the most conservative of the four and can read as sports-app generic — competent rather than characterful. If the TL's complaint is blandness, this is the direction that mitigates it least.

**Implementation cost:** lowest. It is closest to conventional component design and systematizes directly into tokens; the angled clips are single `clip-path`s.

## D3 «Comanda» — the paper ficha ritual

**Point of view:** joining the queue is being handed a ticket at a festa. Brazilian bar-service paper culture — comanda, ficha, senha — digitized: perforations, serial numbers, rubber-stamp rotation, paper shadows. The warmest and most distinctly *ours* of the four.

**Palette:** `--papel #FBF6EC` (paper, ground), `--papel-sombra #EFE6D3` (paper shadow), `--tinta #2A2E6E` (ink navy, text/borders), `--laranja #FF5A1F` (order-pad orange, the "sua ficha" colour), `--verde #178F5A` (stamp green), `--rosa #E94F8A` (stamp pink, "dança").

**Type:** Shrikhand (display — the hand-painted ticket numerals and headings), Karla (body), IBM Plex Mono (serials `Nº 043`, mesa tags — the printed machine text).

**Layout concept:** everything is a ticket. TV: video panel left, the current singer's ficha as a giant orange ticket right, the up-next queue as a shelf of paper stubs along the bottom. Phone: your ficha pinned at top ("3º — faltam 2 músicas"), queue as a stack of slightly-rotated stubs. Landing: a collage of overlapping fichas.

**Aesthetic risk:** two real ones. The light paper TV screen is the odd one out — a bright screen in a dim bar glares where the other three recede — and the collage language (rotations, absolute-positioned stubs) is exactly the CSS that produced this ticket's 450px mobile overflow; it demands ongoing responsive discipline.

**Implementation cost:** highest. Rotations, dashed perforations, layered paper shadows and the collage hero all need careful per-breakpoint work, and the TV likely wants a dark "chalkboard" inversion for real venues.

## D4 «Madrugada» — the small-hours party flyer

**Point of view:** the night out itself. Chrome display type, neon pink and laser green on near-black, marquee line-up ticker — the balada flyer taped to the door. Aimed at the crowd that comes for the vibe, not the venue owner.

**Palette:** `--breu #120817` (pitch black-violet, ground), `--roxo #2B1140` (deep purple, panels), `--pink #FF3DAE` (neon pink, primary accent), `--laser #7CFF4F` (laser green, secondary accent/status), `--nevoa #C9BAD6` (violet-grey mist, secondary text).

**Type:** Anton (the chrome-gradient display caps, skewed), Chakra Petch (techy body and labels).

**Layout concept:** TV is a stage frame — pink-bordered video, "LINE-UP" panel right, green-boxed QR card ("Cola no baile"). Phone is a dark flyer column with glowing mode buttons; landing leads with giant chrome "BORA CANTAR" and a scrolling line-up marquee.

**Aesthetic risk:** proximity to the accusation. Neon-synthwave glow is itself an AI-art cliché, so executed without restraint this lands back at "AI generated style"; glows also band on cheap 1080p venue TVs and cost legibility in brightly-lit rooms.

**Implementation cost:** medium-high. The effects are cheap CSS (gradients, `background-clip` chrome, shadows) but the taste ceiling is low — it needs constant restraint tuning, and the marquee needs reduced-motion handling.

---

## Recommendation

**D2 «Placar» for the product surfaces (TV + phone), with D3's voice held as the brand's second register.**

Reasoning: both real surfaces are dark-environment legibility problems, and D2 is the only direction *engineered* around that — compressed high-contrast caps read across a noisy room, the dark navy phone is kind to eyes at a bar table, and the scoreboard metaphor makes the product's actual promise (a fair, visible queue — three rotation modes, no mic-hogging) the aesthetic itself. It is also the cheapest to implement well, which matters for a solo-run product. Its admitted risk is safeness; the mitigation is to keep D2's structure but let the pt-BR copy voice and the amber/live-green accents carry personality, not to add decoration.

D3 is the strongest *identity* of the four and the best landing-page story ("funciona como fichinha de festa" explains the product in one image) — if the TL wants maximum brand distinctiveness and accepts the highest implementation cost plus a dark TV inversion, it is the bold choice. D1 is the venue-pleaser but risks kitsch; D4 is the most fun and the most dangerous, since it flirts with the exact style being escaped.

A workable split, if choosing one point of view feels premature: D2 as the product design system now, D3's ticket language reserved for the landing and marketing surfaces. But if it must be one: D2.

## Verification notes

- **D3 mobile overflow, root cause:** the hero ticket pile — absolutely-positioned fixed-width 320px `.tk` cards with percentage offsets inside a 334px column — pushed `d3-comanda-landing.html` to 450px at a 390px viewport. The genuine fix (breakpoint rules: `width: min(320px, 82vw)`, reduced offsets, `overflow: clip` on the hero, serpentina hidden) was present, but a masking `body { overflow-x: hidden }` had been left in both d3 and d4 landings and the d3 landing 390px screenshot was stale (still 450px wide). The masks are removed, the pages pass honestly, and the screenshot was recaptured.
- All 16 mockup/viewport combinations pass `scrollWidth <= innerWidth` (phone + landing at 390, landing at 1440, TV at 1920) with `document.fonts` confirmed loaded (Shrikhand/Karla/IBM Plex Mono, Alfa Slab One/Oswald/Asap, Big Shoulders/Barlow/Chivo Mono, Anton/Chakra Petch) — no fallback-font captures.
- `current-*.png` baselines were captured from the real app (dev server on :3192, this worktree) with a seeded live queue over validated YouTube video IDs, so the TV shows the shipped now-playing hero + up-next rail and the phone shows the joined patron view. No `.env` present, so YouTube *search* is degraded (paste-a-link path used) — expected.
