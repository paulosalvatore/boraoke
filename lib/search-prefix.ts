/**
 * Prefix-extension search planning (TICKET-108) — the pure decision layer that
 * stops boraoke billing one `search.list` call per keystroke.
 *
 * WHY THIS EXISTS (measured, not theorised — see work/reports/dev/TICKET-108-dev-report.md
 * and the TICKET-106 spike):
 *
 *   Production day 2026-09-26 spent its whole 90-call patron budget (`sb:` counter
 *   read 90/90) to queue 24 songs — 3.75 billed `search.list` calls per queued
 *   song. The cause is not venue volume: `SongSearch` searched as you type on a
 *   400ms debounce, so every typing pause billed a fresh call against a query
 *   string nobody had ever typed before (a guaranteed cache miss by construction).
 *   ONE patron typing "escurinho do cinema" burned TWELVE of the platform's 90
 *   daily calls: `esc → escu → escur → escuri → escurinh → escurinho → escurinho
 *   do → escurinho do c → … → escurinho do cinema`.
 *
 * THE FIX: one `search.list` call returns up to 50 rows (SEARCH_DEFAULTS.maxResults).
 * While the patron keeps EXTENDING a query we already hold results for, narrow
 * those held rows locally instead of asking Google the same question again.
 *
 * THE GUARDRAIL THAT MAKES IT SAFE — and it is the whole reason this is a
 * decision function rather than a blanket "never refetch an extension":
 *
 *   A short prefix's top-50 may simply not contain the song a longer query would
 *   return. "esc karaoke" does not surface Rita Lee's "Escurinho do Cinema"; only
 *   "escu karaoke" starts to. If we filtered blindly, the quota graph would look
 *   excellent while the patron's results silently got WORSE — a false win.
 *
 *   So local filtering is only taken while it still yields at least
 *   `minLocalMatches` rows. The moment narrowing STARVES (the held page cannot
 *   answer the longer query), that is positive evidence the held page is the
 *   wrong page, and we spend a call — landing the fetch on a prefix that does
 *   surface the song. Measured against the 32 real production queries from the
 *   TICKET-106 spike, this holds hit@10 exactly while cutting billed calls ~4x.
 *
 * This module is intentionally PURE and free of React and of `server-only`:
 * jest here is node-env (no jsdom), so the decision logic must be unit-testable
 * directly rather than through the component.
 */

import type { SearchResult } from "@/lib/youtube-search";

/**
 * Words that carry no discriminating signal in a karaoke catalogue and are
 * therefore NOT required to be present in a row for it to count as a local
 * match. Two distinct classes, both measured:
 *
 *  - Portuguese/Spanish/English articles and connectives ("do", "da", "de"…).
 *    Real YouTube titles drop or reorder them freely ("Escurinho Cinema",
 *    "Boquinha da Garrafa" vs "Boquinha Garrafa"), so requiring them costs
 *    recall for no precision.
 *  - Karaoke boilerplate ("karaoke", "playback", "instrumental"…). In sing mode
 *    the outgoing query is augmented with "karaoke" (`augmentQuery`), and
 *    patrons type it themselves too; requiring it would reject perfectly good
 *    rows whose title and channel happen not to spell it.
 *
 * Diacritic-folded and lowercase, because that is the form `normalizeQuery`
 * produces.
 */
const NON_DISCRIMINATING = new Set([
  // articles / connectives
  "a", "o", "e", "as", "os", "da", "do", "de", "das", "dos", "na", "no", "em",
  "um", "uma", "la", "el", "y", "the", "of",
  // karaoke boilerplate
  "karaoke", "playback", "instrumental", "cover", "videoke", "letra",
]);

/**
 * Discriminating tokens of a query: normalized, minus the articles/boilerplate
 * above. Shared with the karaoke index matcher (lib/karaoke-index/matcher.ts) so
 * "what counts as a real search word" has exactly one definition.
 */
export function discriminatingTokens(s: string): string[] {
  return queryTokens(s).filter((t) => !NON_DISCRIMINATING.has(t));
}

