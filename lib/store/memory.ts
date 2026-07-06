/**
 * In-memory queue store (TICKET-6) — the default driver for local dev & CI.
 *
 * State is per-process and per-instance: on serverless hosting each lambda
 * holds its own copy, so this driver is NOT durable/shared. It exists so the
 * app boots and every test runs with zero credentials. Production uses the
 * Upstash driver (see `upstash.ts`), selected by env in `lib/store.ts`.
 */

import {
  QUEUE_MAX,
  type QueueEntry,
  type QueueStore,
} from "./types";

interface Room {
  queue: QueueEntry[];
  paused: boolean;
}

export class MemoryStore implements QueueStore {
  private rooms = new Map<string, Room>();

  private room(roomId: string): Room {
    let r = this.rooms.get(roomId);
    if (!r) {
      r = { queue: [], paused: false };
      this.rooms.set(roomId, r);
    }
    return r;
  }

  async getQueue(roomId: string): Promise<QueueEntry[]> {
    // Return a copy so callers can't mutate internal state.
    return [...this.room(roomId).queue];
  }

  async addEntry(roomId: string, entry: QueueEntry): Promise<boolean> {
    const r = this.room(roomId);
    if (r.queue.length >= QUEUE_MAX) return false;
    r.queue.push(entry);
    return true;
  }

  async removeEntry(roomId: string, entryId: string): Promise<boolean> {
    const r = this.room(roomId);
    const idx = r.queue.findIndex((e) => e.id === entryId);
    if (idx === -1) return false;
    r.queue.splice(idx, 1);
    return true;
  }

  async advance(roomId: string): Promise<QueueEntry | null> {
    const r = this.room(roomId);
    r.queue.shift();
    return r.queue[0] ?? null;
  }

  async nowPlaying(roomId: string): Promise<QueueEntry | null> {
    return this.room(roomId).queue[0] ?? null;
  }

  async reorder(
    roomId: string,
    entryId: string,
    newIndex: number,
  ): Promise<boolean> {
    const r = this.room(roomId);
    const idx = r.queue.findIndex((e) => e.id === entryId);
    if (idx === -1) return false;
    const clamped = Math.max(0, Math.min(newIndex, r.queue.length - 1));
    const [entry] = r.queue.splice(idx, 1);
    r.queue.splice(clamped, 0, entry);
    return true;
  }

  async rewrite(roomId: string, entries: QueueEntry[]): Promise<void> {
    // Copy so later caller-side mutation can't reach internal state.
    this.room(roomId).queue = [...entries];
  }

  async setPaused(roomId: string, paused: boolean): Promise<void> {
    this.room(roomId).paused = paused;
  }

  async isPaused(roomId: string): Promise<boolean> {
    return this.room(roomId).paused;
  }

  async clear(roomId: string): Promise<void> {
    this.rooms.set(roomId, { queue: [], paused: false });
  }
}
