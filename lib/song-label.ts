/**
 * How a queued song is named on screen (TICKET-140 gap 3). One place, so the
 * patron queue, the host/moderation view and the TV can never drift apart.
 *
 * The title is server-resolved (lib/video-meta.ts). When it is missing — an
 * older entry, or every lookup failed — the long-standing `youtu.be/<id>`
 * fallback stays.
 */
export interface LabelledSong {
  videoId: string;
  title?: string;
  channelTitle?: string;
  duration?: string;
}

/** The title alone (the TV's big "now playing" line). */
export function songTitle(e: LabelledSong): string {
  return e.title || `youtu.be/${e.videoId}`;
}

/** Title plus channel ("Title · Channel"), and the duration when asked (the moderation view). */
export function songLabel(e: LabelledSong, opts: { duration?: boolean } = {}): string {
  if (!e.title) return `youtu.be/${e.videoId}`;
  const parts = [e.title];
  if (e.channelTitle) parts.push(e.channelTitle);
  if (opts.duration && e.duration) parts.push(e.duration);
  return parts.join(" · ");
}
