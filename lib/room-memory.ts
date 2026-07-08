/**
 * Room memory — device-level, no-login recovery (TICKET-43).
 *
 * Remembers, in `localStorage`, every room this DEVICE has touched — the ones it
 * CREATED (so a host who loses the tab or the shown-once host code can still find
 * their room's admin/tv/patron links) and the ones it JOINED as a patron (so the
 * link survives a refresh). This is the anonymous bridge until accounts land
 * (wave 4/5 — see `work/planning/accounts-and-identity.md`); it is honest about
 * its limits: it is per-browser/device and clearing site data loses it.
 *
 * SECURITY INVARIANT (load-bearing): we NEVER persist the host code. It is
 * shown-once by design (see app/new/page.tsx + the MEDIUM-2 note in host-auth.ts)
 * — the raw code is not even stored server-side. We persist only that this device
 * CREATED the room; recovering host control still requires the code (or a live
 * ~12h host-session cookie). The `RememberedRoom` type has no field for it and
 * `rememberCreatedRoom` strips any stray `hostCode`-shaped property defensively.
 *
 * STORAGE-KEY NOTE (TICKET-33 rebrand): the key stays under the `cantai_` family
 * (`cantai_rooms_v1`) — consistent with the other live on-device keys
 * (`cantai_last_room`, `cantai_patron_uuid`, `cantai:<room>:*`) which are
 * deliberately kept under the old brand so returning users don't lose state.
 *
 * TESTABILITY: the pure functions here take an injected `StorageLike` (the
 * `localStorage` subset) so they run under jest's node env with a fake — no DOM.
 * The React landing page passes `window.localStorage`.
 */

/** The `localStorage` subset this module needs. Injected for testability. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * localStorage key for the remembered-rooms list. Versioned for future migration:
 * additive shape changes are absorbed at read time by `coerceRoom`'s defaults (no
 * key bump); bump to `_v2` ONLY on a breaking shape change, with a one-time
 * read-v1→write-v2 migration in `loadRooms` (NIT-2, PR #22 review).
 */
export const ROOMS_KEY = "cantai_rooms_v1";

/**
 * Cap on remembered rooms. Keeps the list bounded (and the landing section
 * scannable) — oldest-touched rooms fall off first. ~50 is generous for a device
 * that both hosts and sings; well under any localStorage size concern.
 */
export const MAX_ROOMS = 50;

/** How this device relates to a remembered room. */
export type RoomRole = "created" | "joined";

/**
 * One remembered room. NOTE the deliberate absence of any host-code field — see
 * the SECURITY INVARIANT in the file header. `lastTouched` (epoch ms) is the
 * single ordering key for both roles (created→createdAt, joined→lastSeen collapse
 * into it), so the list is trivially most-recent-first.
 */
export interface RememberedRoom {
  /** Room id (the join slug). */
  id: string;
  /** Venue / room display name. */
  name: string;
  /** Whether this device created the room or joined it as a patron. */
  role: RoomRole;
  /** Epoch ms of the last interaction — the ordering + recency key. */
  lastTouched: number;
  /**
   * WAVE-4/5 SEAM (accounts): true once this device's anonymous identity can
   * hand this room to a signed-in account. Today it is always true for created
   * rooms (the device is the only owner proof) and false for joined rooms (a
   * patron doesn't own the room). The future `syncLocalRooms()` reads this to
   * decide what to claim on sign-up. Kept in the persisted shape now so the
   * store doesn't need a migration when accounts land — see
   * work/planning/accounts-and-identity.md (I-2: claim = uuid→account link).
   */
  claimable: boolean;
}

/** A safe no-op storage for SSR / sandboxed / storage-disabled contexts. */
const NULL_STORAGE: StorageLike = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

/**
 * Resolve the browser's `localStorage`, or a null-object when unavailable
 * (SSR, private-mode quota, sandboxed iframe). Callers get a working store that
 * simply forgets — the app never throws over storage.
 */
export function browserStorage(): StorageLike {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    /* access to localStorage can throw in sandboxed frames */
  }
  return NULL_STORAGE;
}

/** Narrow an unknown parsed value to a well-formed RememberedRoom, or null. */
function coerceRoom(raw: unknown): RememberedRoom | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) return null;
  if (r.role !== "created" && r.role !== "joined") return null;
  const lastTouched = typeof r.lastTouched === "number" ? r.lastTouched : 0;
  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name : r.id,
    role: r.role,
    lastTouched,
    // Defensive default: created rooms claimable, joined not — regardless of
    // what an older/tampered blob said.
    claimable: typeof r.claimable === "boolean" ? r.claimable : r.role === "created",
  };
}

/**
 * Read + normalize the remembered-room list, most-recent-first. Tolerates a
 * missing/corrupt blob (returns []) and drops malformed entries — the store is a
 * convenience cache, never a source of truth, so it fails soft.
 */
