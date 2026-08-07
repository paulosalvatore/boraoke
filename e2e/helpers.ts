/**
 * Shared e2e helpers (TICKET-45).
 *
 * WHY this file exists: TICKET-45 authorizes `POST /api/queue/advance` behind a
 * screen token (see lib/screen-token.ts). Every spec used to drain the queue via
 * a BARE `page.request.post("/api/queue/advance")`, which is exactly the call
 * the enforce mode rejects. Rather than scatter token-minting across specs, the
 * credential is obtained ONCE here and every drain/advance goes through
 * {@link advanceOnce} / {@link drainQueue}.
 *
 * HOW the credential is obtained: the e2e servers run in dev/test mode against
 * the memory store, where a room with no record (the legacy `default` room)
 * keys off the well-known dev-fallback host token (`DEV_FALLBACK_TOKEN`,
 * mirrored here as the specs already hardcode it — see host-controls.spec.ts).
 * We recompute the SAME HMAC the server mints in lib/screen-token.ts. This
 * mirrors the production reality that the token is derived, not stored — the
 * test just holds the same secret the venue's own TV page does.
 *
 * For a non-default room the caller passes the room's raw host code (the value
 * shown once at /new) so the helper can hash it into the room secret.
 */
import { createHmac } from "crypto";
import type { APIRequestContext } from "@playwright/test";

/** Mirror of lib/host-auth.ts DEV_FALLBACK_TOKEN — the default-room dev secret. */
const DEV_FALLBACK_TOKEN = "cantai-dev-host";
/** Mirror of lib/screen-token.ts constants (kept in sync with the server). */
const SCREEN_TOKEN_PREFIX = "boraoke-screen-v1";
const SCREEN_TOKEN_BUCKET_MS = 24 * 60 * 60 * 1000;
/** Mirror of lib/rooms.ts hashHostCode key (deliberately old-brand — frozen). */
const HOSTCODE_HMAC_KEY = "cantai-hostcode-v1";

export const SCREEN_TOKEN_HEADER = "X-Boraoke-Screen";
export const DEFAULT_ROOM = "default";

/**
 * The server-side room secret used to mint/verify the screen token:
 *   - `default` room → the dev-fallback host token (no room record in dev/test).
 *   - a created room → HMAC-SHA256("cantai-hostcode-v1", rawHostCode) — the same
 *     `hostCodeHash` the server stores.
 */
function roomSecret(roomId: string, rawHostCode?: string): string {
  if (roomId === DEFAULT_ROOM || !rawHostCode) return DEV_FALLBACK_TOKEN;
  return createHmac("sha256", HOSTCODE_HMAC_KEY).update(rawHostCode).digest("hex");
}

/**
 * Compute the current-bucket screen token for a room — the same value
 * lib/screen-token.ts mints server-side. `rawHostCode` is only needed for a
 * non-default room.
 */
export function screenTokenFor(roomId = DEFAULT_ROOM, rawHostCode?: string): string {
  const bucket = Math.floor(Date.now() / SCREEN_TOKEN_BUCKET_MS);
  return createHmac("sha256", roomSecret(roomId, rawHostCode))
    .update(`${SCREEN_TOKEN_PREFIX}|${roomId}|${bucket}`)
    .digest("hex");
}

/** Room `?room=` query suffix (absent for the default room). */
function roomQuery(roomId: string): string {
  return roomId === DEFAULT_ROOM ? "" : `?room=${encodeURIComponent(roomId)}`;
}

/**
 * Advance the queue head ONCE, authenticated with the room's screen token — the
 * migrated replacement for a bare `POST /api/queue/advance`. Returns the raw
 * response so callers can assert on it when they care.
 */
export async function advanceOnce(
  request: APIRequestContext,
  roomId = DEFAULT_ROOM,
  rawHostCode?: string,
  reason?: "unplayable",
) {
  const q = roomQuery(roomId);
  const reasonParam = reason ? `${q ? "&" : "?"}reason=${reason}` : "";
  return request.post(`/api/queue/advance${q}${reasonParam}`, {
    headers: { [SCREEN_TOKEN_HEADER]: screenTokenFor(roomId, rawHostCode) },
  });
}

