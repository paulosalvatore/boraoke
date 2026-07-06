/**
 * Rotation adapter (TICKET-10) — the single boundary between the app's frozen
 * `QueueStore` and the pure `@cantai/rotation-engine`.
 *
 * Responsibilities:
 *  - translate app `QueueEntry` ⇄ engine `Entry` (spec A6 naming: app
 *    `patronUuid`→engine `uuid`, app `mode:"listen-dance"`→engine
 *    `mode:"listen"`; `RoomMode` === engine `VenueMode` verbatim);
 *  - compute the EFFECTIVE play order over the store's queue without mutating
 *    the frozen store contract (composition, not modification);
 *  - enforce submit-time caps per mode with friendly pt-BR copy;
 *  - re-lay the store into effective order on the two ordering mutations
 *    (submit, mode-switch) using only the frozen `reorder` op.
 *
 * Integration model — why re-lay instead of a stored fairness ledger:
 * the frozen store holds only the pending queue (no per-session sing history),
 * so ordering is computed FRESH over the current queue. `items[0]` is the pinned
 * now-playing entry (the TV is playing it); its fairness group is seeded as
 * "served this round" so the on-stage turn is never double-scheduled (spec's
 * `nowPlaying` quota rule). This satisfies every spec AC, which test a single
 * ordering snapshot or a submit-time decision. Fairness memory is one turn deep
 * (only the current now-playing group is seeded) — a documented v1 tradeoff the
 * ticket accepts ("full-queue read-per-advance at bar scale"); deeper
 * cross-play credit is out of scope (needs store state the contract forbids).
 */

import "server-only";

import {
  addEntry as engineAddEntry,
  getEffectiveOrder,
  type Entry as EngineEntry,
  type EntryInput as EngineInput,
  type QueueState,
} from "@cantai/rotation-engine";
import { store, type QueueEntry } from "./store";
import {
  LISTEN_CAP_PER_UUID,
  PER_PERSON_CAP,
  PER_TABLE_CAP,
  type RoomMode,
} from "./rotation-modes";

/** Spec listen policy (A3): listens play only when the sing queue is empty. */
const SPEC_MAX_CONSECUTIVE_LISTEN = 0;

/** engine bucket key — MUST match the engine's `tableBucket` (table, else per-uuid). */
function bucketKey(uuid: string, table: string | undefined): string {
  return table != null && table !== "" ? `table:${table}` : `no-table:${uuid}`;
}

/** Map an app queue entry to an engine entry (assigning the engine's seq). */
function toEngineEntry(e: QueueEntry, seq: number): EngineEntry {
  return {
    id: e.id,
    videoId: e.videoId,
    title: e.title,
    uuid: e.patronUuid,
    nickname: e.nickname,
    table: e.table,
    mode: e.mode === "listen-dance" ? "listen" : "sing",
    submittedAt: seq,
    graceRequeue: e.graceRequeue,
  };
}

/** Chronological compare on the app's ISO `submittedAt`. */
function bySubmittedAt(a: QueueEntry, b: QueueEntry): number {
  return a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0;
}

/** Build an engine `QueueState` from a list of app entries under a mode. */
function buildState(
  entries: EngineEntry[],
  mode: RoomMode,
  seed?: { lastSangByUuid: Record<string, number>; lastSangByTable: Record<string, number>; singClock: number },
): QueueState {
  return {
    venueMode: mode,
    entries,
    history: [],
    nextSeq: entries.length,
    singClock: seed?.singClock ?? 0,
    lastSangByUuid: seed?.lastSangByUuid ?? {},
    lastSangByTable: seed?.lastSangByTable ?? {},
    consecutiveListen: 0,
    noShowStreakByUuid: {},
    options: { maxConsecutiveListen: SPEC_MAX_CONSECUTIVE_LISTEN },
  };
}

/**
 * Compute the effective play order over a store queue (`items[0]` = now-playing,
 * pinned). Returns `[nowPlaying, ...fairUpcoming]`. Deterministic and
 * idempotent: ordering an already-effective queue returns the same order.
 */
