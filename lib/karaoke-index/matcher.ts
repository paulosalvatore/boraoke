/**
 * Karaoke index matcher — local search over harvested karaoke
 * channels, plus the confidence score the search route uses to decide whether
 * the index's answer is good enough to serve instead of spending one of the
 * platform's 100 daily `search.list` calls.
 *
 * Pure and dependency-free (node-env jest, no `server-only`).
 *
 * MATCHING. Every DISCRIMINATING query token (articles and karaoke boilerplate
 * dropped — the same definition `filterResults` uses) must match some word of
 * the row's TITLE. Channel names are deliberately NOT indexed: a karaoke
 * channel's name ("Neon Karaokê Brasil", "Karaokê Show Oficial") would make
 * every one of its videos a full-confidence match for that word, so `brasil
 * karaoke` would serve hundreds of unrelated rows ahead of Cazuza's "Brasil"
 * and block live search. Measured: dropping channel words changes nothing in
 * the replay's gain, and removes that whole class of false answers. A token
 * matches a title word at one of three strengths, which become the row's
 * per-token quality:
 *
 *   exact   word === token                                     1.0
 *   prefix  word starts with token (patron is mid-word)        PREFIX_Q
 *   fuzzy   one/two edits away, or a prefix one edit away      FUZZY_Q
 *
 * The harvest spike's finding drives the shape: most of the value is the
 * index EXISTING, and normalise + prefix matching beat its clever fuzzy scorer on
 * partial words. So prefix matching is first-class and fuzziness is a narrow,
 * bounded fallback (only for tokens of 4+ chars, only when no exact/prefix
 * word matches), not the primary mechanism.
 *
 * Lookups go through a sorted vocabulary + posting lists, so a query costs a
 * binary search per token plus a bounded fuzzy scan of the vocabulary — not a
 * scan of every row (the spike's naive scan was 91 ms/query at 36k rows).
 *
 * CONFIDENCE. A row that matches every token scores the MEAN of its per-token
 * qualities; a query whose best row misses any token has confidence 0. The
 * route serves the index only at confidence >= GOOD_MATCH_THRESHOLD (see
 * lib/karaoke-index/tier.ts, where the threshold is defined and justified).
 */

import { discriminatingTokens, queryTokens } from "../search-prefix";
import type { ChannelShard } from "./types";

export const PREFIX_Q = 0.8;
export const FUZZY_Q = 0.5;
/** A prefix shorter than this never counts (a 1-letter prefix matches everything). */
const MIN_PREFIX = 2;
/** Fuzzy matching only for tokens at least this long. */
const MIN_FUZZY = 4;

/**
 * Abuse bounds (the query string is attacker-controlled; the route's 100-char
 * cap alone still allows ~18 distinct typo tokens, each a full Levenshtein scan
 * of the ~23k-word vocabulary, ~220 ms of CPU per request):
 *  - more than MAX_QUERY_TOKENS distinct discriminating tokens -> no index
 *    answer at all (no real song search needs more; the route goes live);
 *  - at most MAX_FUZZY_TOKENS tokens per query may fall back to a fuzzy scan;
 *    a further token with no exact/prefix match simply does not match.
 */
export const MAX_QUERY_TOKENS = 8;
export const MAX_FUZZY_TOKENS = 2;

export interface IndexedVideo {
  videoId: string;
  title: string;
  channelTitle: string;
  duration: string;
  /** Rank of the source channel (lower = surfaced more by production search). */
  channelRank: number;
  /** Number of distinct discriminating words in the title (specificity). */
  titleWords: number;
}

export interface IndexHit {
  video: IndexedVideo;
  score: number;
}

export interface IndexSearchResult {
  hits: IndexHit[];
  /** 0 when no row matches every token; else the top hit's mean token quality. */
  confidence: number;
  /** Discriminating tokens the query was matched on. */
  tokens: string[];
  /** How many full-vocabulary fuzzy scans this query cost (<= MAX_FUZZY_TOKENS). */
  fuzzyScans: number;
}

/** Levenshtein distance, bounded: returns max+1 as soon as it is exceeded. */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function fuzzyBudget(token: string): number {
  return token.length >= 7 ? 2 : 1;
}

