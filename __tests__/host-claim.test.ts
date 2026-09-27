/**
 * Creator-claim unit tests (TICKET-104).
 *
 * `verifyCreatorClaim` is the authentication decision behind
 * `POST /api/host/claim` — the path that lets a room's CREATOR back into admin
 * without typing the shown-once host code. It is therefore tested as auth, not
 * as a convenience: every negative case below is a way in that must stay shut.
 *
 * Rooms are created through the real `createRoom` against the in-process memory
 * room backend, exactly as `__tests__/host-auth.test.ts` does.
 */
import {
  verifyCreatorClaim,
  isClaimThrottled,
  registerClaimFailure,
  resetClaimThrottle,
  isLoginThrottled,
  registerLoginFailure,
  _clearLoginThrottle,
  hostNoClaimCookieName,
  hasNoClaimMarker,
  noClaimCookieOptions,
  NO_CLAIM_MAX_AGE_SECONDS,
} from "@/lib/host-auth";
import { NextRequest } from "next/server";
import { POST as claimRoute } from "@/app/api/host/claim/route";
import { IDENTITY_COOKIE } from "@/lib/identity";
import { createRoom, hashHostCode, roomBackend, type Room } from "@/lib/rooms";

const CREATOR = "123e4567-e89b-42d3-a456-426614174000";
const OTHER = "223e4567-e89b-42d3-a456-426614174001";

async function mustCreateRoom(name: string, creatorUuid?: string) {
  const created = await createRoom(name, creatorUuid);
  if (!created) throw new Error("room ceiling hit in test");
  return created.room;
}

describe("verifyCreatorClaim — the creator's device gets in", () => {
  it("accepts the identity uuid that created the room", async () => {
    const room = await mustCreateRoom("claim yes", CREATOR);
    expect(await verifyCreatorClaim(room.id, CREATOR)).toBe(true);
  });
});

describe("verifyCreatorClaim — every other caller stays out", () => {
  it("rejects a DIFFERENT identity uuid (a patron who learned the room id)", async () => {
    const room = await mustCreateRoom("claim no", CREATOR);
    expect(await verifyCreatorClaim(room.id, OTHER)).toBe(false);
  });

  it("rejects a uuid that merely SHARES A PREFIX with the creator's", async () => {
    const room = await mustCreateRoom("claim prefix", CREATOR);
    // Same first 8 chars, different tail — a partial/truncated match must not pass.
    expect(await verifyCreatorClaim(room.id, CREATOR.slice(0, 8))).toBe(false);
    expect(
      await verifyCreatorClaim(room.id, `${CREATOR.slice(0, 30)}ffffff`),
    ).toBe(false);
  });

  it("rejects a room with NO creatorUuid on record, even when asked with an empty uuid", async () => {
    // Legacy rooms and rooms created while the identity store was down (creation
    // is fail-open) carry no creatorUuid. Two absences must never match.
    const room = await mustCreateRoom("claim legacy");
    expect(room.creatorUuid).toBeUndefined();
    expect(await verifyCreatorClaim(room.id, "")).toBe(false);
    expect(await verifyCreatorClaim(room.id, undefined)).toBe(false);
    expect(await verifyCreatorClaim(room.id, null)).toBe(false);
    expect(await verifyCreatorClaim(room.id, CREATOR)).toBe(false);
  });

  it("rejects a non-string uuid without throwing", async () => {
    const room = await mustCreateRoom("claim nonstring", CREATOR);
    expect(await verifyCreatorClaim(room.id, { toString: () => CREATOR })).toBe(false);
    expect(await verifyCreatorClaim(room.id, 42)).toBe(false);
  });

  it("rejects a room that does not exist", async () => {
    expect(await verifyCreatorClaim("no-such-room-xyz", CREATOR)).toBe(false);
  });

  it("rejects the legacy `default` room, which has no creator", async () => {
    expect(await verifyCreatorClaim("default", CREATOR)).toBe(false);
    expect(await verifyCreatorClaim("default", "")).toBe(false);
  });
});

/**
 * The two guards below cannot be reached through `createRoom`, which is exactly
 * why they are tested here against records written STRAIGHT to the backend:
 * `createRoom` refuses the id `default` (RESERVED_ROOM_IDS) and spreads
 * `creatorUuid` only when truthy, so both cases are unreachable today and a
 * mutation removing either guard survives a `createRoom`-only suite. They are
 * defence-in-depth against the next writer of room records, and defence that
 * nothing asserts is decoration.
 */