/** Strip combining diacritical marks (NFD decomposition, then drop U+0300–U+036F). */
function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * The comparison form for everything in this module: lowercase, diacritic-free,
 * punctuation collapsed to single spaces, trimmed.
 *
 * Diacritic folding matters on BOTH sides of every comparison here: patrons type
 * "evidencias" and "evidências" interchangeably (measured — both exist as real
 * production cache keys), and `maná`/`mana` likewise. Without folding, adding
 * the accent to an already-typed word would read as a NON-extension and bill a
 * fresh call for a query we already hold.
 */
export function normalizeQuery(s: string): string {
  return stripDiacritics(String(s).toLowerCase())
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fallback for `NOT_WORD_CHAR` on engines without Unicode property escapes:
 * whitespace plus ASCII, Latin-1, General Punctuation and CJK punctuation.
 * Everything else, including every letter of every script, is kept, so
 * non-Latin queries still produce distinct tokens. Coarser than the primary
 * class (a few rare symbols survive as part of a token), which only matters on
 * those old engines and only for the client-side `containsKaraoke`; the cache
 * key itself is built on the server.
 */
export const NOT_WORD_CHAR_FALLBACK =
  /[\s\x00-\x2F\x3A-\x40\x5B-\x60\x7B-\xA9\xAB-\xB9\xBB-\xBF\xD7\xF7\u2000-\u206F\u3000-\u303F\uFF01-\uFF0F]+/g;

/**
 * Anything that is not a letter, a combining mark or a digit, in ANY script.
 *
 * Built with the RegExp constructor because the `u`-flag property escapes are
 * ES2018 syntax and this project's TypeScript target is ES2017. Not every
 * declared browser has them at runtime: Chrome 64+, Safari 11.1+ and Edge 79+
 * do, but Firefox only from 78, and the browserslist floor is Firefox 67. This
 * module is imported by the patron client (SongSearch -> planSearch, and
 * augmentQuery -> containsKaraoke -> foldTokens), so an unguarded constructor
 * would throw a SyntaxError at module load there and take the whole search UI
 * down. Hence the try/catch and `NOT_WORD_CHAR_FALLBACK`. Node (the server,
 * where the cache key is built) always has them.
 */
export function buildNotWordChar(): RegExp {
  try {
    return new RegExp("[^\\p{L}\\p{M}\\p{N}]+", "gu");
  } catch {
    return NOT_WORD_CHAR_FALLBACK;
  }
}

const NOT_WORD_CHAR = buildNotWordChar();

/** Test hook: true when this engine lacked property escapes at module load. */
export const _usingNotWordCharFallback = NOT_WORD_CHAR === NOT_WORD_CHAR_FALLBACK;

/** The token sing mode appends (lib/search-query.ts), in folded form. */
const KARAOKE_TOKEN = "karaoke";

/**
 * Tokens of the search-cache fold (see `foldSearchKey`): lowercase, Latin
 * diacritics stripped, split on anything that is not a letter, mark or digit.
 */
export function foldTokens(s: string): string[] {
  return stripDiacritics(String(s).toLowerCase())
    .replace(NOT_WORD_CHAR, " ")
    .split(" ")
    .filter(Boolean);
}

/**
 * Chunks of a query for the key fold: a run of `|`, a `"` (with any `-` right
 * before it), or a run of anything that is not whitespace, `|` or `"`.
 */
const KEY_CHUNK = /\|+|-*"|[^\s|"]+/g;

/**
 * Fold tokens plus the YouTube search operators the Data API honours in `q`:
 * `-word` (exclude), `|` (OR) and `"` (phrase). These change WHICH results
 * Google returns, so they must survive into the cache key, or
 * `evidencias -karaoke` would share an entry with `evidencias karaoke` and
 * whoever missed first would pin an off-intent page on every variant for the
 * whole TTL (TICKET-135 security review, MEDIUM).
 *
 *  - a `|` anywhere becomes a `|` token (runs collapse to one);
 *  - a `"` becomes a `"` token, or `-"` when a `-` opens it (excluded phrase);
 *  - a chunk that STARTS with `-` keeps the `-` on its first token
 *    (`-karaoke`). A hyphen inside a word (`evidencias-karaoke`) is plain
 *    punctuation, as before.
 *
 * Without any of these characters the result is exactly `foldTokens(s)`, so
 * every plain query keeps the key it had.
 */