export function orderQueue(items: QueueEntry[], mode: RoomMode): QueueEntry[] {
  if (items.length <= 1) return items.slice();
  const nowPlaying = items[0];
  const pending = items.slice(1);

  const sorted = [...pending].sort(bySubmittedAt);
  const entries = sorted.map((e, i) => toEngineEntry(e, i));

  // Seed the now-playing group as "served this round" so its on-stage turn
  // isn't scheduled again ahead of others (spec nowPlaying quota consumption).
  const lastSangByUuid: Record<string, number> = {};
  const lastSangByTable: Record<string, number> = {};
  let singClock = 0;
  if (nowPlaying.mode === "sing") {
    lastSangByUuid[nowPlaying.patronUuid] = 0;
    lastSangByTable[bucketKey(nowPlaying.patronUuid, nowPlaying.table)] = 0;
    singClock = 1;
  }

  const ordered = getEffectiveOrder(
    buildState(entries, mode, { lastSangByUuid, lastSangByTable, singClock }),
  );
  const byId = new Map(pending.map((e) => [e.id, e]));
  return [nowPlaying, ...ordered.map((e) => byId.get(e.id)!)];
}

// ── submit-time enforcement ─────────────────────────────────────────────────

export type SubmitCheck =
  | { ok: true }
  | { ok: false; reason: "cap" | "table-required" | "duplicate"; message: string };

/** Map an app candidate to an engine input for cap/duplicate evaluation. */
function toEngineInput(candidate: QueueEntry): EngineInput {
  return {
    id: candidate.id,
    videoId: candidate.videoId,
    title: candidate.title,
    uuid: candidate.patronUuid,
    nickname: candidate.nickname,
    table: candidate.table,
    mode: candidate.mode === "listen-dance" ? "listen" : "sing",
  };
}

/**
 * Decide whether a new submission is accepted under the current mode, using the
 * engine's own cap/duplicate logic (single source of truth) plus the two
 * app-layer rules the pure engine leaves to the UI: table-required in
 * per-table-2 and the per-uuid listen anti-spam cap. Returns friendly pt-BR copy
 * for every rejection.
 */
export function checkSubmit(
  currentQueue: QueueEntry[],
  candidate: QueueEntry,
  mode: RoomMode,
): SubmitCheck {
  const isSing = candidate.mode !== "listen-dance";

  // Table required for a sing entry in per-table-2 (spec).
  if (isSing && mode === "per-table-2" && !candidate.table) {
    return {
      ok: false,
      reason: "table-required",
      message: "Informe o número da sua mesa — o bar está no modo 2 por mesa.",
    };
  }

  // Listen anti-spam cap (spec: max 3 pending listen per uuid).
  if (!isSing) {
    const pendingListens = currentQueue.filter(
      (e) => e.mode === "listen-dance" && e.patronUuid === candidate.patronUuid,
    ).length;
    if (pendingListens >= LISTEN_CAP_PER_UUID) {
      return {
        ok: false,
        reason: "cap",
        message: `Você já tem ${LISTEN_CAP_PER_UUID} pedidos de música na fila — espere um tocar.`,
      };
    }
    return { ok: true };
  }

  // Sing caps + exact-duplicate: delegate to the engine over the current queue.
  const entries = [...currentQueue]
    .sort(bySubmittedAt)
    .map((e, i) => toEngineEntry(e, i));
  const res = engineAddEntry(buildState(entries, mode), toEngineInput(candidate));
  if (res.accepted) return { ok: true };

  if (res.reason === "duplicate") {
    return {
      ok: false,
      reason: "duplicate",
      message: "Você já pediu essa música — ela já está na fila.",
    };
  }
  if (res.reason === "table-cap") {
    return {
      ok: false,
      reason: "cap",
      message: `Sua mesa já tem ${PER_TABLE_CAP} músicas na fila — espere uma tocar.`,
    };
  }
  return {
    ok: false,
    reason: "cap",
    message: `Você já tem ${PER_PERSON_CAP} músicas na fila — espere uma tocar para adicionar outra.`,
  };
}

// ── re-lay ──────────────────────────────────────────────────────────────────

/**
 * Re-lay the room's stored queue into effective order (pinning now-playing) so
 * that reads render fairly AND `advance`/`skip` (which operate on the store's
 * physical head) play the effective head. Uses the store's bulk `rewrite` op —
 * ONE store call regardless of queue depth (security MEDIUM-1 on PR #14: the
 * previous N-1 sequential `reorder` calls were ~3 Redis RTTs each — seconds of
 * patron-borne submit latency near QUEUE_MAX). No-op for a queue of 0/1
 * entries. Best-effort last-writer-wins on races (the same read-modify-write
 * semantics `reorder` already had); a racing mutation self-heals on the next
 * relay.
 */
export async function relayQueue(roomId: string, mode: RoomMode): Promise<void> {
  const items = await store.getQueue(roomId);
  if (items.length <= 1) return;
  const desired = orderQueue(items, mode);
  await store.rewrite(roomId, desired);
}