describe("verifyCreatorClaim — guards against a hand-written room record", () => {
  it("never claims the `default` room even if a record with a creator exists", async () => {
    await roomBackend.create({
      id: "default",
      name: "legacy",
      hostCodeHash: hashHostCode("whatever"),
      createdAt: new Date().toISOString(),
      settings: { mode: "full-karaoke" },
      creatorUuid: CREATOR,
    } as Room);
    // `default` is governed by the shared env HOST_TOKEN, not by a creator.
    expect(await verifyCreatorClaim("default", CREATOR)).toBe(false);
  });

  it("never matches a BLANK creatorUuid against a blank identity uuid", async () => {
    const id = "blank-creator-room";
    await roomBackend.create({
      id,
      name: "blank",
      hostCodeHash: hashHostCode("whatever"),
      createdAt: new Date().toISOString(),
      settings: { mode: "full-karaoke" },
      creatorUuid: "",
    } as Room);
    // Two absences must never authenticate each other.
    expect(await verifyCreatorClaim(id, "")).toBe(false);
  });
});

describe("no-claim marker — logout beats auto-claim", () => {
  function reqWithCookies(cookies: Record<string, string>): NextRequest {
    return {
      cookies: {
        get: (name: string) =>
          name in cookies ? { value: cookies[name] } : undefined,
      },
    } as unknown as NextRequest;
  }

  it("names the marker per room, so logging out of one room does not lock another", () => {
    expect(hostNoClaimCookieName("bar-do-ze")).toBe("boraoke_noclaim_bar-do-ze");
    expect(hostNoClaimCookieName("outro-bar")).not.toBe(
      hostNoClaimCookieName("bar-do-ze"),
    );
  });

  it("detects the marker only for the room it was set on", () => {
    const req = reqWithCookies({ [hostNoClaimCookieName("bar-do-ze")]: "1" });
    expect(hasNoClaimMarker(req, "bar-do-ze")).toBe(true);
    expect(hasNoClaimMarker(req, "outro-bar")).toBe(false);
  });

  it("is absent by default, and an empty value does not count as set", () => {
    expect(hasNoClaimMarker(reqWithCookies({}), "bar-do-ze")).toBe(false);
    expect(
      hasNoClaimMarker(reqWithCookies({ [hostNoClaimCookieName("bar-do-ze")]: "" }), "bar-do-ze"),
    ).toBe(false);
  });

  it("OUTLIVES the identity cookie it suppresses — otherwise logout expires back into auto-claim", () => {
    const identityMaxAge = 60 * 60 * 24 * 365 * 2; // lib/identity.ts
    expect(NO_CLAIM_MAX_AGE_SECONDS).toBeGreaterThan(identityMaxAge);
    const opts = noClaimCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.path).toBe("/api/host");
    expect(opts.maxAge).toBe(NO_CLAIM_MAX_AGE_SECONDS);
  });
});

describe("claim throttle — its OWN bucket, never the login one", () => {
  beforeEach(() => {
    _clearLoginThrottle();
  });

  // NOTE the deliberately SHARED key string in these three. Claim now buckets on
  // an identity uuid and login on an IP, so passing two different strings would
  // make the tests vacuous — they would pass with both namespaces collapsed into
  // one. Using the same string for both is what actually proves the key prefixes
  // differ (`hostclaim:` vs `login:`).
  const SHARED = "123e4567-e89b-42d3-a456-4266141740aa";

  it("spending the claim budget does NOT throttle the host-code login path", async () => {
    for (let i = 0; i < 10; i++) await registerClaimFailure(SHARED);
    expect(await isClaimThrottled(SHARED)).toBe(true);
    // The creator must still be able to fall back to typing the code.
    expect(await isLoginThrottled(SHARED)).toBe(false);
  });

  it("spending the login budget does not throttle claims", async () => {
    for (let i = 0; i < 10; i++) await registerLoginFailure(SHARED);
    expect(await isLoginThrottled(SHARED)).toBe(true);
    expect(await isClaimThrottled(SHARED)).toBe(false);
  });

  it("a successful claim resets its own bucket", async () => {
    for (let i = 0; i < 10; i++) await registerClaimFailure(SHARED);
    expect(await isClaimThrottled(SHARED)).toBe(true);
    await resetClaimThrottle(SHARED);
    expect(await isClaimThrottled(SHARED)).toBe(false);
  });
});

