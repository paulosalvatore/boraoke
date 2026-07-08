# Boraoke — Launch Brand Kit (TICKET-33a)

- **Date:** 2026-07-07
- **Product:** cantai → rebranding to **Boraoke** (boraoke.com; "bora" = pt-BR "let's go" + karaoke)
- **Role:** Designer
- **Status:** Generated brand-asset kit, pending W-design TL gate

## Art direction

The Boraoke brand is a direct **evolution of the v1 "palco de bar" language** (see `work/design/design-system.md`), not a replacement. What carries over: the neon raspberry `#FF3D71` + warm amber `#FFC24B` accent pair, the near-black plum `#0D0A14` ground, the pink→amber **stage gradient**, and the lowercase warm-rounded voice ("boraoke", never capitalized — same rule as "cantai"). What evolved for v2: the mark got a real icon (v1 had wordmark-only), shapes are chunkier and more professional (solid filled silhouettes, no thin neon outlines), and the imagery reads as "any warm venue with a mic" — bar, house party, event — instead of bar-only.

**The mark:** a rounded microphone silhouette with a **play-button triangle knocked out of its head** — mic (you sing) + play/queue (the app queues your song) in one glyph. It survives 32px, works one-color, and is unmistakably karaoke-tech without being cyberpunk-cold.

## Assets

All finals in `public/brand/` (web-servable). Engine noted per asset; ChatGPT was requested first per TL, but it timed out repeatedly and produced weak/garbled results, so the kit is predominantly **Gemini (AI Studio / Nano Banana)** — see per-asset notes.

| Asset | Size | Engine | Attempts | Notes |
|---|---|---|---|---|
| `logo-mark.png` | 1024×558 | gemini | 3 (gpt timeout → gemini w/ fake-checkerboard bg → gemini on plum) | Solid mic + play-cutout mark, gradient fill, on solid `#0D0A14`. |
| `wordmark.png` | 1024×558 | gemini | 3 (gpt garbled "boaoke" → gemini w/ white sticker outline + fake checkerboard → gemini on plum) | Correct spelling, rounded extra-bold, pink→amber gradient, on solid `#0D0A14`. |
| `app-icon.png` | 1024×1024 | gemini | 3 (gpt timeout → gpt half-white/broken → gemini) | Mark + soft spotlight glow, ~55% canvas, full-bleed dark plum. Ready for iOS/Android masking. |
| `og-image-pt-BR.png` | 1200×633 | gemini | 2 (gpt timeout → gemini) | Wordmark + "Bora cantar!" + TV/phone queue illustration, twin stage-light beams. Both texts spelled correctly. Crop 3px height for exact 1200×630. |
| `tv-idle-poster.png` | 1376×768 | gemini | 1 | Spotlit mic on empty stage, pink/amber wash, bokeh crowd. Zero text as briefed (app renders text). 16:9-ish; upscale/cover-fit to 1920×1080. |
| `favicon-source.png` | 512×279 | gemini | 1 | One-color solid raspberry mark on plum, no gradient, reads at 16px. Crop square before generating favicon sizes. |

## Usage guidance

- **Backgrounds:** all assets are baked on solid `#0D0A14` (true transparent PNG output is not reliable from either engine — Gemini paints a *fake* checkerboard when asked for transparency, which is worse). Place them on `--c-bg` surfaces and they blend seamlessly; do NOT place on light backgrounds until a vector/transparent pass exists.
- **logo-mark / favicon-source:** use for avatars, favicons, loading marks. The favicon-source is deliberately single-color for 16–32px legibility; use the gradient mark ≥ 48px.
- **wordmark:** header/landing hero on dark surfaces. Pair with the tagline "Bora cantar!" in `--c-text`.
- **og-image (per-locale scheme):** social/OG cards are per-language, named `og-image-<locale>.png` (BCP-47 tag). Current: `og-image-pt-BR.png` (tagline "Bora cantar!"). Next up: `og-image-en.png` ("Let's sing!") and `og-image-es.png` ("¡A cantar!"); future languages follow the same `og-image-<locale>.png` pattern — identical composition, localized tagline only. Serve via `<meta property="og:image">`; crop to exactly 1200×630 at integration time.
- **tv-idle-poster:** `/tv` idle backdrop under a dark scrim; center/lower-third kept darker by design so the join QR + URL overlay stays readable.
- **Voice:** "boraoke" always lowercase in the wordmark; sentence case "Boraoke" acceptable in running prose.

## Needs a human designer pass (before 1.0)

1. **Vector tracing** — every asset is raster AI output. The mark and wordmark need an SVG redraw (the mark is simple geometry; ~1h in Figma/Illustrator) to get true transparency, crisp scaling, and a light-background variant.
2. **Exact-dimension exports** — og 1200×630 crop, poster 1920×1080 upscale or re-render, favicon square crop + 16/32/48 ICO set, iOS/Android icon size matrix.
3. **Wordmark/mark lockup** — a combined horizontal lockup (mark + wordmark) wasn't generated; compose it after vectorization.
4. **Type decision** — the wordmark implies a Baloo/Nunito-class rounded face; pick and self-host the actual UI display font to match (design-system v1 deferred this too).
5. **Consistency check** — mark proportions differ slightly across logo-mark / app-icon / favicon-source (three separate generations); the vector pass should unify to one canonical geometry.
