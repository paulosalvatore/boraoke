/**
 * Core domain types for the cantai rotation / fairness queue engine.
 *
 * Everything here is data-only. The engine (see `engine.ts`) treats these as
 * immutable: operations return new values and never mutate their inputs.
 */

/** How a participant takes part in a given entry. */
export type EntryMode = "sing" | "listen";

/** The venue's rotation policy. */
export type VenueMode = "full-karaoke" | "per-table-2" | "per-person-1";

/**
 * A queue entry as supplied by a caller (the app). `submittedAt` is assigned by
 * the engine, so callers never provide it.
 */
export interface EntryInput {
  /** Stable unique id for this entry (caller-provided, e.g. a uuid). */
  id: string;
  /** YouTube video id to play. */
  videoId: string;
  /** Human-readable song title (optional, display only). */
  title?: string;
  /** Anonymous stable identity of the participant. */
  uuid: string;
  /** Display nickname of the participant. */
  nickname: string;
  /** Optional table number / label. */
  table?: string;
  /** Whether this entry takes a sing turn or is a listen/dance-only entry. */
  mode: EntryMode;
}

/**
 * A queue entry once accepted by the engine. Identical to {@link EntryInput}
 * plus the engine-assigned monotonic sequence `submittedAt`.
 */
export interface Entry extends EntryInput {
  /** Monotonic submission sequence assigned by the engine (0, 1, 2, …). */
  submittedAt: number;
}

/** What happened to a played/skipped entry, recorded in history. */
export type HistoryOutcome = "played" | "skipped";

/** A record of an entry that left the live queue (played or skipped). */
export interface HistoryRecord {
  entry: Entry;
  outcome: HistoryOutcome;
  /** The virtual sequence tick at which it left the queue. */
  at: number;
}

/** Tunable knobs for the engine. */
export interface QueueOptions {
  /**
   * Maximum number of `listen` entries allowed to play consecutively while at
   * least one `sing` entry is still waiting. Default 1. `null` means "no cap"
   * (listen entries interleave purely by submission order). `Infinity` is
   * accepted at `createQueue` and normalized to `null` so that `QueueState`
   * stays JSON-round-trip safe (`JSON.stringify(Infinity)` yields `null`;
   * we make `null` the canonical no-cap representation).
   */
  maxConsecutiveListen: number | null;
}

/** The full immutable state of a venue's queue. */
export interface QueueState {
  venueMode: VenueMode;
  /** Live queue: every accepted entry not yet played or skipped. */
  entries: Entry[];
  /** Everything that has left the queue, in the order it left. */
  history: HistoryRecord[];
  /** Next `submittedAt` sequence value to assign. */
  nextSeq: number;
  /** Virtual clock: increments each time a sing entry is played. */
  singClock: number;
  /**
   * Per-bucket record of the `singClock` value at which that bucket last had a
   * sing entry played. Keyed by uuid (per-person) or table bucket (per-table).
   * Absence means "never sang" and sorts first (highest priority).
   */
  lastSangByUuid: Record<string, number>;
  lastSangByTable: Record<string, number>;
  /**
   * Persisted count of `listen` entries played consecutively (reset to 0 each
   * time a `sing` entry plays; skips leave it untouched). This is what makes
   * the listen-starvation cap hold across successive `advance` calls, not just
   * within one `getEffectiveOrder` snapshot — peek and play always agree.
   */
  consecutiveListen: number;
  options: QueueOptions;
}

/** Why an {@link EntryInput} was rejected by `addEntry`. */
export type RejectReason =
  | "duplicate" // same uuid + videoId already queued
  | "table-cap" // per-table-2: table already has 2 queued sing entries
  | "person-cap"; // per-person-1: uuid already has a queued sing entry

/** Result of an `addEntry` attempt. */
export type AddResult =
  | { accepted: true; state: QueueState; entry: Entry }
  | { accepted: false; state: QueueState; reason: RejectReason };

/** Result of an `advance` (play next) call. */
export interface AdvanceResult {
  state: QueueState;
  /** The entry that was played, or `undefined` if the queue was empty. */
  played?: Entry;
}

/** Result of a `skip` call. */
export interface SkipResult {
  state: QueueState;
  /** The entry that was skipped, or `undefined` if there was nothing to skip. */
  skipped?: Entry;
}