/**
 * B1 regression (PR #81 review) — the throttle must never be able to deny the
 * feature to the very person it exists for.
 *
 * As shipped, `POST /api/host/claim` charged a per-IP failure even with NO
 * identity cookie, and `AdminRoom` POSTs it on every session-less admin render.
 * So ten ordinary admin-URL opens from a venue's shared IP inside a minute 429'd
 * the CREATOR's own claim — and a 429 rendered as the code gate, i.e. exactly
 * the unrecoverable-code dead end this ticket removes. Measured, not theorised:
 * 3 failures in 7 full-suite runs as shipped.
 *
 * These are route-level tests (same style as `__tests__/host-api.test.ts`)
 * because the defect lived in the route's charging decision, not in the counter.
 */
describe("claim route — incidental traffic can never 429 the creator (B1)", () => {
  const VENUE_IP = "203.0.113.42";

  function claimReq(
    roomId: string,
    opts: { identity?: string; ip?: string } = {},
  ): NextRequest {
    const headers: Record<string, string> = {};
    if (opts.identity) headers.cookie = `${IDENTITY_COOKIE}=${opts.identity}`;
    headers["x-forwarded-for"] = opts.ip ?? VENUE_IP;
    return new NextRequest(
      `http://127.0.0.1:3040/api/host/claim?room=${encodeURIComponent(roomId)}`,
      { method: "POST", headers },
    );
  }

  beforeEach(() => {
    _clearLoginThrottle();
  });

  it("a flood of session-less renders from the venue IP does not block the creator", async () => {
    const room = await mustCreateRoom("bar venue nat", CREATOR);
    // 40 patrons/bookmarks open /<room>/admin with no identity cookie — four
    // times the failure ceiling, all from the one public IP the creator is on.
    for (let i = 0; i < 40; i++) {
      const res = await claimRoute(claimReq(room.id));
      expect(res.status).toBe(401); // no identity → nothing to claim with
    }
    // The creator, on that SAME IP, still gets in without typing anything.
    const res = await claimRoute(claimReq(room.id, { identity: CREATOR }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authed: true });
  });

  it("another DEVICE's failed claims do not block the creator, even on the same IP", async () => {
    const room = await mustCreateRoom("bar shared wifi", CREATOR);
    // A real device with its own identity, probing repeatedly.
    for (let i = 0; i < 20; i++) {
      await claimRoute(claimReq(room.id, { identity: OTHER }));
    }
    // That device is now bounded...
    expect(await isClaimThrottled(OTHER)).toBe(true);
    // ...and the creator's budget is untouched.
    expect(await isClaimThrottled(CREATOR)).toBe(false);
    expect((await claimRoute(claimReq(room.id, { identity: CREATOR }))).status).toBe(200);
  });

  it("a garbage identity cookie is not charged either, and cannot become a bucket key", async () => {
    const room = await mustCreateRoom("bar garbage cookie", CREATOR);
    for (let i = 0; i < 15; i++) {
      const res = await claimRoute(claimReq(room.id, { identity: "not-a-uuid" }));
      expect(res.status).toBe(401);
    }
    expect(await isClaimThrottled("not-a-uuid")).toBe(false);
    expect((await claimRoute(claimReq(room.id, { identity: CREATOR }))).status).toBe(200);
  });

  it("a genuinely exhausted identity gets 429 — DISTINGUISHABLE from a 401 rejection", async () => {
    const room = await mustCreateRoom("bar exhausted", CREATOR);
    for (let i = 0; i < 12; i++) {
      await claimRoute(claimReq(room.id, { identity: OTHER }));
    }
    const res = await claimRoute(claimReq(room.id, { identity: OTHER }));
    expect(res.status).toBe(429);
    // The client keys off this to say "wait a minute" instead of "wrong code".
    expect(await res.json()).toEqual({ authed: false, throttled: true });
  });

  it("a successful claim clears the claiming identity's own budget", async () => {
    const room = await mustCreateRoom("bar reset", CREATOR);
    // Creator fails against a room it does not own, spending some budget...
    const foreign = await mustCreateRoom("bar alheio", OTHER);
    for (let i = 0; i < 5; i++) {
      await claimRoute(claimReq(foreign.id, { identity: CREATOR }));
    }
    expect((await claimRoute(claimReq(room.id, { identity: CREATOR }))).status).toBe(200);
    expect(await isClaimThrottled(CREATOR)).toBe(false);
  });
});
