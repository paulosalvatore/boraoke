import type { Mode } from "@/lib/store";
import { foldTokens } from "@/lib/search-prefix";

/**
 * Mode-aware search-query augmentation (TICKET-40).
 *
 * When the patron is in SING mode we want the YouTube search to surface karaoke
 * versions, so we append the keyword "karaoke" to their free-text query. In
 * listen/dance mode the raw query is searched unchanged.
 *
 * DESIGN DECISION (client-side augmentation): the keyword is appended here,
 * BEFORE the query is handed to /api/search, so the existing cache/rate-limit
 * layer (keyed on the query string) keeps working unchanged — the augmented
 * text is what gets cached, so sing and listen searches for the same raw words
 * land on distinct, coherent cache keys with zero server changes. Doing it
 * server-side would have forced the cache key to also include the mode/keyword
 * to avoid cross-mode cache poisoning; the client path is the cleaner one.
 *
 * Edge cases handled:
 *   - Already contains "karaoke" (case-insensitive, whole word, accent-folded,
 *     so "karaokê" counts too — TICKET-135) → not doubled.
 *   - Empty / whitespace-only query → returned as-is (trimmed to empty), never
 *     augmented (a bare "karaoke" search would be meaningless).
 *   - Pasted YouTube links are NEVER routed through here (the caller resolves
 *     them locally, before augmentation).
 */

const KARAOKE_KEYWORD = "karaoke";

/**
 * True if the query already contains "karaoke" as a whole word, compared on the
 * search-cache fold (lib/search-prefix.ts `foldTokens`): case-insensitive and
 * accent-insensitive, so "Karaokê" counts and is not followed by a second
 * "karaoke" (TICKET-135). "karaokestar" is still not a match.
 */
export function containsKaraoke(query: string): boolean {
  return foldTokens(query).includes(KARAOKE_KEYWORD);
}

/**
 * Returns the query to actually send to /api/search for the given mode.
 * Sing → appends "karaoke" (unless already present); other modes → unchanged.
 * Never augments an empty/whitespace query.
 */
export function augmentQuery(query: string, mode: Mode): string {
  const trimmed = query.trim();
  if (!trimmed) return trimmed;
  if (mode !== "sing") return trimmed;
  if (containsKaraoke(trimmed)) return trimmed;
  return `${trimmed} ${KARAOKE_KEYWORD}`;
}