export function loadRooms(storage: StorageLike = browserStorage()): RememberedRoom[] {
  let parsed: unknown;
  try {
    const blob = storage.getItem(ROOMS_KEY);
    if (!blob) return [];
    parsed = JSON.parse(blob);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rooms = parsed
    .map(coerceRoom)
    .filter((r): r is RememberedRoom => r !== null);
  return sortRooms(rooms);
}

/**
 * How many created rooms the landing page eagerly probes for a live host session
 * (BLOCKING-1, PR #22 review). Only the most-recently-touched few are plausible
 * "still-warm cookie" candidates (the cookie lives ~12h); probing all 50 would
 * fan out 50 parallel fetches on every landing load.
 */
export const MAX_HOST_PROBES = 3;

/**
 * The created rooms worth an eager host-session probe: most-recent-first,
 * bounded at `limit` (default MAX_HOST_PROBES). Rooms beyond the bound aren't
 * probed — their admin links route through the login gate, which self-corrects
 * via its own `checkSession()` on load. Pure (input is assumed sorted, as
 * `loadRooms` returns it), so the probe bound is unit-testable without a DOM.
 */
export function roomsToProbe(
  rooms: RememberedRoom[],
  limit: number = MAX_HOST_PROBES,
): RememberedRoom[] {
  return rooms.filter((r) => r.role === "created").slice(0, limit);
}

/** Sort a copy most-recent-first (stable on ties by id for determinism). */
function sortRooms(rooms: RememberedRoom[]): RememberedRoom[] {
  return [...rooms].sort(
    (a, b) => b.lastTouched - a.lastTouched || a.id.localeCompare(b.id),
  );
}

/** Persist the list (already normalized). Fails soft on quota/sandbox errors. */
function saveRooms(rooms: RememberedRoom[], storage: StorageLike): void {
  try {
    storage.setItem(ROOMS_KEY, JSON.stringify(rooms));
  } catch {
    /* quota exceeded / sandboxed — the cache just doesn't persist this round */
  }
}

/**
 * Upsert a room into the list: dedupe by id, refresh recency, cap at MAX_ROOMS
 * (oldest dropped), persist. The returned list is the new most-recent-first
 * state. This is the single mutation primitive both public `remember*` helpers
 * funnel through.
 *
 * Role-merge rule: a "created" mark is sticky — if a device both created and
 * later joined a room, it stays "created" (and claimable), because ownership is
 * the stronger relationship and drives the richer link set.
 */
function upsert(
  entry: Omit<RememberedRoom, "claimable"> & { claimable?: boolean },
  storage: StorageLike,
): RememberedRoom[] {
  const rooms = loadRooms(storage);
  const existing = rooms.find((r) => r.id === entry.id);
  const role: RoomRole =
    existing?.role === "created" || entry.role === "created" ? "created" : "joined";
  const merged: RememberedRoom = {
    id: entry.id,
    name: entry.name || existing?.name || entry.id,
    role,
    lastTouched: entry.lastTouched,
    claimable: role === "created",
  };
  const next = sortRooms([merged, ...rooms.filter((r) => r.id !== entry.id)]).slice(
    0,
    MAX_ROOMS,
  );
  saveRooms(next, storage);
  return next;
}

/**
 * Remember a room this device CREATED. Persists id + name + createdAt only.
 *
 * The `input` type structurally forbids a host code, and we additionally strip
 * any `hostCode`-shaped property defensively (belt-and-suspenders for the
 * SECURITY INVARIANT) before it can reach the store.
 */
export function rememberCreatedRoom(
  input: { id: string; name: string; createdAt?: number },
  storage: StorageLike = browserStorage(),
): RememberedRoom[] {
  // Defensive strip: never let a stray hostCode ride in via an over-broad object.
  const { id, name } = input;
  return upsert(
    { id, name, role: "created", lastTouched: input.createdAt ?? Date.now() },
    storage,
  );
}

/**
 * Remember a room this device JOINED as a patron. Persists id + name + lastSeen.
 * If the device already CREATED this room, the created mark wins (see upsert).
 */
export function rememberJoinedRoom(
  input: { id: string; name: string; lastSeen?: number },
  storage: StorageLike = browserStorage(),
): RememberedRoom[] {
  const { id, name } = input;
  return upsert(
    { id, name, role: "joined", lastTouched: input.lastSeen ?? Date.now() },
    storage,
  );
}

/** Forget a single remembered room (the landing-page ✕). Returns the new list. */
export function forgetRoom(
  id: string,
  storage: StorageLike = browserStorage(),
): RememberedRoom[] {
  const next = loadRooms(storage).filter((r) => r.id !== id);
  saveRooms(next, storage);
  return next;
}

/**
 * WAVE-4/5 SEAM — sync local room memory into a signed-in account.
 *
 * TODO(accounts, wave 4/5): implement once host accounts land. Per
 * `work/planning/accounts-and-identity.md` (decision I-2), claiming is a
 * uuid→account LINK resolved at read time, not a data rewrite — so this should
 * POST the `claimable` rooms' ids to a `/api/account/claim-rooms` endpoint that
 * links each to the freshly signed-in account (server verifies ownership via the
 * device's registered anonymous uuid, TICKET-26, or host-token proof for legacy
 * rooms). It is intentionally a no-op stub today: TICKET-43 ships the storage
 * shape + the `claimable` flag so accounts can be built without a migration, and
 * explicitly does NOT build auth.
 *
 * @returns the rooms that WOULD be claimed (the claimable subset), so a caller
 *          can preview/telemeter without side effects.
 */
export function syncLocalRooms(
  storage: StorageLike = browserStorage(),
): RememberedRoom[] {
  // No-op until accounts exist. Surfaces the claimable set for the future caller.
  return loadRooms(storage).filter((r) => r.claimable);
}
