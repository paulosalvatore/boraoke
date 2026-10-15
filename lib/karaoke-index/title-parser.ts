/**
 * Title parser: (YouTube title, channel title) -> { song, artist, kind }.
 *
 * Pure and dependency-free. Stores nothing and is not wired into the matcher
 * or the index shape yet: the catalogue schema that will carry its output is a
 * later ticket. Per the catalogue legal ruling, a song/artist parsed from a
 * YouTube title is YouTube-derived: it may only become a permanent song record
 * once a non-YouTube source or a patron's own typing corroborates it.
 *
 * HOW IT WORKS
 *
 * 1. Kind. Keyword cues in the title, in a fixed priority order (karaoke beats
 *    playback beats cover beats live beats lyric beats original), then the
 *    channel name as a fallback: an index channel is karaoke/playback-named by
 *    construction, so a title with no cue on such a channel is that kind.
 *    YouTube's auto-generated "<Artist> - Topic" channels carry official
 *    audio, so they read as `original` unless the title says otherwise.
 *
 * 2. Song and artist. Karaoke titles are "<a> - <b> (Karaoke ...)" in a dozen
 *    spellings. The parser:
 *      - drops hashtags, emoji and CJK lenticular brackets;
 *      - drops bracket groups that carry only boilerplate ("(Karaokê Version)",
 *        "[HD]", "(Male Key)") and keeps the others aside as possible artists;
 *      - turns every run of boilerplate words ("KARAOKE PIANO - FEMALE KEY",
 *        "Playback com letra") into a separator, so "Sina de Ofélia KARAOKE"
 *        and "Nosso lugar 'karaoke' MC Kevin" split where the boilerplate was;
 *      - splits on the usual separators (" - ", " | ", " • ", " / ", runs of
 *        2+ spaces, ...) and drops segments that are only boilerplate, a year
 *        or the channel's own name;
 *      - reads explicit cues first ("by X", "in the style of X", "made popular
 *        by X"), then a per-channel order template, then generic order cues
 *        (a featuring marker or "&" marks the artist side; "<song> (Karaoke) -
 *        <artist>" puts the song first), defaulting to "<artist> - <song>".
 *
 *    The per-channel templates (TEMPLATES below) only exist for channels whose
 *    convention is not the default order.
 *
 * Measured on a hand-labelled sample: work/measurements/ticket-143/.
 */

export const TITLE_KINDS = [
  "karaoke",
  "playback",
  "original",
  "lyric",
  "live",
  "cover",
  "unknown",
] as const;

export type TitleKind = (typeof TITLE_KINDS)[number];

export interface ParsedTitle {
  /** Song name without version tags, or null when none could be isolated. */
  song: string | null;
  /** Credited artist(s) with any featuring tail removed, or null. */
  artist: string | null;
  kind: TitleKind;
}

/** Upper bound on the title length we parse (YouTube caps titles at 100). */
const MAX_TITLE = 300;

// ---------------------------------------------------------------- helpers

/** Lowercase + strip diacritics; used for matching only, never for output. */
export function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
};

/** The Data API returns titles HTML-escaped on some endpoints. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

// ------------------------------------------------------------------ kind

const KARAOKE_RE = /karaok|videok[eê]|караоке|カラオケ|노래방|\bminus[- ]?one\b|\bsing[- ]?along\b/i;
const PLAYBACK_RE = /playback|backing track|\binstrumental\b|\bpista\b|minusovka|\bminus\b/i;
const COVER_RE = /\bcover\b/i;
const LIVE_RE = /\b(ao vivo|en vivo|live|unplugged|en directo|ac[uú]stico)\b/i;
const LYRIC_RE = /\b(lyrics?|letras?|legendad[oa]|lyric video|paroles)\b/i;
const ORIGINAL_RE =
  /\b(official (music )?video|official audio|official visualizer|video ?clip|clipe oficial|v[ií]deo oficial|[aá]udio oficial|videoclip oficial|oficial)\b/i;

/** Classify a title. Priority order matters: see the module comment. */
export function classifyKind(title: string, channelTitle: string): TitleKind {
  const t = title;
  if (KARAOKE_RE.test(t)) return "karaoke";
  if (PLAYBACK_RE.test(t)) return "playback";
  if (COVER_RE.test(t)) return "cover";
  if (LIVE_RE.test(t)) return "live";
  if (LYRIC_RE.test(t)) return "lyric";
  if (KARAOKE_RE.test(channelTitle)) return "karaoke";
  if (PLAYBACK_RE.test(channelTitle)) return "playback";
  if (ORIGINAL_RE.test(t) || /\s-\sTopic$/.test(channelTitle.trim())) return "original";
  return "unknown";
}

