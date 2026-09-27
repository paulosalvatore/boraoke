/**
 * TICKET-106 spike prototype — STEP 2 of 3: local fuzzy search over the
 * harvested index. ZERO dependencies on purpose — part of what the spike is
 * testing is whether "good enough for a patron thumb-typing a half-remembered
 * Portuguese title" needs a search engine or just careful normalisation.
 *
 * The three things patron input actually does, in order of how much damage they
 * do to a naive `includes()` match:
 *   1. PARTIAL words — the patron is mid-word ("escurinho do cin"). Handled by
 *      prefix-matching query tokens against title tokens, not equality.
 *      This is the single most important behaviour, because with search-on-type
 *      REMOVED (see Step 1) the query is a completed thought, but with a live
 *      index the last token is still usually partial.
 *   2. TYPOS — adjacent-key slips ("soda stete", "olha a onfs", "cerol na mao").
 *      Handled by bounded Levenshtein on the best-aligned token.
 *   3. ACCENTS — typed, or not typed, unpredictably ("evidencias"/"evidências",
 *      "mana"/"maná"). Handled by stripping diacritics on BOTH sides.
 */

/** Title noise that carries no discriminating signal in a karaoke catalogue. */
const NOISE = new Set([
  "karaoke", "karaoké", "karaokê", "playback", "instrumental", "cover", "versao",
  "versão", "com", "letra", "legendado", "hd", "official", "oficial", "video",
  "videoke", "music", "lyrics", "sing", "along", "clubinho", "do", "da", "de",
]);

export function stripDiacritics(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function normalize(s) {
  return stripDiacritics(String(s).toLowerCase())
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(s, { dropNoise = true } = {}) {
  const t = normalize(s).split(" ").filter(Boolean);
  return dropNoise ? t.filter((x) => !NOISE.has(x) && x.length > 1) : t;
}

/** Bounded Levenshtein; returns Infinity past `max` so long words stay cheap. */
export function lev(a, b, max = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return Infinity;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return Infinity;
    prev = cur;
  }
  return prev[b.length] <= max ? prev[b.length] : Infinity;
}

/**
 * Score ONE query token against ONE title's token list. Deliberately ordered so
 * an exact word beats a prefix beats a typo — a patron who typed a whole word
 * correctly should not be outranked by a fuzzy match on someone else's title.
 */
function scoreToken(qt, titleTokens) {
  let best = 0;
  for (const tt of titleTokens) {
    if (tt === qt) { best = Math.max(best, 1.0); continue; }
    if (tt.startsWith(qt)) { best = Math.max(best, 0.85 + 0.1 * (qt.length / tt.length)); continue; }
    if (qt.length >= 4) {
      const d = lev(qt, tt, qt.length <= 5 ? 1 : 2);
      if (d !== Infinity) best = Math.max(best, 0.7 - 0.12 * d);
    }
  }
  return best;
}

export function buildIndex(rows) {
  return rows.map((r) => ({
    ...r,
    _t: tokens(r.title),
    _ct: tokens(r.channelTitle ?? ""),
  }));
}

export function search(index, query, limit = 10) {
  const qts = tokens(query);
  if (!qts.length) return [];
  const scored = [];
  for (const row of index) {
    let sum = 0, matched = 0;
    for (const qt of qts) {
      const s = Math.max(scoreToken(qt, row._t), 0.6 * scoreToken(qt, row._ct));
      if (s > 0) { sum += s; matched++; }
    }
    if (!matched) continue;
    // Coverage-weighted: matching 3 of 3 query tokens must beat matching 1 of 3
    // very well, or "cerol" alone wins over "cerol na mao".
    const coverage = matched / qts.length;
    const score = (sum / qts.length) * (0.35 + 0.65 * coverage);
    if (score > 0.25) scored.push({ ...row, score });
  }
  scored.sort((a, b) => b.score - a.score || a.title.length - b.title.length);
  return scored.slice(0, limit);
}
