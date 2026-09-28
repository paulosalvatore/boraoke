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

/**
 * The process-wide store singleton — pinned to `globalThis` (TICKET-116).
 *
 * A plain `export const store = createStore()` is discarded whenever this module
 * is RE-EVALUATED, and under `next dev` that happens on every route's first
 * compile and again after each ~25s idle eviction. The queue simply vanished
 * mid-test, at arbitrary points: it is the mechanism behind the deterministic
 * `served-lang.spec.ts` failure that made `main` red, and behind the TICKET-65 /
 * 68 / 88 / 92 deflaking work and the three warm-up helpers in `e2e/helpers.ts`.
 * Pinning to `globalThis` — the standard Next.js dev pattern — means a
 * re-evaluation rebinds to the SAME instance instead of building a fresh one.
 *
 * Unconditional, not `NODE_ENV !== "production"`-guarded, for two reasons: the
 * e2e suite now runs a PRODUCTION build on the memory driver (so a NODE_ENV
 * guard would exclude the case this exists for), and the Upstash driver holds
 * no local state, so pinning it is a no-op rather than a risk. Serverless gives
 * each instance its own global anyway — this changes nothing in production.
 */
const globalForStore = globalThis as unknown as { __boraokeQueueStore?: QueueStore };
export const store: QueueStore =
  globalForStore.__boraokeQueueStore ?? (globalForStore.__boraokeQueueStore = createStore());