// ------------------------------------------------------- boilerplate words

/**
 * Words that are karaoke/version boilerplate wherever they appear. A run of
 * these (plus MODIFIER words attached to one) is cut out of the title and
 * becomes a separator.
 */
const CORE_WORDS = new Set([
  "karaoke", "karaokê", "karaoké", "karaokes", "karaokês", "karaokeversion", "karaokevoz", "karaokêvoz",
  "videoke", "videokê", "videokes", "караоке", "playback", "playbacks", "instrumental",
  "instrumentales", "minusovka", "minus-one", "lyrics", "letra", "letras", "legendado", "versão", "versión", "version",
]);

/**
 * Words that are boilerplate only next to a core word ("Piano" in "Piano
 * Karaoke" yes, in "Piano Man" no).
 */
const MODIFIER_WORDS = new Set([
  "hd", "fullhd", "uhd", "ultrahd", "4k", "piano", "guitar", "violão", "acústico", "acustico",
  "lyric", "letra", "letras", "legendado", "legendada", "cifrado", "cifras", "con", "com", "with",
  "sem", "no", "de", "do", "da", "en", "em", "in", "from", "on", "screen", "and", "&", "+", "y", "e",
  "vocal", "vocals", "voz", "coros", "backing", "track", "guide", "melody", "original", "key",
  "male", "female", "tom", "tono", "version", "versão", "versión", "nada", "wanita", "pria",
  "cewek", "cowok", "minus", "pista", "demo", "demonstração", "rap", "duet", "dueto", "remasterizado",
  "som", "música", "musica", "official", "oficial", "songs", "song", "only", "chords", "clean",
  "high", "quality", "the", "style", "a", "o", "sing", "along", "2ª", "2a", "cc", "c", "audio",
]);

/** Genre words that read as boilerplate next to a core word ("Karaokê de Arrocha"). */
const GENRE_WORDS = new Set([
  "arrocha", "forró", "forro", "sertanejo", "samba", "pagode", "pagodão", "funk", "gospel",
  "dangdut", "koplo", "cumbia", "rock", "mpb", "católico", "catolico", "nacional", "calypso", "reggaeton",
]);

/** Bracket groups made only of these (or core/modifier words) are boilerplate. */
const BRACKET_NOISE_WORDS = new Set([
  ...CORE_WORDS, ...MODIFIER_WORDS, ...GENRE_WORDS,
  "cover", "live", "ao", "vivo", "en", "vivo", "unplugged", "remix", "remaster", "remastered",
  "remasterizado", "audio", "video", "vídeo", "clip", "clipe", "videoclip", "explicit", "radio", "edit",
  "lower", "higher", "tone", "tons", "semitom", "semitons", "cc", "eurovision", "contest", "mv",
  "music", "lyric", "visualizer", "sub", "subs", "subtitulado", "legenda", "classics", "collection",
  "arranjo", "exclusivo", "pt", "br", "es", "en", "melody",
]);

function stripWordPunct(w: string): string {
  return w.replace(/^[^\p{L}\p{N}&+]+|[^\p{L}\p{N}&+ª]+$/gu, "");
}