export class KaraokeIndex {
  readonly videos: IndexedVideo[] = [];
  /** Sorted unique vocabulary. */
  private vocab: string[] = [];
  /** word -> indices into `videos`. */
  private postings = new Map<string, number[]>();

  constructor(shards: readonly ChannelShard[]) {
    const seen = new Set<string>();
    shards.forEach((shard, channelRank) => {
      for (const [videoId, title, duration] of shard.rows) {
        if (seen.has(videoId)) continue;
        seen.add(videoId);
        const idx = this.videos.length;
        const titleTokens = new Set(discriminatingTokens(title));
        this.videos.push({
          videoId,
          title,
          channelTitle: shard.channelTitle,
          duration,
          channelRank,
          titleWords: Math.max(1, titleTokens.size),
        });
        const words = new Set(queryTokens(title));
        for (const w of words) {
          let list = this.postings.get(w);
          if (!list) this.postings.set(w, (list = []));
          list.push(idx);
        }
      }
    });
    this.vocab = [...this.postings.keys()].sort();
  }

  get size(): number {
    return this.videos.length;
  }

  /** word -> quality, for every vocabulary word this token matches. */
  private wordMatches(token: string, allowFuzzy: boolean): Map<string, number> {
    const out = new Map<string, number>();
    if (this.postings.has(token)) out.set(token, 1);
    if (token.length >= MIN_PREFIX) {
      // Binary search to the first word >= token, then walk the prefix range.
      let lo = 0;
      let hi = this.vocab.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.vocab[mid] < token) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < this.vocab.length && this.vocab[i].startsWith(token); i++) {
        if (!out.has(this.vocab[i])) out.set(this.vocab[i], PREFIX_Q);
      }
    }
    if (out.size === 0 && allowFuzzy && token.length >= MIN_FUZZY) {
      const k = fuzzyBudget(token);
      for (const w of this.vocab) {
        // Whole-word typo ("stete" -> "stereo") or mid-word typo ("onfs" -> "onda…").
        if (
          boundedLevenshtein(token, w, k) <= k ||
          (w.length > token.length && boundedLevenshtein(token, w.slice(0, token.length), 1) <= 1)
        ) {
          out.set(w, FUZZY_Q);
        }
      }
    }
    return out;
  }

  search(query: string, limit = 50): IndexSearchResult {
    const tokens = [...new Set(discriminatingTokens(query))];
    const empty = (): IndexSearchResult => ({ hits: [], confidence: 0, tokens, fuzzyScans });
    let fuzzyScans = 0;
    if (tokens.length === 0 || this.videos.length === 0) return empty();
    // Abuse bound: no song search needs this many words; answer nothing (-> live).
    if (tokens.length > MAX_QUERY_TOKENS) return empty();

    // Per token: video index -> best quality among the words it matched through.
    const perToken: Map<number, number>[] = [];
    for (const t of tokens) {
      const best = new Map<number, number>();
      let matches = this.wordMatches(t, false);
      if (matches.size === 0 && t.length >= MIN_FUZZY && fuzzyScans < MAX_FUZZY_TOKENS) {
        fuzzyScans++;
        matches = this.wordMatches(t, true);
      }
      for (const [w, q] of matches) {
        for (const idx of this.postings.get(w) ?? []) {
          if ((best.get(idx) ?? 0) < q) best.set(idx, q);
        }
      }
      if (best.size === 0) return empty();
      perToken.push(best);
    }

    // Rows matching EVERY token (iterate the smallest posting set).
    const order = [...perToken].sort((a, b) => a.size - b.size);
    const hits: IndexHit[] = [];
    for (const [idx] of order[0]) {
      let sum = 0;
      let all = true;
      for (const m of perToken) {
        const q = m.get(idx);
        if (q === undefined) {
          all = false;
          break;
        }
        sum += q;
      }
      if (all) hits.push({ video: this.videos[idx], score: sum / tokens.length });
    }

    hits.sort(
      (a, b) =>
        b.score - a.score ||
        // Specificity: a title that is mostly the query beats a medley/compilation.
        a.video.titleWords - b.video.titleWords ||
        a.video.channelRank - b.video.channelRank ||
        a.video.videoId.localeCompare(b.video.videoId),
    );
    return { hits: hits.slice(0, limit), confidence: hits[0]?.score ?? 0, tokens, fuzzyScans };
  }
}
