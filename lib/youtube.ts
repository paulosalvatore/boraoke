/**
 * YouTube URL parser — extracts the video ID from common YouTube URL formats.
 * No API key required; purely client-side string parsing.
 *
 * Supported formats:
 *   https://www.youtube.com/watch?v=VIDEO_ID
 *   https://youtu.be/VIDEO_ID
 *   https://youtube.com/shorts/VIDEO_ID
 *   https://www.youtube.com/embed/VIDEO_ID
 *   https://www.youtube.com/live/VIDEO_ID
 *   Raw 11-character video IDs
 */
export function parseYouTubeVideoId(input: string): string | null {
  if (!input) return null;

  const trimmed = input.trim();

  // Raw video ID: exactly 11 chars, alphanumeric + - + _
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  // Try parsing as URL
  let url: URL;
  try {
    // Attach a scheme if it looks like a bare host
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "");

  if (host === "youtube.com" || host === "m.youtube.com") {
    // /watch?v=...
    const v = url.searchParams.get("v");
    if (v && isValidVideoId(v)) return v;

    // /embed/VIDEO_ID, /shorts/VIDEO_ID, /live/VIDEO_ID
    const match = url.pathname.match(
      /^\/(embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/
    );
    if (match) return match[2];
  }

  if (host === "youtu.be") {
    // youtu.be/VIDEO_ID
    const id = url.pathname.slice(1).split("?")[0];
    if (isValidVideoId(id)) return id;
  }

  return null;
}

/** Strict YouTube video-ID check: exactly 11 chars of [A-Za-z0-9_-]. */
export function isValidVideoId(id: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(id);
}
