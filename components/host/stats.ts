/**
 * Host dashboard stat counters (TICKET-7).
 *
 * Pure, derived from the current queue only — no new storage (per spec). The
 * three counters the bar owner glances at during the night.
 */
import type { QueueEntry } from "@/lib/store";

export interface HostStats {
  /** Entries in the queue right now (queue count tonight). */
  total: number;
  /** Distinct singers, by patron uuid. */
  singers: number;
  /** Distinct active tables (entries without a table are not counted). */
  tables: number;
}

export function computeStats(items: QueueEntry[]): HostStats {
  const singers = new Set<string>();
  const tables = new Set<string>();
  for (const e of items) {
    if (e.patronUuid) singers.add(e.patronUuid);
    const t = e.table?.trim();
    if (t) tables.add(t);
  }
  return { total: items.length, singers: singers.size, tables: tables.size };
}
