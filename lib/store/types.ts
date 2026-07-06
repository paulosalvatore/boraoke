/**
 * Store interface + shared types (TICKET-6).
 *
 * This is the FROZEN store contract. Implementations (memory, upstash) swap
 * behind `lib/store.ts`; nothing outside `lib/store*` imports a driver directly.
 *
 * The interface deliberately ships ops whose UI arrives in later tickets
 * (`removeEntry`, `reorder`, `setPaused`/`isPaused` — host controls, TICKET-7),
 * so wave-2 tickets never have to edit this file. All ops are room-scoped: the
 * key schema is room-ready NOW (single hardcoded "default" room until TICKET-9).
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
  /**
   * Rotation-spec field (consumed in TICKET-10). Reserved here so the entry
   * shape freezes with the interface; unset for normal submissions. When true,
   * the entry was re-queued by the grace-requeue rotation rule rather than
   * freshly submitted.
   */
  graceRequeue?: boolean;
}

/** Maximum queue depth — caps unauthenticated memory/storage growth (security MEDIUM #3). */
export const QUEUE_MAX = 200;

/** The single room until TICKET-9 introduces multi-room. */
export const DEFAULT_ROOM = "default";

/**
 * Durable, room-scoped queue store. Every op is async so the same interface
 * covers both the in-process memory driver and the HTTP-based Upstash driver.
 */
export interface QueueStore {
  /** Full queue for a room, in play order (head = now playing). */
  getQueue(roomId: string): Promise<QueueEntry[]>;

  /**
   * Append an entry to the room's queue.
   * Returns false (and does NOT add) when the queue is at QUEUE_MAX capacity.
   */
  addEntry(roomId: string, entry: QueueEntry): Promise<boolean>;

  /**
   * Remove an entry by id from anywhere in the queue.
   * Returns true if an entry was removed, false if the id was not found.
   */
  removeEntry(roomId: string, entryId: string): Promise<boolean>;

  /**
   * Advance (skip) the current head. Returns the NEW head after removal,
   * or null if the queue is now empty.
   */
  advance(roomId: string): Promise<QueueEntry | null>;

  /** Current (now-playing) entry — head of the queue — or null if empty. */
  nowPlaying(roomId: string): Promise<QueueEntry | null>;

  /**
   * Move an entry to a new index (clamped to [0, length-1]).
   * Returns true if moved, false if the id was not found.
   */
  reorder(roomId: string, entryId: string, newIndex: number): Promise<boolean>;

  /**
   * Replace the room's queue contents wholesale, in the given order (TICKET-10,
   * additive — the wave-2 interface freeze ended with wave 2). This is the bulk
   * op the rotation re-lay uses: ONE store call regardless of queue depth,
   * instead of N sequential `reorder` round-trips (security MEDIUM-1, PR #14).
   * An empty array empties the queue. Callers pass a permutation of the queue
   * they just read; last-writer-wins on races (the same read-modify-write
   * semantics `reorder` already has).
   */
  rewrite(roomId: string, entries: QueueEntry[]): Promise<void>;

  /** Set the room's paused flag (host control, TICKET-7). */
  setPaused(roomId: string, paused: boolean): Promise<void>;

  /** Read the room's paused flag (defaults to false when never set). */
  isPaused(roomId: string): Promise<boolean>;

  /** Empty the room's queue and clear its paused flag (test/reset helper). */
  clear(roomId: string): Promise<void>;
}

/** Redis key schema — room-scoped, so TICKET-9 needs no key changes. */
export const keys = {
  queue: (roomId: string) => `room:${roomId}:queue`,
  paused: (roomId: string) => `room:${roomId}:paused`,
};
