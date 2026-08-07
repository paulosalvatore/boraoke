# Contrast proof — TICKET-66 proposal + landing-rethink mockup palette

All ratios computed with the WCAG 2.x relative-luminance formula (not eyeballed). Thresholds: **4.5:1** normal text, **3:1** large text (≥24px, or ≥18.66px bold) and non-text UI. Composites resolved with straight alpha over the named opaque backdrop.

## Current state (why TICKET-66 exists)

| # | Foreground | Background | Ratio | 4.5:1 | 3:1 | Where |
|---|---|---|---|---|---|---|
| C1 | `#ffffff` | `--accent #e63946` | **4.17** | FAIL | pass | `.btn-primary` — every primary CTA (landing create, join, submit-song) |
| C2 | `#e63946` | `rgba(230,57,70,.09)` over `#0d0d0d` → `rgb(33,17,18)` | **4.37** | FAIL | pass | Admin active mode-switcher label (16px/800 — not large text) |
| C3 | `#e63946` | `--surface #1a1a1a` | **4.18** | FAIL | pass | **Latent, untested by the suite**: accent used as normal-size text on cards — admin `.error`, patron error/rejected text, SavedRooms links, SongSearch status |
| C4 | `#e63946` | `--bg #0d0d0d` | 4.66 | pass | pass | Accent links directly on page bg (barely passes today) |

## Recommended palette (Option B — token split, three roles)

`--accent #e63946` stays the brand hue for borders, focus rings, badges and large/decorative text. Two derived tokens do the AA-critical work:

| Token | Hex | Role |
|---|---|---|
| `--accent` | `#e63946` (unchanged) | borders, focus, non-text UI, large text ≥18.66px bold |
| `--accent-strong` | `#d92330` | filled CTA background (white text) |
| `--accent-hover` | `#c1121f` (unchanged) | CTA hover |
| `--accent-text` | `#ee5a64` | accent used AS text on dark backgrounds |

### Proof — every proposed pair

| # | Foreground | Background | Ratio | 4.5:1 | 3:1 |
|---|---|---|---|---|---|
| P1 | `#ffffff` | `--accent-strong #d92330` | **4.96** | **PASS** | pass |
| P2 | `#ffffff` | `--accent-hover #c1121f` (hover) | **6.22** | **PASS** | pass |
| P3 | `--accent-text #ee5a64` | `--bg #0d0d0d` | **5.81** | **PASS** | pass |
| P4 | `--accent-text #ee5a64` | `--surface #1a1a1a` | **5.21** | **PASS** | pass |
| P5 | `--accent-text #ee5a64` | accent tint `rgba(230,57,70,.09)` over `#0d0d0d` → `rgb(33,17,18)` | **5.45** | **PASS** | pass — fixes C2 (label → `--accent-text`, tint untouched) |
| P6 | `--accent #e63946` (non-text UI: borders, focus ring) | `#0d0d0d` / `#1a1a1a` | 4.66 / 4.18 | n/a | **PASS** (3:1 UI bar) |
| P7 | `--text #f1f1f1` | `#0d0d0d` / `#1a1a1a` | 17.21 / 15.41 | PASS | pass |
| P8 | muted `#9a9a9a` (mockups; lightened from `#888`) | `#0d0d0d` / `#1a1a1a` | 6.91 / 6.19 | PASS | pass |
| P9 | current muted `#888` | `#0d0d0d` / `#1a1a1a` | 5.48 / 4.91 | PASS | pass (no change required; `#9a9a9a` is a comfort upgrade, optional) |

Result: C1 fixed by P1, C2 fixed by P5, C3 (latent) fixed by P4. No pair anywhere in the proposal sits below 4.5:1 as text.

## Minimal-change alternative (Option A — no new hex, 3-line CSS diff)

| Change | Pair | Ratio | 4.5:1 |
|---|---|---|---|
| `.btn-primary` background: `var(--accent)` → `var(--accent-hover)` (`#c1121f`, already a token) | `#fff` on `#c1121f` | **6.22** | **PASS** |
| `.btn-primary:hover` background → `#a50e19` (only new value; hover state, not itself AA-gated) | `#fff` on `#a50e19` | **7.85** | PASS |
| ModeSwitcher active tint `rgba(230,57,70,.09)` → `.05` (label keeps `#e63946`) | `#e63946` on `rgb(24,15,16)` | **4.52** | **PASS** (thin margin — 0.02) |

Caveats: leaves latent C3 (4.18 on surface) unfixed; CTA buttons get visibly darker/moodier than the brand red; the mode-switcher margin is razor-thin (any future bg lightening re-fails it).

## Rejected: single-hex darken of `--accent`

The two constraints are mathematically incompatible for one hex: white-text-on-accent ≥4.5 requires luminance ≤0.183 (e.g. `#e42735` → 4.53), but every such candidate drops accent-as-text below AA everywhere it is a foreground (`#e42735` on `#0d0d0d` = 4.29, on `#1a1a1a` = 3.85, on tint = 4.08). Darkening the accent fixes C1 while making C2/C3/C4 worse. Hence the role split.

## Badges (unchanged, for completeness)

`.badge-sing` `#60a5fa` on `#2563eb22`-over-surface and `.badge-listen` `#4ade80` on `#16a34a22`-over-surface were already AA-green in the TICKET-60 suite; this proposal does not touch them.
