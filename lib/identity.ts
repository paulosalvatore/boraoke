/**
 * Identity request policy (TICKET-26) — Next.js-specific glue on top of the
 * framework-agnostic `lib/identity-store.ts`. Kept as its own file (mirrors
 * `lib/host-auth.ts` sitting beside the plain `lib/rooms.ts` persistence) so
 * the store stays easy to unit-test with no `NextRequest`/`NextResponse` in
 * the loop, while this module owns cookie shape + the mint/reuse/adopt policy.
 *
 * Cookie is the AUTHORITATIVE copy (httpOnly — never readable from client JS,
 * unlike the existing localStorage-only `cantai_patron_uuid`). localStorage on
 * the client remains a fallback copy so a cookie-cleared-but-storage-intact
 * device still recovers its identity via the `legacyUuid` adoption path below.
 */

import "server-only";

import type { NextResponse } from "next/server";
import { validate as uuidValidate, v4 as uuidv4 } from "uuid";
import {
  identityStore,
  type IdentityStore,
  type UserAgentClass,
} from "./identity-store";

/**
 * STORAGE-KEY NOTE: unlike `lib/host-auth.ts`'s `cantai_host*` (frozen — live
 * auth state), this cookie is BRAND NEW as of this ticket, so it uses the
 * current `boraoke` brand (mirrors `SCREEN_TOKEN_PREFIX` in
 * `lib/screen-token.ts`) — no legacy-name constraint applies here.
 */
export const IDENTITY_COOKIE = "boraoke_identity";

/**
 * Cookie lifetime. This is a durable IDENTITY, not a login session (contrast
 * `lib/host-auth.ts`'s 12h host session) — long-lived so a returning patron
 * keeps their identity across visits, capped so it isn't literally forever.
 */
const IDENTITY_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 2; // 2 years

/** Cookie options for the identity cookie (httpOnly, prod-secure, root-scoped). */
export function identityCookieOptions() {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: IDENTITY_MAX_AGE_SECONDS,
  };
}

export function isValidUuid(v: unknown): v is string {
  return typeof v === "string" && uuidValidate(v);
}

/**
 * Coarse User-Agent classification (zero-PII invariant — see
 * `lib/identity-store.ts` file header). Deliberately a small fixed enum, never
 * the raw header value: no version numbers, no device model, no fingerprint
 * surface. Order matters — bot check first (bots often also match
 * mobile/desktop substrings).
 */