/**
 * Warm-compile the TICKET-44 moderation/pending routes (shared deflake helper).
 *
 * WHY: under `next dev` with the in-memory store, a route's FIRST compilation
 * re-evaluates the shared store/rooms modules and resets their singletons —
 * wiping any state seeded before that compile (the documented memory-driver
 * caveat; production uses durable Upstash). TICKET-44 made the authed admin
 * dashboard poll `/api/host/pending` and the patron page poll
 * `/api/queue/pending`, so ANY spec that seeds state and then opens those pages
 * triggers these compiles mid-test unless they were warmed first. host-controls
 * hit exactly this: the post-login pending poll compiled `/api/host/pending`,
 * the store reset, and the seeded queue vanished at the remove assertion.
 *
 * Call this from every spec's warmUp BEFORE seeding (alongside its existing
 * route warms). All calls are fire-to-compile — responses are irrelevant.
 */
export async function warmModerationRoutes(request: APIRequestContext) {
  await request.get("/api/host/pending");
  await request.post("/api/host/pending/approve", { data: { pendingId: "warmup" } });
  await request.post("/api/host/pending/reject", { data: { pendingId: "warmup" } });
  await request.post("/api/host/moderation", { data: { moderation: false } });
  await request.get(
    "/api/queue/pending?uuid=00000000-0000-4000-8000-000000000000",
  );
}

/**
 * Dedicated, never-real room id used ONLY to trigger route compilation
 * (TICKET-65 §2 revision). Compilation under `next dev` is a PROCESS-WIDE
 * event scoped to the ROUTE FILE, not to the dynamic `[room]` value that
 * happens to trigger it first — `GET /<any-id>/tv` compiles the exact same
 * page bundle as `GET /default/tv`. Routing every warm-up request through a
 * synthetic id that no spec ever seeds, asserts on, or rate-limits against
 * means {@link warmTvRoutes} gets the compile side-effect it needs WITHOUT
 * ever touching a real room's queue contents or advance rate-limit budget —
 * including the shared `default` room that most of this suite's other specs
 * also warm/seed. A full-suite TM investigation on the first version (which
 * warmed straight against the caller's own roomId, almost always
 * DEFAULT_ROOM) found it added measurable contention on that hot shared room
 * under a full-suite run; this id sidesteps the contention instead of just
 * reducing it.
 */
const TV_WARMUP_ROOM = "tv-warmup-e2e";

/**
 * Warm-compile the `/[room]/tv` venue-screen route AND the queue endpoints it
 * polls (shared deflake helper, TICKET-65).
 *
 * WHY: same singleton-reset caveat {@link warmModerationRoutes} documents — a
 * route's FIRST compilation re-evaluates the shared store module in its OWN
 * dev-server bundle, discarding any state seeded before that compile. Confirmed
 * directly for `/tv` (2026-08-05): seeding a queue entry via `POST /api/queue`
 * (already-compiled route), then requesting `/default/tv` for the first time,
 * silently reset the queue to empty — even though `/api/queue` itself was
 * already warm. `tv.spec.ts` had NO warm-up at all (unlike e.g.
 * moderation.spec.ts, which happens to warm `/default/tv` as a side effect of
 * its own flow) — that gap is TICKET-65's root cause, not a timing issue.
 *
 * All three warm requests target {@link TV_WARMUP_ROOM}, never the room the
 * calling test actually seeds/asserts against — see that constant's doc
 * comment for why. The room-agnostic signature (no `roomId` param) reflects
 * that: compiling is a one-time, room-independent, process-wide event, so a
 * caller never needs to name its own room here.
 *
 * Call this BEFORE any seeding, from every spec that seeds queue state and
 * then loads `/tv`.
 */
export async function warmTvRoutes(request: APIRequestContext) {
  await request.get(`/${TV_WARMUP_ROOM}/tv`);
  await request.get(`/api/queue${roomQuery(TV_WARMUP_ROOM)}`);
  // Compile /api/queue/advance. Fire-to-compile only — the response (likely a
  // 401/400 against an unregistered synthetic room) is irrelevant, same
  // posture as warmModerationRoutes' dummy-id calls above. Charged (if
  // charged at all) to the `unplayable` bucket via `reason`, never the tight
  // anti-grief singer-skip bucket — and to TV_WARMUP_ROOM's own budget, not
  // any real room's.
  await advanceOnce(request, TV_WARMUP_ROOM, undefined, "unplayable");
}

/**
 * Drain a room's queue to empty via authenticated advances. Real test seeds are
 * a handful of entries, comfortably under the per-room advance rate limit; the
 * loop bound is only a runaway guard.
 */
export async function drainQueue(
  request: APIRequestContext,
  roomId = DEFAULT_ROOM,
  rawHostCode?: string,
) {
  for (let i = 0; i < 60; i++) {
    const data = await (await request.get(`/api/queue${roomQuery(roomId)}`)).json();
    if (!data.items?.length) return;
    await advanceOnce(request, roomId, rawHostCode);
  }
}
