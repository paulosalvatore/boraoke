/**
 * In-memory queue store — module-level singleton.
 *
 * PROTOTYPE LIMITATION: state is lost on server restart. No persistence yet.
 * Database / Redis persistence is a later-ticket concern.
 *
 * Single default room for v0 (room concept is reserved for future multi-venue support).
 */

export type Mode = "sing" | "listen-dance";

export interface QueueEntry {
  id: string; // UUID v4
  videoId: string;
  title?: string; // optional free-text title supplied by patron
  nickname: string;
  patronUuid: string;
  table?: string;
  mode: Mode;
  submittedAt: string; // ISO 8601
}

/** Maximum queue depth — caps unauthenticated memory growth (security MEDIUM #3). */
export const QUEUE_MAX = 200;

/** Module-level array = the shared queue (one default room). */
let queue: QueueEntry[] = [];

export function getQueue(): QueueEntry[] {
  return queue;
}

export function isQueueFull(): boolean {
  return queue.length >= QUEUE_MAX;
}

/**
 * Add an entry to the queue.
 * Returns false (and does NOT add) when the queue is at QUEUE_MAX capacity.
 */
export function addToQueue(entry: QueueEntry): boolean {
  if (isQueueFull()) return false;
  queue.push(entry);
  return true;
}

/** Advance (skip) the current head of the queue. Returns the new head, or null if empty. */
export function advanceQueue(): QueueEntry | null {
  queue.shift();
  return queue[0] ?? null;
}

/** Current (now-playing) entry — index 0. */
export function nowPlaying(): QueueEntry | null {
  return queue[0] ?? null;
}

/** Clear queue — test helper only. */
export function clearQueue(): void {
  queue = [];
}
