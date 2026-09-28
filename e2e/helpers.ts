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
import type { APIRequestContext, Page } from "@playwright/test";

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
 * NAME CAVEAT (TICKET-88): this helper is misnamed by history — it is not only
 * for moderation specs. `/api/host/pending` is polled by EVERY authenticated
 * host console (AdminRoom mounts a 3s poll of `/api/host/session`,
 * `/api/queue` AND `/api/host/pending`), so any spec that seeds state and then
 * lands on an AUTHED `/[room]/admin` needs this warm-up, moderation or not.
 * The name is left alone deliberately: three specs already import it, and
 * renaming would churn them for no behavioural gain. Read it as "warm the
 * authed host-console + moderation routes".
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
  // TICKET-88: the authed console's other two polled endpoints. `/api/queue` is
  // warmed by essentially every spec already and `/api/host/session` happens to
  // be compiled by AdminRoom's unauthenticated login gate — but "happens to be"
  // is exactly the accidental coupling that made rotation-modes fragile, so
  // both are warmed explicitly here rather than left to a caller's side effects.
  await request.get("/api/host/session");
  // TICKET-104: `/api/host/claim` is POSTed by AdminRoom whenever the session
  // probe fails — i.e. on EVERY login-gate render — so from now on it compiles
  // mid-test in any spec that reaches the gate, wiping the memory store and the
  // room the spec just created. Exactly the "happens to be compiled" coupling
  // this helper exists to remove, so it is warmed explicitly here.
  // NB-6 (PR #81 review): warm with a DELIBERATELY MALFORMED room id. It compiles
  // the route just the same but returns 400 before the throttle or the store is
  // touched, so the warm-up never spends a claim budget of its own.
  await request.post("/api/host/claim?room=!!");
  await request.get("/api/queue");
  await request.get("/api/host/pending");
  await request.post("/api/host/pending/approve", { data: { pendingId: "warmup" } });
  await request.post("/api/host/pending/reject", { data: { pendingId: "warmup" } });
  await request.post("/api/host/moderation", { data: { moderation: false } });
  // TICKET-94: `/api/host/language` is POSTed by AdminRoom's language select and
  // is referenced by NO spec, so nothing compiles it before a console test that
  // touches it. Same latent shape as `/api/feedback` — warmed here rather than
  // waiting for a spec to trip over it. Invalid body on purpose: fire-to-compile.
  await request.post("/api/host/language", { data: { language: "" } });
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
 * Warm `/api/feedback` (TICKET-94).
 *
 * WHY THIS EXISTS: this route is reached ONLY through the feedback widget's UI,
 * and `grep -rn "api/feedback" e2e/` returns nothing — no spec ever calls it
 * directly, so nothing compiles it first. Under `next dev` the route's FIRST
 * compile therefore happens inside the test's own assertion window, and
 * `feedback.spec.ts` asserts the confirmation copy with a 5s timeout. On a
 * loaded machine that compile can exceed the timeout and the test fails on a
 * product path that is working correctly — observed three times on 2026-09-01.
 *
 * Unlike the specs TICKET-88 fixed, this route was not even riding on a
 * sibling's incidental warm-up: nothing warmed it at all, so no file-order
 * accident was protecting it.
 *
 * The body is INVALID on purpose. `/api/feedback` POST rejects an unknown
 * `sentiment` with a 400 before writing anything, so this compiles the route
 * without planting a junk record in the feedback store — same fire-to-compile
 * posture as the dummy ids in `warmModerationRoutes`.
 */
export async function warmFeedbackRoute(request: APIRequestContext) {
  await request.post("/api/feedback", { data: { sentiment: "__warmup__" } });
}

/**
 * Remove every queued entry through the HOST control plane
 * (`POST /api/host/remove`), which is host-authed but — unlike advance — carries
 * NO per-room rate limit, and is idempotent by contract (an id already gone
 * still returns 200). Requires a host session cookie, so it logs in first.
 *
 * This is the fallback arm of {@link drainQueue}, not a general-purpose helper:
 * prefer draining by advance, which exercises the real rotation path.
 */
