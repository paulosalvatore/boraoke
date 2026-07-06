/**
 * Queue store — the SINGLE import point (TICKET-6).
 *
 * Nothing outside `lib/store*` imports a driver directly; everyone imports the
 * `store` singleton and the shared types from here. The implementation swaps
 * behind this module by env:
 *
 *   STORE_DRIVER=upstash            → durable Upstash Redis (production)
 *   STORE_DRIVER=memory             → in-process memory (local dev / CI)
 *   (unset) + UPSTASH_REDIS_REST_URL present → upstash
 *   (unset) + no Upstash creds      → memory  (default; boots with zero secrets)
 *
 * All ops are room-scoped and async. Callers pass a roomId — until TICKET-9
 * introduces multi-room, that is the exported DEFAULT_ROOM.
 */

import "server-only";

import { MemoryStore } from "./store/memory";
import { createUpstashStore } from "./store/upstash";
import type { QueueStore } from "./store/types";

export type { QueueStore } from "./store/types";
export { QUEUE_MAX, DEFAULT_ROOM, keys } from "./store/types";
export type { QueueEntry, Mode } from "./store/types";

function resolveDriver(): "memory" | "upstash" {
  const explicit = process.env.STORE_DRIVER?.toLowerCase();
  if (explicit === "upstash" || explicit === "memory") return explicit;
  // Auto: use Upstash when its REST URL is configured, else memory.
  return process.env.UPSTASH_REDIS_REST_URL ? "upstash" : "memory";
}

function createStore(): QueueStore {
  return resolveDriver() === "upstash" ? createUpstashStore() : new MemoryStore();
}

/** The process-wide store singleton. */
export const store: QueueStore = createStore();