function foldKeyTokens(s: string): string[] {
  const out: string[] = [];
  for (const chunk of stripDiacritics(String(s).toLowerCase()).match(KEY_CHUNK) ?? []) {
    if (chunk[0] === "|") {
      out.push("|");
    } else if (chunk.endsWith('"')) {
      out.push(chunk[0] === "-" ? '-"' : '"');
    } else {
      const tokens = foldTokens(chunk);
      if (tokens.length > 0 && chunk[0] === "-") tokens[0] = `-${tokens[0]}`;
      out.push(...tokens);
    }
  }
  return out;
}

/**
 * The fold used for the QUERY part of the search cache key (TICKET-135).
 *
 * Two patrons asking the same question must land on one cache entry, so one
 * billed call answers both: `maná` and `mana`, `Cerol na Mão` and
 * `cerol na mao`, NFC and NFD spellings, `karaoke evidencias` and
 * `evidencias karaoke`. Steps:
 *
 *  1. The same comparison form as `normalizeQuery` (and so the karaoke index
 *     matcher): lowercase, NFD with the combining diacritics stripped,
 *     punctuation collapsed to single spaces, trimmed.
 *  2. Every `karaoke` token (which includes an accented `karaokê`, after step
 *     1) is removed and ONE is put back at the end. Sing mode appends it
 *     client-side, and patrons also type it first, so its position carries no
 *     meaning. An excluded `-karaoke` is a different token and stays put.
 *
 * Search operators (`-word`, `|`, `"`) are the exception to step 1: Google
 * receives the patron's original `q`, and those characters change its answer,
 * so they are kept as markers (see `foldKeyTokens`). `x -karaoke`,
 * `x | karaoke` and `"x" karaoke` each get their own key; `x!!! karaokê` still
 * shares `x karaoke`'s.
 *
 * ONE DELIBERATE DIFFERENCE FROM `normalizeQuery`: letters and digits of every
 * script are kept (`\p{L}`, `\p{M}`, `\p{N}`), where `normalizeQuery` keeps only
 * `[a-z0-9]`. For anything `normalizeQuery` can see the two agree exactly, and
 * two queries that share a fold also share their `normalizeQuery` tokens (up
 * to where `karaoke` sits). But the
 * index matcher can afford to drop a Japanese or Cyrillic query to "" (it just
 * finds nothing), while a cache key cannot: every such query would share one
 * key and be served the first one's videos. Diacritic stripping also applies
 * to non-Latin text, so e.g. Cyrillic `й`/`и` and Vietnamese tone marks fold
 * together, the same trade as the Latin accents.
 *
 * Returns "" when the query has no letter, mark, digit, `|` or `"` at all;
 * `cacheKey` handles that case.
 */
export function foldSearchKey(s: string): string {
  const tokens = foldKeyTokens(s);
  const words = tokens.filter((t) => t !== KARAOKE_TOKEN);
  if (words.length < tokens.length) words.push(KARAOKE_TOKEN);
  return words.join(" ");
}

/** Normalized, non-empty tokens of a query. */
export function queryTokens(s: string): string[] {
  const n = normalizeQuery(s);
  return n ? n.split(" ").filter(Boolean) : [];
}

/**
 * Is `next` a strict textual EXTENSION of `held` — i.e. the patron kept typing
 * on the end of the same query?
 *
 * Compared on the normalized form, and deliberately strict:
 *   - equal strings are NOT an extension (there is nothing new to narrow, and the
 *     caller has nothing to decide — it already holds that exact answer);
 *   - a BACKSPACE (next is a prefix of held) is NOT an extension. Held rows are
 *     Google's answer to the LONGER string, so they are not a superset of what
 *     the shorter one would return; treating that as filterable would quietly
 *     serve a narrower list than the patron asked for. Refetching is the honest
 *     answer, and production traces show patrons extend far more than they
 *     backspace.
 */
