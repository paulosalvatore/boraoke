/** Single source for the spike's test set — see eval.mjs header for provenance. */
export const PRODUCTION_QUERIES = [
  // partial words (patron mid-typing) — the dominant real shape
  { q: "escu karaoke",                     want: ["escurinho"],                 kind: "partial" },
  { q: "escurinho d karaoke",              want: ["escurinho"],                 kind: "partial" },
  { q: "escurinho do cin karaoke",         want: ["escurinho", "cinema"],       kind: "partial" },
  { q: "borbu karaoke",                    want: ["borbulhas"],                 kind: "partial" },
  { q: "borb karaoke",                     want: ["borbulhas"],                 kind: "partial" },
  { q: "vida de gad karaoke",              want: ["vida", "gado"],              kind: "partial" },
  { q: "boquinha da g karaoke",            want: ["boquinha", "garrafa"],       kind: "partial" },
  { q: "cerol na karaoke",                 want: ["cerol"],                     kind: "partial" },
  { q: "evide",                            want: ["evidencias"],                kind: "partial" },
  { q: "zé ram",                           want: ["ze", "ramalho"],             kind: "partial" },
  { q: "zé rama",                          want: ["ze", "ramalho"],             kind: "partial" },
  { q: "banderille karaoke",               want: ["bandoleros"],                kind: "partial" },
  { q: "musical jm feliz",                 want: ["feliz"],                     kind: "partial" },
  // typos / adjacent-key slips
  { q: "soda stete karaoke",               want: ["soda", "stereo"],            kind: "typo" },
  { q: "olha a onfs karaoke",              want: ["olha", "onda"],              kind: "typo" },
  { q: "cerol na mao karaoke",             want: ["cerol", "mao"],              kind: "typo" },
  { q: "banderilleros karaoke",            want: ["bandoleros"],                kind: "typo" },
  { q: "quien se hay tomado tofo",         want: ["tomado"],                    kind: "typo" },
  // accent present / absent
  { q: "evidências",                       want: ["evidencias"],                kind: "accent" },
  { q: "maná",                             want: ["mana"],                      kind: "accent" },
  { q: "mana",                             want: ["mana"],                      kind: "accent" },
  { q: "parabéns pra você",                want: ["parabens"],                  kind: "accent" },
  { q: "com quem será",                    want: ["quem", "sera"],              kind: "accent" },
  // fully-typed titles (the shape search-on-submit would produce)
  { q: "escurinho do cinema karaoke",      want: ["escurinho", "cinema"],       kind: "complete" },
  { q: "vida de gado karaoke",             want: ["vida", "gado"],              kind: "complete" },
  { q: "boquinha da garrafa karaoke",      want: ["boquinha", "garrafa"],       kind: "complete" },
  { q: "na boca da garrafa karaoke",       want: ["boca", "garrafa"],           kind: "complete" },
  { q: "cerol na mão karaoke",             want: ["cerol", "mao"],              kind: "complete" },
  { q: "soda stereo karaoke",              want: ["soda"],                      kind: "complete" },
  { q: "zé ramalho karaoke",               want: ["ze", "ramalho"],             kind: "complete" },
  { q: "rita lee escurinho karaoke",       want: ["escurinho"],                 kind: "complete" },
  { q: "bad guy karaoke",                  want: ["bad", "guy"],                kind: "complete" },
];

/** Real production strings a human cannot disambiguate either. */
export const UNGRADABLE = ["alo s karaoke", "alord karaoke", "alors karaoke", "aloés karaoke",
  "qlos karaoke", "slod karaoke", "bsf", "con", "día", "eita", "cumbia", "band karaoke",
  "na você karaoke", "bor karaoke", "parabéns outras vixe", "loser", "lose yourself karaoke",
  "raúl karaoke", "rita karaoke", "quien"];
