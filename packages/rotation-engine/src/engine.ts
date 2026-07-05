/**
 * cantai rotation / fairness queue engine.
 *
 * Pure & immutable: every operation takes a {@link QueueState} and returns a
 * new one; inputs are never mutated. The *play order* is a derived function of
 * state ({@link getEffectiveOrder}) rather than a stored, mutated position
 * list — this is what makes mode switches non-destructive (we just recompute).
 *
 * See README.md for the plain-language fairness rules.
 */

import type {
  AddResult,
  AdvanceResult,
  Entry,
  EntryInput,
  QueueOptions,
  QueueState,
  RejectReason,
  SkipResult,
  VenueMode,
} from "./types.ts";

const DEFAULT_OPTIONS: QueueOptions = {
  maxConsecutiveListen: 1,
};

/** Create an empty queue for a venue. */
export function createQueue(
  venueMode: VenueMode,
  options: Partial<QueueOptions> = {},
): QueueState {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  // Normalize the no-cap representation: `Infinity` is accepted for ergonomics
  // but stored as `null` so the state survives a JSON round-trip unchanged
  // (JSON.stringify(Infinity) === "null"; null is the canonical no-cap value).
  if (merged.maxConsecutiveListen === Infinity) {
    merged.maxConsecutiveListen = null;
  }
  return {
    venueMode,
    entries: [],
    history: [],
    nextSeq: 0,
    singClock: 0,
    lastSangByUuid: {},
    lastSangByTable: {},
    consecutiveListen: 0,
    options: merged,
  };
}

// ---------------------------------------------------------------------------
// Bucketing helpers
// ---------------------------------------------------------------------------

/**
 * The table bucket key for an entry in `per-table-2` mode. A tableless entry
 * gets its own per-uuid bucket so tableless singers still rotate fairly and the
 * 2-cap applies to them individually.
 */
function tableBucket(entry: Pick<Entry, "table" | "uuid">): string {
  return entry.table != null && entry.table !== ""
    ? `table:${entry.table}`
    : `no-table:${entry.uuid}`;
}

/** Sing entries currently queued (excludes listen entries). */
function queuedSings(state: QueueState): Entry[] {
  return state.entries.filter((e) => e.mode === "sing");
}

// ---------------------------------------------------------------------------
// addEntry
// ---------------------------------------------------------------------------

/**
 * Attempt to add an entry. Returns an {@link AddResult}; caps and duplicates
 * are rejected with a reason rather than throwing. `submittedAt` is assigned
 * here. Listen entries are never rejected by fairness caps.
 */
export function addEntry(state: QueueState, input: EntryInput): AddResult {
  // Duplicate: same participant already has this exact video queued *in the
  // same mode*. A `listen` for video X does not block a `sing` for X (and
  // vice-versa) — they are different requests (ambiance vs. a mic turn).
  const isDuplicate = state.entries.some(
    (e) =>
      e.uuid === input.uuid &&
      e.videoId === input.videoId &&
      e.mode === input.mode,
  );
  if (isDuplicate) {
    return { accepted: false, state, reason: "duplicate" };
  }

  if (input.mode === "sing") {
    const reason = capViolation(state, input);
    if (reason) {
      return { accepted: false, state, reason };
    }
  }

  const entry: Entry = { ...input, submittedAt: state.nextSeq };
  return {
    accepted: true,
    entry,
    state: {
      ...state,
      entries: [...state.entries, entry],
      nextSeq: state.nextSeq + 1,
    },
  };
}