export function isExtensionOf(next: string, held: string): boolean {
  const a = normalizeQuery(next);
  const b = normalizeQuery(held);
  if (!b || a.length <= b.length) return false;
  // Require the extension to continue at a token boundary or mid-token — both
  // are real ("escurinho" → "escurinho do", "escuri" → "escurinho") — which is
  // exactly plain string prefixing on the normalized form.
  return a.startsWith(b);
}

/**
 * Rows from a held page that still match `query`.
 *
 * A row matches when EVERY discriminating token of the query prefixes some word
 * of the row's "title + channel" text. Prefix-matching rather than equality is
 * the point: the patron is usually mid-word ("escurinho do cin"), and "cin"
 * must match "Cinema" or local narrowing would starve on every single keystroke
 * and refetch exactly as often as before.
 *
 * Order-insensitive on purpose: "rita lee escurinho" should keep a row titled
 * "Escurinho do Cinema — Rita Lee".
 */
export function filterResults(rows: readonly SearchResult[], query: string): SearchResult[] {
  const wanted = discriminatingTokens(query);
  if (wanted.length === 0) return [...rows];
  return rows.filter((r) => {
    const words = queryTokens(`${r.title} ${r.channelTitle ?? ""}`);
    return wanted.every((t) => words.some((w) => w.startsWith(t)));
  });
}

/**
 * How many locally-matching rows are enough to trust local narrowing instead of
 * spending one of the platform's 90 daily patron searches.
 *
 * Measured against the spike's 32 real production queries: at 1 the billing win
 * is largest but a single stray row can pin us to a page that does not really
 * answer the query; at 3 the win is within a call or two of that and hit@10 is
 * identical to today's per-keystroke behaviour. See the dev report's variant
 * table — this is the measured value, not a guess.
 */
export const MIN_LOCAL_MATCHES = 3;

export type SearchPlan =
  | {
      action: "fetch";
      /** Why a call is being spent — surfaced for tests and telemetry, never to the patron. */
      reason: "no-held-results" | "not-an-extension" | "local-matches-starved";
    }
  | { action: "filter"; rows: SearchResult[] };

export interface PlanSearchInput {
  /** The raw (un-augmented) query the patron has now typed. */
  next: string;
  /** The raw query the currently-held rows were fetched for; "" when none. */
  heldQuery: string;
  /** The rows currently held for `heldQuery`. */
  heldRows: readonly SearchResult[];
  /** Override for tests/measurement; defaults to MIN_LOCAL_MATCHES. */
  minLocalMatches?: number;
}

/**
 * Decide whether the next query needs a billed `search.list` call, or can be
 * answered by narrowing the rows we already hold.
 *
 * Pure: same inputs → same plan, no clock, no network, no React.
 */
export function planSearch({
  next,
  heldQuery,
  heldRows,
  minLocalMatches = MIN_LOCAL_MATCHES,
}: PlanSearchInput): SearchPlan {
  if (!heldQuery || heldRows.length === 0) return { action: "fetch", reason: "no-held-results" };
  // Same question, different spelling. Production billed TWO separate calls for
  // `mana karaoke`/`maná karaoke` and two more for `cerol na mao`/`cerol na mão`
  // — the patron went back and added the accent, which is not a new query at all
  // once folded. Hand back exactly what we hold; narrowing would be a no-op.
  if (normalizeQuery(next) === normalizeQuery(heldQuery)) {
    return { action: "filter", rows: [...heldRows] };
  }
  if (!isExtensionOf(next, heldQuery)) return { action: "fetch", reason: "not-an-extension" };
  const rows = filterResults(heldRows, next);
  if (rows.length < minLocalMatches) return { action: "fetch", reason: "local-matches-starved" };
  return { action: "filter", rows };
}