function isCore(word: string): boolean {
  const w = stripWordPunct(word).toLowerCase();
  if (!w) return false;
  if (CORE_WORDS.has(w)) return true;
  return /^karaok|^videok/.test(fold(w));
}

function isModifier(word: string): boolean {
  const w = stripWordPunct(word).toLowerCase();
  if (!w) return true; // pure punctuation glues a run together
  return MODIFIER_WORDS.has(w) || GENRE_WORDS.has(w) || CORE_WORDS.has(w) || /^\d{4}$/.test(w);
}

function isBracketNoise(content: string): boolean {
  const words = content.split(/[\s/\-–—,:.]+/).map((w) => stripWordPunct(w).toLowerCase()).filter(Boolean);
  if (words.length === 0) return true;
  if (words.some((w) => isCore(w))) return true;
  if (/\b(made popular by|in the style of|by)\b/i.test(content)) return true;
  return words.every(
    (w) =>
      BRACKET_NOISE_WORDS.has(w) ||
      /^[+-]?\d+([/.,]\d+)?$/.test(w) || // "-2/5", "2025", "1"
      /^\d{4}$/.test(w) ||
      /^[a-g][#b]?m?$/.test(w), // musical key "A", "Am", "C#"
  );
}

// ---------------------------------------------------------------- templates

type Order = "artist-song" | "song-artist";

interface ChannelTemplate {
  order: Order;
  /** Leading content segments to drop before reading the pair (e.g. a country). */
  skip?: number;
}

/**
 * Channel conventions that differ from the default "<artist> - <song>".
 * Keyed by fold(channelTitle) with whitespace collapsed and trailing dots
 * dropped. Each entry was read off that channel's OTHER titles in the
 * 2026-10-02 production search capture (rows outside the labelled sample and
 * the holdout), and kept only where those titles agree on one convention.
 * Grow this list from a channel's own uploads, never from labelled rows.
 */
const TEMPLATES: Record<string, ChannelTemplate> = {
  "musisi karaoke": { order: "song-artist" },
  "singer! karaoke": { order: "song-artist" },
  "atomic karaoke": { order: "song-artist" },
  "muramatsu karaoke": { order: "song-artist" },
  "sfalsin producoes karaoke": { order: "song-artist" },
  "viguiba karaoke": { order: "song-artist" },
  "karaoke show oficial": { order: "song-artist" },
  "jj karaoke": { order: "song-artist" },
  "lg karaoke producoes": { order: "song-artist" },
  "karaoke piano": { order: "song-artist" },
  "livesing karaoke": { order: "song-artist" },
  "pinoy karaoke battle": { order: "song-artist" },
  "magnus ribeiro karaoke playback banda grafith": { order: "song-artist" },
  "chuvadeestrelas karaoke": { order: "song-artist" },
  "karaoke viny teclas": { order: "song-artist" },
  mrentertainerkaraoke: { order: "song-artist" },
  "my all time karaoke": { order: "song-artist" },
  "kanta karaoke": { order: "song-artist" },
  "sigma karaokes": { order: "song-artist" },
  "chanson karaoke - solte sua voz!": { order: "song-artist" },
  "betinho teclas - karaoke e playbacks": { order: "song-artist" },
  "valdata karaoke musical": { order: "song-artist" },
  "cante karaoke": { order: "song-artist" },
  "langgeng karaoke": { order: "song-artist" },
  "karaoke jb teclas": { order: "song-artist" },
  "karaoke enjoy": { order: "song-artist" },
  "ultrahd karaoke": { order: "song-artist" },
  "essendiel karaoke": { order: "artist-song", skip: 1 },
};

function channelKey(channelTitle: string): string {
  return fold(channelTitle).replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
}

/** The channel's own name minus boilerplate ("Nox Karaoke" -> "nox"). */
function channelCore(channelTitle: string): string {
  return fold(channelTitle)
    .split(/\s+/)
    .filter((w) => w && !isCore(w) && !["official", "oficial", "channel", "tv", "music", "-", "topic"].includes(w))
    .join(" ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
}

// ------------------------------------------------------------ song/artist

const SEP_TOKEN = "\u0000";
/** Marks a separator that was a karaoke/version tag ("(Karaokê)", "- Karaokê -"). */
const TAG = "\u0001";

/** Featuring tail: "Avicii ft. Aloe Blacc" -> "Avicii". */
// "with" counts as featuring ("X with Y") but not in a band name of the form
// "X with the Y" ("Hootie with the Blowfish").
const FEAT_RE = /\s*[([]?\b(ft\.?|feat\.?|featuring|part\.|with(?!\s+the\s))\s.+$/i;
const HAS_FEAT_RE = /\b(ft\.?|feat\.?|featuring)\s/i;

function cleanSong(s: string): string | null {
  let out = s
    .replace(/\s*[([{][^)\]}]*[)\]}]/g, " ") // every remaining bracket group
    .replace(/[([{].*$/, " ") // an unclosed one
    .replace(/["“”«»*]/g, " ")
    .replace(/\s+remix$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  out = out.replace(/^['‘’]+|['‘’]+$/g, "").replace(/^[\s,.;:!?-]+|[\s,.;:-]+$/g, "").trim();
  return out.length > 0 ? out : null;
}

function cleanArtist(s: string): string | null {
  let out = s.replace(FEAT_RE, "");
  out = out
    .replace(/\s*[([{][^)\]}]*[)\]}]/g, " ")
    .replace(/[([{].*$/, " ")
    .replace(/["“”«»*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s,.;:!?-]+|[\s,.;:-]+$/g, "")
    .trim();
  return out.length > 0 ? out : null;
}

/** Replace every run of boilerplate words with a separator. */
function cutBoilerplateRuns(text: string): string {
  const words = text.split(/(\s+)/); // keep whitespace tokens so the rest is untouched
  const idx: number[] = [];
  for (let i = 0; i < words.length; i++) if (!/^\s+$/.test(words[i]) && words[i] !== "") idx.push(i);
  const kill = new Set<number>();
  for (let k = 0; k < idx.length; k++) {
    if (!isCore(words[idx[k]])) continue;
    kill.add(k);
    for (let j = k - 1; j >= 0 && isModifier(words[idx[j]]); j--) kill.add(j);
    for (let j = k + 1; j < idx.length && (isModifier(words[idx[j]]) || isCore(words[idx[j]])); j++) kill.add(j);
  }
  if (kill.size === 0) return text;
  // A killed run must not swallow a glue word that starts real content on its
  // edge: "QUIEN SE HA TOMADO ... de La Mona" has no core word, so it is safe;
  // "Karaokê de Arrocha" is a run on purpose.
  const out: string[] = [];
  let inRun = false;
  for (let k = 0; k < idx.length; k++) {
    if (kill.has(k)) {
      if (!inRun) out.push(SEP_TOKEN + TAG);
      inRun = true;
    } else {
      out.push(words[idx[k]]);
      inRun = false;
    }
  }
  return out.join(" ");
}

interface Segments {
  /** Content segments in title order. */
  parts: string[];
  /** Index (in parts) of each segment that was followed by a boilerplate bracket. */
  taggedBeforeSep: Set<number>;
  /** Non-boilerplate bracket groups, in order (possible artists). */
  extras: string[];
  /** Explicit artist cue ("by X", "in the style of X"). */
  cueArtist: string | null;
}

function segment(title: string, channelTitle: string): Segments {
  let t = decodeEntities(title).slice(0, MAX_TITLE);
  // CJK lenticular brackets hold tags ("【カラオケ】", "【原曲キー】") on these channels.
  t = t.replace(/【[^】]*】/g, " - ");
  // Hashtags and emoji/pictographs/flags/stars/notes.
  t = t.replace(/(^|\s)#\S+/g, " ");
  t = t.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u2600-\u27BF\u2B50\u266A-\u266F\uFE0F\u200D]+/gu, ` ${SEP_TOKEN} `);

  let cueArtist: string | null = null;
  // "(In the Style of X)", "(Made Popular By X)", "(by X)" inside a bracket.
  // Only a bracket that STARTS with the cue: "(Produced by X)" is not a credit.
  t = t.replace(/[([]\s*(?:in the style of|made popular by|as made famous by|by)\s+([^)\]]+)[)\]]/i, (_m, a: string) => {
    cueArtist = a;
    return " ";
  });

  // Bracket groups: boilerplate ones become a tag marker, others go to extras.
  const extras: string[] = [];
  t = t.replace(/[([{]\s*([^()[\]{}]*)\s*[)\]}]/g, (_m, inner: string) => {
    if (isBracketNoise(inner)) return ` ${SEP_TOKEN}${TAG} `;
    extras.push(inner.trim());
    return " ";
  });
  t = t.replace(/[([{][^()[\]{}]*$/, " "); // unclosed trailing bracket

  // Unbracketed cues.
  if (!cueArtist) {
    const style = t.match(/\b(?:in the style of|made popular by)\s+(.+?)(?=\s[-|•]\s|$)/i);
    if (style) {
      cueArtist = style[1];
      t = t.replace(style[0], " ");
    }
  }

  // Separators -> SEP_TOKEN. Order matters: wider first.
  t = t
    .replace(/\s{2,}/g, ` ${SEP_TOKEN} `)
    .replace(/\s*(?:\|\||\/\/\/|--|\s-|-\s|\s–\s|\s—\s|\s\|\s|\|\s|\s\||\s•\s|\s·\s|\s\/\s|\/\s|\s_\s)\s*/g, ` ${SEP_TOKEN} `)
    .replace(/(\p{L})\s*:\s+/gu, `$1 ${SEP_TOKEN} `);

  // Boilerplate runs -> separators (the tag marker counts as core).
  t = t
    .split(SEP_TOKEN)
    .map((chunk) => cutBoilerplateRuns(chunk))
    .join(SEP_TOKEN);

  const raw = t.split(SEP_TOKEN);
  const core = channelCore(channelTitle);
  // Number-only segments ("01 - Artist - Song") are dropped as track numbers,
  // unless dropping them leaves fewer than two parts: then the number is the
  // song ("Arctic Monkeys - 505").
  const items: { s: string; numeric: boolean; tagged: boolean }[] = [];
  for (const r of raw) {
    const hadTag = r.includes(TAG);
    const s = r.split(TAG).join(" ").replace(/\s+/g, " ").trim();
    const f = fold(s).replace(/[^\p{L}\p{N} ]/gu, "").trim();
    const isNoise =
      f.length <= 1 ||
      s.split(/\s+/).every((w) => isModifier(w) || isCore(w)) ||
      (core.length > 0 && f === core) ||
      /^(eurovision|eurovision song contest)( \d{4})?$/.test(f);
    // A tag right after a part ("<song> (Karaokê) - <artist>",
    // "<song> 'karaoke' <artist>") marks that part.
    if (hadTag && items.length > 0) items[items.length - 1].tagged = true;
    if (isNoise) continue;
    items.push({ s, numeric: /^\d+$/.test(f), tagged: false });
  }
  const keepNumeric = items.filter((it) => !it.numeric).length < 2;
  const parts: string[] = [];
  const taggedBeforeSep = new Set<number>();
  for (const it of items) {
    if (it.numeric && !keepNumeric) {
      // a dropped number passes its tag to the part before it
      if (it.tagged && parts.length > 0) taggedBeforeSep.add(parts.length - 1);
      continue;
    }
    if (it.tagged) taggedBeforeSep.add(parts.length);
    parts.push(it.s);
  }

  // "X by Y" in a single segment, unless a short bracketed name already reads
  // as the credit ("Stand by Me (Ben E. King) Karaoke").
  const shortExtra = extras.length > 0 && extras[extras.length - 1].split(/\s+/).length <= 4;
  if (!cueArtist && !shortExtra && parts.length >= 1) {
    const by = parts[0].match(/^(.+?)\s+by\s+(.+)$/i);
    if (by && parts.length === 1) {
      parts[0] = by[1];
      cueArtist = by[2];
    }
  }

  return { parts, taggedBeforeSep, extras, cueArtist };
}

/** True when every letter in the segment is upper case (and there are 2+). */
function isAllCaps(s: string): boolean {
  const letters = s.replace(/[^\p{L}]/gu, "");
  return letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

/**
 * How strongly a segment reads as an artist credit rather than a song name.
 * Only cues that are about the shape of a credit, not about who is famous.
 */
function artistCues(s: string): number {
  let n = 0;
  if (HAS_FEAT_RE.test(s)) n += 2;
  if (s.includes("&")) n += 1;
  if (/^(mc|dj|banda|grupo|bonde|trio|dupla|conjunto)\s/i.test(s)) n += 1;
  // Duo credit "Bruno e Marrone", "Zezé Di Camargo e Luciano": capitalised
  // words on both sides of a lone " e ", at most five words in all.
  const words = s.split(/\s+/);
  if (words.length <= 5 && /\s(e|y|and)\s/.test(s) && words.every((w) => /^(e|y|and|di|da|de|do|dos)$/.test(w) || /^\p{Lu}/u.test(w))) {
    n += 1;
  }
  // Artists are not written starting lower case ("bad guy" is a song).
  if (/^\p{Ll}/u.test(s)) n -= 1;
  return n;
}

function decideOrder(a: string, b: string, aTagged: boolean): Order {
  const ca = artistCues(a);
  const cb = artistCues(b);
  if (ca !== cb) return ca > cb ? "artist-song" : "song-artist";
  if (aTagged) return "song-artist";
  // Song names in capitals with the credit in mixed case ("BABY I LOVE YOU -
  // Tiffany Alvord") is a common uploader convention; the reverse is rare.
  // A one-word capitalised left side is usually a stage name ("STROMAE").
  if (isAllCaps(a) && !isAllCaps(b) && a.trim().split(/\s+/).length >= 2) return "song-artist";
  return "artist-song";
}

/**
 * Extract song, artist and kind from a YouTube title and its channel title.
 * Never throws; returns nulls for what it cannot isolate.
 */
export function parseTitle(title: string, channelTitle: string): ParsedTitle {
  const safeTitle = typeof title === "string" ? title : "";
  const safeChannel = typeof channelTitle === "string" ? channelTitle : "";
  const kind = classifyKind(decodeEntities(safeTitle), safeChannel);

  const { parts, taggedBeforeSep, extras, cueArtist } = segment(safeTitle, safeChannel);
  const template = TEMPLATES[channelKey(safeChannel)];
  const content = template?.skip ? parts.slice(template.skip) : parts;

  let song: string | null = null;
  let artist: string | null = null;

  if (cueArtist) {
    song = content.length > 0 ? cleanSong(content[0]) : null;
    artist = cleanArtist(cueArtist);
  } else if (content.length === 0) {
    // nothing
  } else if (content.length === 1) {
    song = cleanSong(content[0]);
    // A short non-boilerplate bracket next to a lone song reads as its credit
    // ("Sapato 36 (Raul Seixas)"); a long one is a description, not a name.
    const extra = extras.length > 0 ? extras[extras.length - 1] : "";
    artist = extra && extra.split(/\s+/).length <= 4 ? cleanArtist(extra) : null;
  } else {
    const [a, b] = content;
    const order = template?.order ?? decideOrder(a, b, taggedBeforeSep.has(parts.indexOf(a)));
    if (order === "artist-song") {
      artist = cleanArtist(a);
      song = cleanSong(b);
    } else {
      song = cleanSong(a);
      artist = cleanArtist(b);
    }
  }

  return { song, artist, kind };
}