/** Returns a cap {@link RejectReason} if adding this sing entry would violate the venue mode, else `undefined`. */
function capViolation(
  state: QueueState,
  input: EntryInput,
): RejectReason | undefined {
  if (state.venueMode === "per-person-1") {
    const already = queuedSings(state).some((e) => e.uuid === input.uuid);
    return already ? "person-cap" : undefined;
  }
  if (state.venueMode === "per-table-2") {
    const bucket = tableBucket(input);
    const count = queuedSings(state).filter(
      (e) => tableBucket(e) === bucket,
    ).length;
    return count >= 2 ? "table-cap" : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// removeEntry / moveEntryToTable / setVenueMode
// ---------------------------------------------------------------------------

/** Remove an entry (participant leaves / cancels). Idempotent — no-op if absent. */
export function removeEntry(state: QueueState, entryId: string): QueueState {
  if (!state.entries.some((e) => e.id === entryId)) return state;
  return { ...state, entries: state.entries.filter((e) => e.id !== entryId) };
}

/**
 * Change an entry's table (participant switched tables). No-op if the entry is
 * absent. The move is honored even if it pushes the destination table over the
 * per-table-2 cap (it's a correction, not a new submission); the over-cap
 * entries drain naturally. Returns unchanged state if the entry is not found.
 */
export function moveEntryToTable(
  state: QueueState,
  entryId: string,
  table: string | undefined,
): QueueState {
  const idx = state.entries.findIndex((e) => e.id === entryId);
  if (idx === -1) return state;
  const next = state.entries.slice();
  next[idx] = { ...next[idx], table };
  return { ...state, entries: next };
}

/**
 * Switch the venue mode mid-session. **Never drops entries** — existing
 * entries (even those that would now be over-cap) are grandfathered in and the
 * effective order simply recomputes under the new policy. Caps apply only to
 * *new* submissions after the switch.
 */
export function setVenueMode(
  state: QueueState,
  venueMode: VenueMode,
): QueueState {
  return { ...state, venueMode };
}

// ---------------------------------------------------------------------------
// Effective order (the heart)
// ---------------------------------------------------------------------------

/**
 * Compute the full play order for the current queue: the fair sing order for
 * the venue mode, with listen entries interleaved under the starvation cap.
 * Pure — does not mutate state. This is the single source of truth for
 * `peekUpcoming`, `advance`, and `skip`.
 */
export function getEffectiveOrder(state: QueueState): Entry[] {
  const singOrder = computeSingOrder(state);
  const listens = state.entries
    .filter((e) => e.mode === "listen")
    .sort(bySubmittedAt);
  // Seed the merge from the PERSISTED consecutive-listen run so that the cap
  // holds across successive advance() calls, not just within one snapshot —
  // what peekUpcoming promises is exactly what advance plays.
  return mergeListens(
    singOrder,
    listens,
    state.options.maxConsecutiveListen,
    state.consecutiveListen,
  );
}

/** First `n` entries of the effective order. */
export function peekUpcoming(state: QueueState, n: number): Entry[] {
  if (n <= 0) return [];
  return getEffectiveOrder(state).slice(0, n);
}

function bySubmittedAt(a: Entry, b: Entry): number {
  return a.submittedAt - b.submittedAt;
}

/** Mode-dependent fair ordering of the *sing* entries only. */
function computeSingOrder(state: QueueState): Entry[] {
  const sings = queuedSings(state);
  if (state.venueMode === "full-karaoke") {
    return sings.slice().sort(bySubmittedAt);
  }
  const keyOf =
    state.venueMode === "per-person-1"
      ? (e: Entry) => e.uuid
      : (e: Entry) => tableBucket(e);
  const lastSang =
    state.venueMode === "per-person-1"
      ? state.lastSangByUuid
      : state.lastSangByTable;
  return roundRobin(sings, keyOf, lastSang);
}

/**
 * Generic fair round-robin over buckets.
 *
 * Each bucket is seeded with its real "last sang" virtual-clock value (absent =
 * -1 = never sang = highest priority). We then repeatedly emit the head entry
 * of the bucket that is *least recently served*, and bump that bucket's served
 * marker past everyone still waiting so it rotates to the back. Ties (e.g. two
 * never-sang buckets) break by the head entry's submission order.
 */
function roundRobin(
  entries: Entry[],
  keyOf: (e: Entry) => string,
  lastSang: Record<string, number>,
): Entry[] {
  // Group entries by bucket, preserving submission order within each bucket.
  const buckets = new Map<string, Entry[]>();
  for (const e of entries.slice().sort(bySubmittedAt)) {
    const k = keyOf(e);
    const arr = buckets.get(k);
    if (arr) arr.push(e);
    else buckets.set(k, [e]);
  }

  // Served marker per bucket: real recency, or -1 for never-sang.
  const served = new Map<string, number>();
  for (const k of buckets.keys()) {
    served.set(k, k in lastSang ? lastSang[k] : -1);
  }

  const result: Entry[] = [];
  // Virtual tick used to push a just-served bucket behind all waiting buckets.
  let tick = Math.max(0, ...[...served.values()].map((v) => v + 1));

  const total = entries.length;
  while (result.length < total) {
    // Pick the bucket with a waiting head that is least recently served;
    // tie-break by that head's submittedAt.
    let bestKey: string | undefined;
    let bestServed = Infinity;
    let bestHeadSeq = Infinity;
    for (const [k, arr] of buckets) {
      if (arr.length === 0) continue;
      const s = served.get(k)!;
      const headSeq = arr[0].submittedAt;
      if (s < bestServed || (s === bestServed && headSeq < bestHeadSeq)) {
        bestServed = s;
        bestHeadSeq = headSeq;
        bestKey = k;
      }
    }
    if (bestKey === undefined) break; // defensive; shouldn't happen
    const arr = buckets.get(bestKey)!;
    result.push(arr.shift()!);
    served.set(bestKey, tick);
    tick += 1;
  }
  return result;
}

/**
 * Merge listen entries into the sing order under a starvation cap: at most
 * `maxConsecutiveListen` listen entries may play in a row while sing entries
 * remain (`null` = no cap). Listen entries otherwise slot in by submission
 * order relative to the next-up singer. With no singers left, all remaining
 * listens flush FIFO. `initialConsecutiveListen` seeds the run counter from
 * persisted state so the cap spans advance() calls, not just one snapshot.
 */
function mergeListens(
  sings: Entry[],
  listens: Entry[],
  maxConsecutiveListen: number | null,
  initialConsecutiveListen = 0,
): Entry[] {
  const result: Entry[] = [];
  let si = 0;
  let li = 0;
  let consecutiveListen = initialConsecutiveListen;

  while (si < sings.length || li < listens.length) {
    const nextSing = sings[si];
    const nextListen = listens[li];

    if (nextSing === undefined) {
      // Only listens left — flush them all.
      result.push(nextListen);
      li += 1;
      continue;
    }
    if (nextListen === undefined) {
      // Only sings left — flush them all.
      result.push(nextSing);
      si += 1;
      continue;
    }

    if (maxConsecutiveListen !== null && consecutiveListen >= maxConsecutiveListen) {
      // Cap hit: a singer must go next so singers aren't starved.
      result.push(nextSing);
      si += 1;
      consecutiveListen = 0;
    } else if (nextListen.submittedAt < nextSing.submittedAt) {
      // The waiting listen was submitted before the next-up singer's original
      // submission — let it play (still under the cap).
      result.push(nextListen);
      li += 1;
      consecutiveListen += 1;
    } else {
      result.push(nextSing);
      si += 1;
      consecutiveListen = 0;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// advance / skip
// ---------------------------------------------------------------------------

/**
 * Play the next entry: remove the head of the effective order, record it in
 * history, and — if it was a sing entry — update the fairness recency trackers
 * so its bucket rotates to the back. Listen entries never touch sing recency.
 * Returns `{ state, played: undefined }` on an empty queue.
 */
export function advance(state: QueueState): AdvanceResult {
  const order = getEffectiveOrder(state);
  const head = order[0];
  if (head === undefined) return { state, played: undefined };
  return { state: consume(state, head, "played"), played: head };
}

/**
 * Handle a no-show / skip. By default skips the current head of the effective
 * order; pass `entryId` to skip a specific entry. A skipped **singer keeps
 * their priority**: we do NOT update their sing recency, so if they re-submit
 * they retain their standing (they didn't actually sing). Returns
 * `{ state, skipped: undefined }` if there is nothing to skip.
 */
export function skip(state: QueueState, entryId?: string): SkipResult {
  let target: Entry | undefined;
  if (entryId === undefined) {
    target = getEffectiveOrder(state)[0];
  } else {
    target = state.entries.find((e) => e.id === entryId);
  }
  if (target === undefined) return { state, skipped: undefined };
  // Skip records history + removes the entry but does NOT bump recency.
  const next: QueueState = {
    ...state,
    entries: state.entries.filter((e) => e.id !== target!.id),
    history: [
      ...state.history,
      { entry: target, outcome: "skipped", at: state.singClock },
    ],
  };
  return { state: next, skipped: target };
}

/** Remove `entry` from the queue, record it in history, and update recency if it sang. */
function consume(
  state: QueueState,
  entry: Entry,
  outcome: "played",
): QueueState {
  const entries = state.entries.filter((e) => e.id !== entry.id);
  const history = [
    ...state.history,
    { entry, outcome, at: state.singClock },
  ];

  if (entry.mode !== "sing") {
    // Listen entries don't consume a sing turn or affect fairness recency,
    // but they DO extend the persisted consecutive-listen run so the
    // starvation cap holds across successive advance() calls (peek == play).
    return {
      ...state,
      entries,
      history,
      consecutiveListen: state.consecutiveListen + 1,
    };
  }

  const singClock = state.singClock + 1;
  const lastSangByUuid = {
    ...state.lastSangByUuid,
    [entry.uuid]: singClock,
  };
  const lastSangByTable = {
    ...state.lastSangByTable,
    [tableBucket(entry)]: singClock,
  };
  return {
    ...state,
    entries,
    history,
    singClock,
    lastSangByUuid,
    lastSangByTable,
    // A sing turn breaks any listen run.
    consecutiveListen: 0,
  };
}
