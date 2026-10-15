/**
 * Search tier routing — the pure decision of whether a search is
 * answered by the local karaoke index or by a live `search.list` call.
 *
 * Order in the route: cache (unchanged, in front) → index → live search.
 *
 * The index is a spend-reducer, never a replacement: whenever it is not
 * confident, the request falls through to exactly the pre-index live path.
 */

import { containsKaraoke } from "../search-query";
import type { SearchResult } from "../youtube-search";
import type { KaraokeIndex } from "./matcher";

/**
 * THE "GOOD MATCH" THRESHOLD.
 *
 * The index answers only when its best row matches EVERY discriminating query
 * token AND the mean per-token match quality of that row is at least this
 * value (exact word = 1.0, word prefix = 0.8, bounded typo = 0.5).
 *
 * In words, 0.8 means: every word must be present, and the ONLY imperfect
 * matches allowed are words still being typed (prefixes) — or, in a query of
 * three or more words, a single typo. A lone typo'd word (0.5), or one typo
 * among two words (0.75), is not trusted and goes live.
 *
 * Tuned on the keystroke replay (real production typing traces + the 28
 * gradable production queries; `npm run measure:t124` prints the curve):
 *   - 0.8 cuts billed calls per queued song 2.25 -> 1.22 and lifts hit@10
 *     79% -> 89% (the index's prefix answers beat live search on partial words).
 *   - 0.5-0.7 bill slightly less (0.84-1.17/song) but trust typo matches. On
 *     the long-tail simulation (wanted song removed from the index) 0.5 serves
 *     4/18 false confident answers vs 3/18 at 0.6-0.8.
 *   - 0.9-1.0 serve 0 false answers there but bill 1.45-1.59/song and drop
 *     hit@10 to 82%/79%, because they refuse every lone partial word ("escu",
 *     "borb") — exactly where the index beats live search.
 *   The 3 remaining long-tail false answers are lone partial words, which
 *   self-correct as the patron keeps typing (the prefix stops matching, the
 *   held rows starve, and the next fetch goes live), and "load more" escapes
 *   to live at any time.
 */
export const GOOD_MATCH_THRESHOLD = 0.8;

/**
 * A query must carry at least this many discriminating characters before the
 * index may answer it. Very short prefixes ("esc", "bor") prefix-match
 * thousands of rows and the index cannot tell which one the patron means.
 */
export const MIN_INDEX_QUERY_CHARS = 4;

/**
 * Sentinel "next page" cursor attached to an index answer. It gives the patron
 * an escape hatch out of the index with no client change: tapping "load more"
 * past the index rows sends this token as page 2, and the route answers it
 * with a LIVE first-page search (one billed call — the same price as any
 * deep page today). Uppercase, so it can never collide with a lowercased cache
 * key, and it matches the route's PAGE_TOKEN_RE.
 */
export const INDEX_MORE_TOKEN = "IDXLIVE";

export type TierDecision =
  | { tier: "index"; results: SearchResult[]; confidence: number }
  | {
      tier: "live";
      reason:
        | "not-sing-mode"
        | "deep-page"
        | "index-escape"
        | "index-unavailable"
        | "query-too-short"
        | "weak-match";
      confidence?: number;
    };

export interface TierInput {
  /** The query exactly as the route received it (already mode-augmented). */
  q: string;
  /** "" for a first page. */
  pageToken: string;
  index: KaraokeIndex | null;
  threshold?: number;
  minChars?: number;
  limit?: number;
}

/** Thumbnail derived from the id — never stored (data minimisation). */
export function thumbnailFor(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

export function decideTier({
  q,
  pageToken,
  index,
  threshold = GOOD_MATCH_THRESHOLD,
  minChars = MIN_INDEX_QUERY_CHARS,
  limit = 50,
}: TierInput): TierDecision {
  if (pageToken === INDEX_MORE_TOKEN) return { tier: "live", reason: "index-escape" };
  if (pageToken) return { tier: "live", reason: "deep-page" };
  // The index holds karaoke versions only. Sing mode is the only mode whose
  // query asks for one (augmentQuery appends "karaoke"); listen/dance patrons
  // want the original recording, which the index does not have.
  if (!containsKaraoke(q)) return { tier: "live", reason: "not-sing-mode" };
  if (!index || index.size === 0) return { tier: "live", reason: "index-unavailable" };
  const r = index.search(q, limit);
  if (r.tokens.join("").length < minChars) return { tier: "live", reason: "query-too-short" };
  if (r.hits.length === 0 || r.confidence < threshold) {
    return { tier: "live", reason: "weak-match", confidence: r.confidence };
  }
  return {
    tier: "index",
    confidence: r.confidence,
    results: r.hits.map(({ video }) => ({
      videoId: video.videoId,
      title: video.title,
      channelTitle: video.channelTitle,
      duration: video.duration,
      thumbnailUrl: thumbnailFor(video.videoId),
    })),
  };
}