async function removeAllEntries(
  request: APIRequestContext,
  roomId: string,
  rawHostCode?: string,
): Promise<void> {
  const q = roomQuery(roomId);
  const loginQ = roomId === DEFAULT_ROOM ? "" : q;
  await request.post(`/api/host/login${loginQ}`, {
    data: { token: rawHostCode ?? DEV_FALLBACK_TOKEN },
  });
  const data = await (await request.get(`/api/queue${q}`)).json();
  for (const entry of data.items ?? []) {
    await request.post(`/api/host/remove${q}`, { data: { entryId: entry.id } });
  }
}

/**
 * Drain a room's queue to empty via authenticated advances.
 *
 * TICKET-116 — why this is no longer a bare advance loop. Under `next dev` the
 * in-memory store was silently WIPED by module re-evaluation every time a route
 * compiled or was evicted, so a queue that this helper failed to drain got
 * cleared for free by the dev server a moment later. Running against a
 * production build removes that accidental reset — correctly — and it exposed a
 * dependency the suite did not know it had: the shared `default` room's queue
 * now survives for the whole run, and `POST /api/queue/advance` is capped at 12
 * per room per 60s (`lib/advance-rate-limit.ts`). Past that cap the advances 429
 * silently, the loop below spins without progress, and the NEXT spec to assert
 * on `default` sees leftovers — measured as 4 failures reading
 * `toHaveCount(3) -> received 7` and an idle `/tv` that still had a player.
 *
 * So: advance while advancing works (the real rotation path, unchanged for the
 * handful-of-entries case every spec actually has), and if the queue is still
 * not empty — which now only happens when the rate limit bites — fall back to
 * host-authed removal, which has no such cap. The fallback is deliberately
 * second: it must never mask a genuine advance failure in a spec that is
 * testing advance.
 */
export async function drainQueue(
  request: APIRequestContext,
  roomId = DEFAULT_ROOM,
  rawHostCode?: string,
) {
  for (let i = 0; i < 60; i++) {
    const data = await (await request.get(`/api/queue${roomQuery(roomId)}`)).json();
    if (!data.items?.length) return;
    const res = await advanceOnce(request, roomId, rawHostCode);
    if (!res.ok()) break; // rate-limited (429) or otherwise refused — stop spinning
  }
  await removeAllEntries(request, roomId, rawHostCode);
}

/**
 * The httpOnly identity cookie (`lib/identity.ts`). Since the TICKET-104 security
 * redesign this is a non-secret LABEL, not a credential — kept named here only so
 * specs can assert that dropping or forging it changes nothing.
 */
export const IDENTITY_COOKIE = "boraoke_identity";

/**
 * Make this browser stop being the room's CREATOR, so the host-code login gate is
 * reachable again (TICKET-104).
 *
 * Since TICKET-104 a creator never sees the gate: `POST /api/host/claim`
 * re-authenticates them off a credential their device holds, which is the whole
 * point. Specs that exist to exercise the CODE path therefore have to present
 * themselves as a different device — a venue tablet typing the code a host created
 * elsewhere, which is exactly the scenario the gate serves.
 *
 * WHICH cookie this drops is load-bearing and changed in the security round: the
 * credential is now the purpose-built `boraoke_claim_<room>` token, NOT the
 * identity uuid. Dropping the identity cookie alone no longer makes a device a
 * non-creator, and a helper that did so would silently stop reaching the gate —
 * which is exactly how four specs broke when the credential was replaced. Both are
 * cleared: the claim cookie because it is the credential, the identity cookie so a
 * spec that wants a genuinely fresh device gets one.
 */
export async function dropCreatorIdentity(page: Page) {
  await page.context().clearCookies({ name: /^boraoke_claim_/ });
  await page.context().clearCookies({ name: IDENTITY_COOKIE });
}
