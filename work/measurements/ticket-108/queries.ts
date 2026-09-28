/**
 * TICKET-108 measurement — the graded query set.
 *
 * COPIED VERBATIM (data lines untouched) from the TICKET-106 spike's single
 * source, `work/spikes/ticket-106/queries.mjs` on branch `ticket/106-search-quota`:
 *
 *     git show origin/ticket/106-search-quota:work/spikes/ticket-106/queries.mjs
 *
 * Only the module syntax is adapted (ESM .mjs → TS, so the harness can import the
 * product's own `lib/search-prefix.ts` in the same process). The 32 graded `q`
 * strings and their `want` ground truth are BYTE-IDENTICAL to the spike's, which
 * is what makes the before/after quality numbers comparable to its 66% figure.
 *
 * Provenance of the data itself (from the spike): every `q` was typed by a real
 * patron into production boraoke and exists verbatim as an `sc:BR::<q>` key in
 * the production search cache. `want` is derived from the LONGEST member of the
 * same keystroke family — what that patron eventually finished typing — so ground
 * truth is the patron's demonstrated intent, not anybody's guess.
 */

export interface GradedQuery {
  q: string;
  want: string[];
  kind: "partial" | "typo" | "accent" | "complete";
}

export const PRODUCTION_QUERIES: GradedQuery[] = [
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
export const UNGRADABLE: string[] = ["alo s karaoke", "alord karaoke", "alors karaoke", "aloés karaoke",
  "qlos karaoke", "slod karaoke", "bsf", "con", "día", "eita", "cumbia", "band karaoke",
  "na você karaoke", "bor karaoke", "parabéns outras vixe", "loser", "lose yourself karaoke",
  "raúl karaoke", "rita karaoke", "quien"];