export function classifyUserAgent(ua: string | null | undefined): UserAgentClass {
  if (!ua) return "unknown";
  const s = ua.toLowerCase();
  if (/bot|crawler|spider|curl|wget|headless|python-requests/.test(s)) return "bot";
  if (/mobi|android|iphone|ipad/.test(s)) return "mobile";
  if (/mozilla|chrome|safari|firefox|edg\//.test(s)) return "desktop";
  return "unknown";
}

export interface ResolvedIdentity {
  uuid: string;
  /**
   * false = the durable store failed (fail-open, acceptance #4). The caller
   * MUST NOT set the identity cookie in this case — the client keeps using
   * its local-only uuid and the next page load naturally retries
   * registration (no explicit retry loop needed).
   */
  ok: boolean;
}

/** The minimal request shape this module needs — real callers pass a NextRequest. */
export interface IdentityRequestLike {
  cookies: { get(name: string): { value: string } | undefined };
  headers: { get(name: string): string | null };
}

/**
 * Build an identity resolver bound to an explicit store (tests inject a
 * throwing fake to prove fail-open — mirrors `lib/telemetry.ts`'s
 * `createTracker(store)` factory). Production uses the `resolveIdentity`
 * singleton below, bound to the real `identityStore`.
 *
 * Precedence (see work/planning/accounts-and-identity.md "Layer 1"):
 *   1. existing identity cookie whose uuid resolves in the store → touch it
 *      (repeat-load reuse, acceptance #1).
 *   2. else a valid caller-supplied legacy uuid (the client's existing
 *      localStorage `patronUuid`) → touch it, creating a record under that
 *      EXACT uuid if none exists yet (continuity/adoption, acceptance #2 —
 *      no duplicate identity is ever created for a device that already had
 *      one).
 *   3. else mint a brand-new uuid v4 → touch it (fresh-device first touch,
 *      acceptance #1).
 *
 * ADOPTION GUARD (TICKET-104 — load-bearing, do not relax): step 2 adopts a
 * uuid the CALLER asserted, and both callers (`POST /api/identity`,
 * `POST /api/rooms`) then hand it back as the httpOnly identity cookie. That was
 * harmless while nothing authorized off an identity. TICKET-104 makes
 * `room.creatorUuid` grant a host session (`POST /api/host/claim`), which turns
 * unguarded adoption into impersonation: `POST /api/identity {legacyUuid: <a
 * creator's uuid>}` would mint a cookie for that creator and let the caller
 * claim their room. So adoption is refused for a uuid that ALREADY OWNS ROOMS
 * server-side (`listRooms`), and a fresh uuid is minted instead.
 *
 * Only the client-asserted branch is guarded — a cookie-presented uuid was set
 * by us and is never re-checked. Accepted cost: a device whose identity predates
 * the cookie, which created rooms and then lost the cookie, can no longer
 * re-adopt its uuid by asserting it; it falls back to the host code. That is the
 * safe side of an ambiguity an attacker impersonates. Note the affected device is
 * a POST-TICKET-26 one that created rooms and then lost its cookie while keeping
 * localStorage — a genuinely pre-cookie uuid owns no rooms (`addRoom` only began
 * at TICKET-26) and so cannot trigger the guard at all. The guard fires on one
 * other case too: a `listRooms` ERROR, which refuses adoption for everyone until
 * the index recovers — see `adoptable`, which keeps that case from destroying the
 * device's own uuid.
 */
export function createIdentityResolver(store: IdentityStore) {
  /**
   * Whether a CLIENT-ASSERTED uuid may be adopted.
   *
   *  - `"yes"`    — it owns no rooms, so adopting it cannot hand over a room.
   *  - `"owns"`   — it owns rooms: refuse, mint a fresh uuid instead.
   *  - `"unknown"`— the lookup itself failed, so we cannot tell.
   *
   * `"unknown"` is kept DISTINCT from `"owns"` on purpose (PR #81 review, NB-2).
   * Both must refuse adoption — fail-closed on the impersonation axis — but they
   * must fail differently: minting a substitute uuid on a transient rooms-index
   * error makes `PatronRoom.tsx` overwrite `cantai_patron_uuid` with it and
   * IRREVERSIBLY discard the device's real uuid, costing that patron their
   * own-row highlighting and pending-submissions view for good. On `"unknown"`
   * the caller therefore registers nothing and sets no cookie, so the client
   * keeps its own uuid and simply retries on the next load.
   */
  async function adoptable(uuid: string): Promise<"yes" | "owns" | "unknown"> {
    try {
      return (await store.listRooms(uuid)).length === 0 ? "yes" : "owns";
    } catch {
      return "unknown";
    }
  }

  return async function resolveIdentity(
    req: IdentityRequestLike,
    legacyUuid?: unknown,
  ): Promise<ResolvedIdentity> {
    const cookieUuid = req.cookies.get(IDENTITY_COOKIE)?.value;
    const asserted = isValidUuid(legacyUuid) ? legacyUuid : undefined;
    // The uuid the CLIENT already believes is its own — a server-set cookie
    // first, else the asserted legacy uuid. Used only for the fail-open return
    // below, never as the adoption decision.
    const clientKnown = isValidUuid(cookieUuid) ? cookieUuid : asserted;
    let candidate: string;
    if (isValidUuid(cookieUuid)) {
      candidate = cookieUuid;
    } else if (asserted) {
      const verdict = await adoptable(asserted);
      // Cannot establish ownership → register nothing, set no cookie, destroy
      // nothing. See `adoptable`'s `"unknown"` case.
      if (verdict === "unknown") return { uuid: asserted, ok: false };
      candidate = verdict === "yes" ? asserted : uuidv4();
    } else {
      candidate = uuidv4();
    }
    const userAgentClass = classifyUserAgent(req.headers.get("user-agent"));
    try {
      await store.touch(candidate, userAgentClass);
      return { uuid: candidate, ok: true };
    } catch {
      // Fail-open (acceptance #4): never throw, never block the caller's flow.
      // The client's own best-known uuid is returned so it keeps something
      // consistent locally even though nothing was persisted. Safe despite the
      // adoption guard above: `ok: false` means callers set NO identity cookie
      // and write NO `creatorUuid`, so an unverified uuid returned here can
      // never become a claim credential — it is a local-only echo.
      return { uuid: clientKnown ?? candidate, ok: false };
    }
  };
}

/** Production resolver, bound to the real durable `identityStore`. */
export const resolveIdentity = createIdentityResolver(identityStore);

/** Apply the identity cookie to a response. Only call when `ok` is true. */
export function applyIdentityCookie(res: NextResponse, uuid: string): void {
  res.cookies.set(IDENTITY_COOKIE, uuid, identityCookieOptions());
}
