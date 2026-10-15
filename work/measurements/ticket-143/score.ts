/**
 * TICKET-143 scoring over a labelled sample. Shared by measure.ts (prints the
 * numbers) and the jest acceptance test (holds the floor).
 */
import { parseTitle, TITLE_KINDS, type TitleKind } from "../../../lib/karaoke-index/title-parser";

export interface LabelledRow {
  title: string;
  channelTitle: string;
  song: string | null;
  artist: string | null;
  kind: TitleKind;
  /** Set when the labeller could not determine song/artist (reason). */
  skipSongArtist?: string;
}

/** Comparison fold: case, diacritics, punctuation and spacing do not count. */
export function cmp(s: string | null): string {
  if (s === null) return "";
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface Score {
  rows: number;
  kindCorrect: number;
  /** Strict: predicted kind === labelled kind, over every row. */
  kindAccuracy: number;
  /** Per predicted class: correct / predicted. */
  kindPrecision: Partial<Record<TitleKind, { predicted: number; correct: number }>>;
  saRows: number;
  saExact: number;
  songExact: number;
  artistExact: number;
  /** Song AND artist both equal (after cmp), over rows not marked skipSongArtist. */
  saAccuracy: number;
  misses: { title: string; channelTitle: string; want: string; got: string }[];
}

export function score(rows: LabelledRow[]): Score {
  let kindCorrect = 0;
  let saRows = 0;
  let saExact = 0;
  let songExact = 0;
  let artistExact = 0;
  const kindPrecision: Score["kindPrecision"] = {};
  const misses: Score["misses"] = [];
  for (const r of rows) {
    const p = parseTitle(r.title, r.channelTitle);
    const kp = (kindPrecision[p.kind] ??= { predicted: 0, correct: 0 });
    kp.predicted++;
    if (p.kind === r.kind) {
      kindCorrect++;
      kp.correct++;
    }
    if (r.skipSongArtist === undefined) {
      saRows++;
      const s = cmp(p.song) === cmp(r.song);
      const a = cmp(p.artist) === cmp(r.artist);
      if (s) songExact++;
      if (a) artistExact++;
      if (s && a) saExact++;
      else
        misses.push({
          title: r.title,
          channelTitle: r.channelTitle,
          want: `${r.song} / ${r.artist}`,
          got: `${p.song} / ${p.artist}`,
        });
    }
  }
  return {
    rows: rows.length,
    kindCorrect,
    kindAccuracy: rows.length ? kindCorrect / rows.length : 0,
    kindPrecision,
    saRows,
    saExact,
    songExact,
    artistExact,
    saAccuracy: saRows ? saExact / saRows : 0,
    misses,
  };
}

export { TITLE_KINDS };
