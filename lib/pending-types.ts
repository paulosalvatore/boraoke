/**
 * Pending-moderation domain types + constants (TICKET-44) — the single source of
 * truth shared by the pending store, the submission route, the host approval
 * routes, and the patron pending-status route.
 *
 * This file is deliberately PURE: no `server-only`, no React, no driver imports,
 * so both a `"use client"` view (via the API response shape) and the server
 * store/routes import it without dragging server code into the client bundle.
 *
 * WHY a separate domain (not the frozen `QueueStore`): venue-optional moderation
 * routes an unapproved submission into a PARALLEL keyspace so the rotation engine,
 * the public `GET /api/queue`, and the TV never see it (they read only
 * `store.getQueue`). Approval is what promotes an entry into the real queue —
 * exactly then all existing caps/fairness apply. See TICKET-44.
 */

import type { QueueEntry } from "./store";

/**
 * Pending lifecycle. `pending` = awaiting the host; `rejected` = the host said
 * no (kept briefly so the patron's own poll can surface a polite rejected state
 * before it ages out). Approval doesn't get a status — the entry is TAKEN
 * (removed) from the pending store and handed to the normal `addEntry` flow.
 */
export type PendingStatus = "pending" | "rejected";

/**
 * One entry awaiting (or refused) host moderation. It is a full {@link QueueEntry}
 * (so approval hands the exact same shape to `store.addEntry`) plus the pending
 * bookkeeping: the owning room, a time-sortable `pendingId`, the status, and the
 * creation timestamp. `entry.id` is the UUID the queue will use post-approval;
 * `pendingId` is the moderation-list handle (host approve/reject target).
 */
export interface PendingEntry {
  /** Moderation-list id — time-sortable, the approve/reject target. */
  pendingId: string;
  /** Owning room (redundant with the keyspace, but handy for uuid-scoped reads). */
  roomId: string;
  /** The queue entry as submitted — handed verbatim to `addEntry` on approval. */
  entry: QueueEntry;
  status: PendingStatus;
  /** ISO 8601, server clock. */
  createdAt: string;
}

/**
 * Per-room pending ceiling — bounds the host's approval queue against a flood
 * (abuse coherence §6). Env-tunable; default 100. Over this → polite 429.
 */
export function pendingRoomMax(): number {
  const raw = Number(process.env.PENDING_ROOM_MAX);
  return Number.isFinite(raw) && raw >= 0 ? raw : 100;
}

/**
 * Per-uuid pending ceiling — a single patron can't monopolize the approval
 * queue. Env-tunable; default 5. Over this → polite 429. (The upstream submit
 * rate limit still applies BEFORE this, unchanged — this is a second, durable,
 * moderation-scoped bound.)
 */
export function pendingUuidMax(): number {
  const raw = Number(process.env.PENDING_UUID_MAX);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5;
}

/**
 * Time-sortable pending id: base36(ms) prefix (fixed width) + random tail.
 * Mirrors feedback's `generateFeedbackId` so the index reads back chronologically
 * (oldest-first = fairest approval order for the host).
 */
export function generatePendingId(now: number = Date.now()): string {
  const ts = now.toString(36).padStart(9, "0"); // sortable well past year 5000
  const rand =
    (globalThis.crypto?.randomUUID?.() ?? `${Math.random()}${Math.random()}`)
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 12);
  return `${ts}-${rand}`;
}
