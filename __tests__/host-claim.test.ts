/**
 * Admin-claim unit tests (TICKET-104, rewritten after the PR #81 security gate).
 *
 * The claim is an AUTHENTICATION path, so it is tested as one: every negative
 * case below is a way in that must stay shut, and the first three describes exist
 * because the gate broke the previous design end-to-end in real browsers.
 *
 * The property that design got wrong, stated so these tests cannot drift from it:
 * the credential must be something **no page JS has ever seen**. Round 2 keyed the
 * claim on the identity uuid, which `POST /api/identity` echoes in a response body
 * and `cantai_patron_uuid` mirrors in localStorage — so it was exfiltrable with one
 * `fetch` and replayable from another browser, and the victim's logout could not
 * take it back. Hence a purpose-built token, hashed at rest, revocable in SERVER
 * state.
 *
 * Route-level (same style as `__tests__/host-api.test.ts`) wherever the property
 * lives in a route's decision rather than in a helper.
 */
import {
  isClaimThrottled,
  registerClaimFailure,
  resetClaimThrottle,
  isLoginThrottled,
  registerLoginFailure,
  _clearLoginThrottle,
  claimCookieName,
  claimCookieOptions,
  CLAIM_MAX_AGE_SECONDS,
  hostCookieName,
  issueSession,
} from "@/lib/host-auth";
import { NextRequest } from "next/server";
import { POST as claimRoute } from "@/app/api/host/claim/route";
import { POST as logoutRoute, GET as sessionRoute } from "@/app/api/host/session/route";
import { POST as loginRoute } from "@/app/api/host/login/route";
import { POST as roomsRoute } from "@/app/api/rooms/route";
import {
  createRoom,
  getPublicRoom,
  getRoom,
  hashClaimToken,
  issueRoomClaimToken,
  revokeRoomClaimTokens,
  verifyRoomClaimToken,
  roomBackend,
  MAX_CLAIM_TOKENS,
} from "@/lib/rooms";

const VENUE_IP = "203.0.113.42";

async function mustCreateRoom(name: string, creatorUuid?: string) {
  const created = await createRoom(name, creatorUuid);
  if (!created) throw new Error("room ceiling hit in test");
  return created;
}

/** A room plus a live claim token for it — the state a creator's device is in. */
async function roomWithClaim(name: string) {
  const { room, hostCode } = await mustCreateRoom(name);
  const token = await issueRoomClaimToken(room.id);
  if (!token) throw new Error("claim token not issued");
  return { room, hostCode, token };
}

function claimReq(
  roomId: string,
  opts: { token?: string; ip?: string; session?: string; extraCookies?: Record<string, string> } = {},
): NextRequest {
  const jar: Record<string, string> = { ...(opts.extraCookies ?? {}) };
  if (opts.token !== undefined) jar[claimCookieName(roomId)] = opts.token;
  if (opts.session) jar[hostCookieName(roomId)] = opts.session;
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? VENUE_IP };
  const cookie = Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  if (cookie) headers.cookie = cookie;
  return new NextRequest(
    `http://127.0.0.1:3040/api/host/claim?room=${encodeURIComponent(roomId)}`,
    { method: "POST", headers },
  );
}

/**
 * A logout request. `fetchSite` / `origin` model the request's PROVENANCE: the
 * real browser sends `Sec-Fetch-Site` (and, on any POST, `Origin`), and omitting
 * both — the default here — is what a non-browser client looks like.
 */
function logoutReq(
  roomId: string,
  opts: { session?: string; fetchSite?: string; origin?: string } = {},
): NextRequest {
  const headers: Record<string, string> = { host: "127.0.0.1:3040" };
  if (opts.session) headers.cookie = `${hostCookieName(roomId)}=${opts.session}`;
  if (opts.fetchSite) headers["sec-fetch-site"] = opts.fetchSite;
  if (opts.origin) headers.origin = opts.origin;
  return new NextRequest(
    `http://127.0.0.1:3040/api/host/session?room=${encodeURIComponent(roomId)}`,
    { method: "POST", headers },
  );
}

/** Read a Set-Cookie value for `name` off a route response. */
function setCookie(res: Response, name: string): string | undefined {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const [k, ...rest] = pair.split("=");
    if (k.trim() === name) return rest.join("=");
  }
  return undefined;
}

beforeEach(() => {
  _clearLoginThrottle();
});

describe("the claim credential is NEVER handed to a client (B-S1)", () => {
  it("room creation sets the token in an httpOnly cookie and puts it in NO response body", async () => {
    const res = await roomsRoute(
      new NextRequest("http://127.0.0.1:3040/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.1" },
        body: JSON.stringify({ name: "Bar Segredo" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    const token = setCookie(res, claimCookieName(body.id));
    expect(token).toBeTruthy();

    // THE property: the raw token appears nowhere a client can read it.
    expect(JSON.stringify(body)).not.toContain(token!);
    expect(Object.values(body)).not.toContain(token);
    // The window the device actually receives, asserted on the ROUTE's output
    // rather than on `claimCookieOptions()`. Testing the options object only
    // proves the constant is right; it says nothing about what this route put on
    // the wire, and a first issue with a short window would silently break
    // re-entry for every creator. Found by a mis-aimed mutant that set a
    // 1-minute Max-Age here and passed the whole suite.
    expect(res.cookies.get(claimCookieName(body.id))?.maxAge).toBe(CLAIM_MAX_AGE_SECONDS);
    // And the cookie carrying it is httpOnly + path-scoped.
    const raw = (res.headers.getSetCookie?.() ?? []).find((c) =>
      c.startsWith(`${claimCookieName(body.id)}=`),
    )!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Path=\/api\/host/i);
  });

  it("the token is NOT the creatorUuid, and the creatorUuid cannot be replayed as one", async () => {
    // The whole point of the redesign: knowing the identity uuid (which page JS
    // can read, via the /api/identity echo and the cantai_patron_uuid mirror)
    // must buy nothing at all.
    const CREATOR = "123e4567-e89b-42d3-a456-426614174000";
    const { room } = await mustCreateRoom("Bar Rotulo", CREATOR);
    const token = await issueRoomClaimToken(room.id);
    expect(token).not.toBe(CREATOR);
    expect(await verifyRoomClaimToken(room.id, CREATOR)).toBe(false);
    expect((await claimRoute(claimReq(room.id, { token: CREATOR }))).status).toBe(401);
    // ...while the real token works, so the negative above is not vacuous.
    expect((await claimRoute(claimReq(room.id, { token: token! }))).status).toBe(200);
  });

  it("the room record stores only HASHES, and never exposes them publicly", async () => {
    const { room, token } = await roomWithClaim("Bar Hash");
    const stored = (await getRoom(room.id))!.claimTokenHashes!;
    expect(stored).toEqual([hashClaimToken(token)]);
    expect(stored).not.toContain(token);
    const pub = await getPublicRoom(room.id);
    expect(pub).not.toHaveProperty("claimTokenHashes");
    expect(JSON.stringify(pub)).not.toContain(token);
  });
});

/**
 * The capped list is what lets a venue hold the credential on the bar tablet AND
 * the owner's phone. That property was asserted in the design notes and was FALSE
 * as first implemented: every roll appended, so the cap evicted other devices
 * instead of protecting them. These tests pin the property the cap is supposed to
 * have, on the route rather than on the helper, because the bug lived in which
 * helper the route called.
 */
describe("the capped list holds DEVICES, so one device's re-entry never evicts another", () => {
  it("a phone re-entering many times does not push the bar tablet's credential off", async () => {
    // Exactly TWO devices, so the length assertion below is a real count and not a
    // guess: the room's own first token is the tablet, and the phone is the second.
    const { room, token: tablet } = await roomWithClaim("Bar Duas Telas");
    let phone = (await issueRoomClaimToken(room.id))!;

    // The phone re-enters more times than the list can hold. Each claim rolls its
    // own credential, so it must reuse its own slot rather than take a new one.
    for (let i = 0; i < MAX_CLAIM_TOKENS + 2; i++) {
      const res = await claimRoute(claimReq(room.id, { token: phone }));
      expect(res.status).toBe(200);
      phone = setCookie(res, claimCookieName(room.id))!;
      expect(phone).toBeTruthy();
    }

    expect(await verifyRoomClaimToken(room.id, phone)).toBe(true);
    expect(await verifyRoomClaimToken(room.id, tablet)).toBe(true);
    // Two devices, two entries — the phone's rolls left no debris behind.
    expect((await getRoom(room.id))!.claimTokenHashes).toHaveLength(2);
  });

  it("CONCURRENT re-entries on one device both leave it with a working credential", async () => {
    // The defect this replaces a test for, and the reason the roll no longer
    // mints. A double-mounted effect, two tabs, or SavedRooms racing AdminRoom
    // sends two claims at once carrying the SAME cookie. When the roll minted and
    // replaced, both deleted the presented hash and one of the two new tokens was
    // already dead by the time its response reached the browser — measured
    // directly as `aLives=false bLives=true t1Lives=false`, i.e. a device locked
    // out by its own successful re-entry. Whichever response the browser keeps
    // must work, so all three values are asserted live.
    const { room, token } = await roomWithClaim("Bar Corrida");
    const [a, b] = await Promise.all([
      claimRoute(claimReq(room.id, { token })),
      claimRoute(claimReq(room.id, { token })),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const av = a.cookies.get(claimCookieName(room.id))?.value;
    const bv = b.cookies.get(claimCookieName(room.id))?.value;
    expect(await verifyRoomClaimToken(room.id, av!)).toBe(true);
    expect(await verifyRoomClaimToken(room.id, bv!)).toBe(true);
    expect(await verifyRoomClaimToken(room.id, token)).toBe(true);
  });

  it("the SESSION PROBE's roll does not evict another device either", async () => {
    // This covers the second roll site, and it is not redundant with the claim-route
    // test above: a mutation that regressed ONLY the probe to appending survived the
    // whole suite when this test did not exist (R3, a SURVIVED-real-gap). The probe
    // is also the roll site that fires most — every admin page load and every
    // landing-page SavedRooms check — so it is the one that would actually evict a
    // venue's tablet in production.
    const { room, token: tablet } = await roomWithClaim("Bar Probe Duas Telas");
    let phone = (await issueRoomClaimToken(room.id))!;
    const session = (await issueSession(room.id))!;

    for (let i = 0; i < MAX_CLAIM_TOKENS + 2; i++) {
      const res = await sessionRoute(
        new NextRequest(`http://127.0.0.1:3040/api/host/session?room=${room.id}`, {
          headers: {
            cookie: `${hostCookieName(room.id)}=${session}; ${claimCookieName(room.id)}=${phone}`,
          },
        }),
      );
      expect(res.status).toBe(200);
      phone = setCookie(res, claimCookieName(room.id))!;
      expect(phone).toBeTruthy();
    }

    expect(await verifyRoomClaimToken(room.id, phone)).toBe(true);
    expect(await verifyRoomClaimToken(room.id, tablet)).toBe(true);
    expect((await getRoom(room.id))!.claimTokenHashes).toHaveLength(2);
  });

  it("MORE devices than the cap still evicts the oldest — the cap is real", async () => {
    // The cap must still bind; the fix narrows what counts against it, it does not
    // remove it. Otherwise a room accumulates standing credentials without bound.
    const { room } = await roomWithClaim("Bar Muitos Aparelhos");
    const first = (await issueRoomClaimToken(room.id))!;
    for (let i = 0; i < MAX_CLAIM_TOKENS; i++) {
      await issueRoomClaimToken(room.id); // each one a DIFFERENT new device
    }
    expect(await verifyRoomClaimToken(room.id, first)).toBe(false);
    expect((await getRoom(room.id))!.claimTokenHashes).toHaveLength(MAX_CLAIM_TOKENS);
  });
});

describe("logout REVOKES the credential in server state (B-S1, direction 2)", () => {
  it("a token COPIED off the device stops working once the owner logs out", async () => {
    const { room, token } = await roomWithClaim("Bar Revogado");
    const stolen = token; // the attacker's copy, taken before logout
    expect((await claimRoute(claimReq(room.id, { token: stolen }))).status).toBe(200);

    const session = (await issueSession(room.id))!;
    expect((await logoutRoute(logoutReq(room.id, { session }))).status).toBe(200);

    // The copy is dead for the attacker too — which a marker in the victim's own
    // cookie jar could never achieve.
    expect((await claimRoute(claimReq(room.id, { token: stolen }))).status).toBe(401);
    expect((await getRoom(room.id))!.claimTokenHashes).toBeUndefined();
  });

  it("entering the host code after a logout mints a FRESH token, not the revoked one", async () => {
    const { room, hostCode, token } = await roomWithClaim("Bar Volta");
    const session = (await issueSession(room.id))!;
    await logoutRoute(logoutReq(room.id, { session }));

    const res = await loginRoute(
      new NextRequest(`http://127.0.0.1:3040/api/host/login?room=${room.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.2" },
        body: JSON.stringify({ token: hostCode }),
      }),
    );
    expect(res.status).toBe(200);
    const fresh = setCookie(res, claimCookieName(room.id));
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(token); // a revoked credential stays dead
    expect((await claimRoute(claimReq(room.id, { token: fresh! }))).status).toBe(200);
    expect((await claimRoute(claimReq(room.id, { token }))).status).toBe(401);
  });

  it("holds the credential for several devices, capped, and logout clears them ALL", async () => {
    const { room } = await mustCreateRoom("Bar Multi");
    const tokens: string[] = [];
    for (let i = 0; i < MAX_CLAIM_TOKENS + 2; i++) {
      tokens.push((await issueRoomClaimToken(room.id))!);
    }
    // The newest MAX_CLAIM_TOKENS are live; the oldest fell off.
    for (const live of tokens.slice(-MAX_CLAIM_TOKENS)) {
      expect(await verifyRoomClaimToken(room.id, live)).toBe(true);
    }
    for (const dead of tokens.slice(0, 2)) {
      expect(await verifyRoomClaimToken(room.id, dead)).toBe(false);
    }
    await revokeRoomClaimTokens(room.id);
    for (const t of tokens) {
      expect(await verifyRoomClaimToken(room.id, t)).toBe(false);
    }
  });
});

describe("logout is AUTHENTICATED, so nobody can lock the owner out (B-S2)", () => {
  it("a cookie-less POST to logout changes NOTHING — no revocation, no cookie", async () => {
    const { room, token } = await roomWithClaim("Bar Csrf");
    const res = await logoutRoute(logoutReq(room.id));
    expect(res.status).toBe(401);
    // Nothing was planted and nothing was revoked...
    expect(res.headers.getSetCookie?.() ?? []).toEqual([]);
    expect((await getRoom(room.id))!.claimTokenHashes).toHaveLength(1);
    // ...so the owner's no-typing re-entry still works.
    expect((await claimRoute(claimReq(room.id, { token }))).status).toBe(200);
  });

  it("a WRONG session value cannot log the room out either", async () => {
    const { room, token } = await roomWithClaim("Bar Sessao Falsa");
    const res = await logoutRoute(logoutReq(room.id, { session: "f".repeat(64) }));
    expect(res.status).toBe(401);
    expect((await claimRoute(claimReq(room.id, { token }))).status).toBe(200);
  });

  /**
   * The second layer. These are NOT redundant with the three tests above, and the
   * distinction is the whole reason they exist: those pass a caller with no valid
   * session, so `requireHost` alone refuses them and they would stay green if the
   * provenance check were deleted. These hand the route a session that IS valid
   * and refuse it on provenance alone — so only the provenance check can make them
   * pass, which is what makes them a test of it rather than of `requireHost`.
   */
  it("a valid session presented from ANOTHER SITE cannot log the room out", async () => {
    const { room, token } = await roomWithClaim("Bar Sec Fetch");
    const session = (await issueSession(room.id))!;
    const res = await logoutRoute(
      logoutReq(room.id, { session, fetchSite: "cross-site" }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie?.() ?? []).toEqual([]);
    // Nothing revoked, so the owner's no-typing re-entry is untouched.
    expect((await getRoom(room.id))!.claimTokenHashes).toHaveLength(1);
    expect((await claimRoute(claimReq(room.id, { token }))).status).toBe(200);
  });

  it("a valid session with a FOREIGN Origin cannot log the room out either", async () => {
    // The fallback path, for a client that sends Origin but no Sec-Fetch-Site.
    const { room, token } = await roomWithClaim("Bar Origem Estranha");
    const session = (await issueSession(room.id))!;
    const res = await logoutRoute(
      logoutReq(room.id, { session, origin: "http://evil.test" }),
    );
    expect(res.status).toBe(401);
    expect((await getRoom(room.id))!.claimTokenHashes).toHaveLength(1);
    expect((await claimRoute(claimReq(room.id, { token }))).status).toBe(200);
  });

  it("the owner's OWN same-origin logout still works — the shared-tablet path", async () => {
    // The check must refuse the attack without costing the feature its point: a
    // venue tablet has to be able to hand the room back. This is what `AdminRoom`
    // actually sends (a same-origin fetch, so both headers are present).
    const { room, token } = await roomWithClaim("Bar Mesma Origem");
    const session = (await issueSession(room.id))!;
    const res = await logoutRoute(
      logoutReq(room.id, {
        session,
        fetchSite: "same-origin",
        origin: "http://127.0.0.1:3040",
      }),
    );
    expect(res.status).toBe(200);
    // ...and it really logged out: revoked in SERVER state, so the copy dies too.
    expect((await getRoom(room.id))!.claimTokenHashes).toBeUndefined();
    expect((await claimRoute(claimReq(room.id, { token }))).status).toBe(401);
  });

  it("is not a room-existence oracle — a real room and a made-up one reply identically", async () => {
    const { room } = await roomWithClaim("Bar Existe");
    const real = await logoutRoute(logoutReq(room.id));
    const fake = await logoutRoute(logoutReq("bar-nao-existe-de-jeito-nenhum"));
    expect(real.status).toBe(fake.status);
    expect(await real.json()).toEqual(await fake.json());
    expect(real.headers.getSetCookie?.() ?? []).toEqual(
      fake.headers.getSetCookie?.() ?? [],
    );
  });

  it("another room's valid session cannot log THIS room out", async () => {
    const { room, token } = await roomWithClaim("Bar Alvo");
    const other = await roomWithClaim("Bar Vizinho");
    const otherSession = (await issueSession(other.room.id))!;
    const res = await logoutRoute(
      new NextRequest(`http://127.0.0.1:3040/api/host/session?room=${room.id}`, {
        method: "POST",
        headers: { cookie: `${hostCookieName(other.room.id)}=${otherSession}` },
      }),
    );
    expect(res.status).toBe(401);
    expect((await claimRoute(claimReq(room.id, { token }))).status).toBe(200);
  });
});

describe("claim — every caller without a live token stays out", () => {
  it("no claim cookie at all", async () => {
    const { room } = await roomWithClaim("Bar Sem Cookie");
    expect((await claimRoute(claimReq(room.id))).status).toBe(401);
  });

  it("a wrong token, an empty token, and another room's token", async () => {
    const { room } = await roomWithClaim("Bar Token Errado");
    const other = await roomWithClaim("Bar Outro Token");
    expect((await claimRoute(claimReq(room.id, { token: "nope" }))).status).toBe(401);
    expect((await claimRoute(claimReq(room.id, { token: "" }))).status).toBe(401);
    expect((await claimRoute(claimReq(room.id, { token: other.token }))).status).toBe(401);
  });

  it("an EMPTY hash list matches nothing — asserted against a hand-written record", async () => {
    // Unreachable through the app today (`revokeRoomClaimTokens` deletes the key
    // rather than emptying it, and creation never writes `[]`), which is exactly
    // why it needs asserting: a mutation that treats an empty list as a match
    // survived a suite that only ever saw the key ABSENT, and that mutation makes
    // every legacy room claimable by anyone. Written straight to the backend, the
    // same technique the `default`/blank-creator guards needed.
    const { room } = await mustCreateRoom("Bar Lista Vazia");
    const rec = (await getRoom(room.id))!;
    await roomBackend.update({ ...rec, claimTokenHashes: [] });
    expect(await verifyRoomClaimToken(room.id, "anything")).toBe(false);
    expect(await verifyRoomClaimToken(room.id, "")).toBe(false);
    expect((await claimRoute(claimReq(room.id, { token: "anything" }))).status).toBe(401);
  });

  it("a room with NO claim tokens on record is not claimable (legacy rooms)", async () => {
    const { room } = await mustCreateRoom("Bar Legado");
    expect((await getRoom(room.id))!.claimTokenHashes).toBeUndefined();
    expect((await claimRoute(claimReq(room.id, { token: "anything" }))).status).toBe(401);
    expect(await verifyRoomClaimToken(room.id, "")).toBe(false);
  });

  it("the legacy `default` room is never claimable", async () => {
    const req = new NextRequest("http://127.0.0.1:3040/api/host/claim?room=default", {
      method: "POST",
      headers: { cookie: `${claimCookieName("default")}=whatever` },
    });
    expect((await claimRoute(req)).status).toBe(401);
  });

  it("a non-existent room is not claimable", async () => {
    const req = claimReq("no-such-room-xyz", { token: "anything" });
    expect((await claimRoute(req)).status).toBe(401);
  });
});

describe("claim cookie shape — bounded and rolling, not a lifetime comparison (O3)", () => {
  it("is httpOnly, host-path-scoped, and bounded well inside the browser's 400-day cap", async () => {
    const opts = claimCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.path).toBe("/api/host");
    expect(opts.maxAge).toBe(CLAIM_MAX_AGE_SECONDS);
    // The old design needed 3 years to outlive another cookie, which a real
    // browser silently capped at 400 days. Correctness no longer depends on that
    // comparison at all — revocation is server state — so this is simply bounded.
    const DAYS = 60 * 60 * 24;
    expect(CLAIM_MAX_AGE_SECONDS).toBeLessThan(400 * DAYS);
  });

  it("a successful claim EXTENDS the credential's window, so an active venue never ages out", async () => {
    // RE-POINTED (round 4). This used to assert `rolled !== token`, i.e. that the
    // roll minted a NEW value. That is no longer the mechanism — and the old
    // assertion would now be actively wrong rather than merely vacuous, so it
    // could not just be left alone. Minting on a roll was tried and reverted: it
    // evicted other devices, and replacing-on-roll then raced. What the roll must
    // do is EXTEND, so that is what this asserts: the cookie comes back with the
    // full Max-Age, carrying the value the caller already had, still usable.
    const { room, token } = await roomWithClaim("Bar Rolando");
    const res = await claimRoute(claimReq(room.id, { token }));
    expect(res.status).toBe(200);
    const cookie = res.cookies.get(claimCookieName(room.id));
    expect(cookie?.value).toBe(token);
    expect(cookie?.maxAge).toBe(CLAIM_MAX_AGE_SECONDS);
    expect((await claimRoute(claimReq(room.id, { token }))).status).toBe(200);
  });

  it("the session probe rolls it too, but only for a caller that ALREADY holds one", async () => {
    const { room, token } = await roomWithClaim("Bar Probe");
    const session = (await issueSession(room.id))!;
    const withToken = await sessionRoute(
      new NextRequest(`http://127.0.0.1:3040/api/host/session?room=${room.id}`, {
        headers: { cookie: `${hostCookieName(room.id)}=${session}; ${claimCookieName(room.id)}=${token}` },
      }),
    );
    expect(setCookie(withToken, claimCookieName(room.id))).toBeTruthy();

    // A host session alone must never MINT claim authority — only extend proven authority.
    const { room: room2 } = await roomWithClaim("Bar Probe Dois");
    const session2 = (await issueSession(room2.id))!;
    const withoutToken = await sessionRoute(
      new NextRequest(`http://127.0.0.1:3040/api/host/session?room=${room2.id}`, {
        headers: { cookie: `${hostCookieName(room2.id)}=${session2}` },
      }),
    );
    expect(setCookie(withoutToken, claimCookieName(room2.id))).toBeUndefined();
  });
});

describe("claim throttle — its OWN bucket, never the login one", () => {
  // NOTE the deliberately SHARED key string. Both buckets key on the client IP
  // now, so passing two different strings would make these vacuous — they would
  // pass with both namespaces collapsed into one. The same string is what proves
  // the key prefixes differ (`hostclaim:` vs `login:`).
  const SHARED = "203.0.113.77";

  it("spending the claim budget does NOT throttle the host-code login path", async () => {
    for (let i = 0; i < 10; i++) await registerClaimFailure(SHARED);
    expect(await isClaimThrottled(SHARED)).toBe(true);
    // The creator must always be able to fall back to typing the code.
    expect(await isLoginThrottled(SHARED)).toBe(false);
  });

  it("spending the login budget does not throttle claims", async () => {
    for (let i = 0; i < 10; i++) await registerLoginFailure(SHARED);
    expect(await isLoginThrottled(SHARED)).toBe(true);
    expect(await isClaimThrottled(SHARED)).toBe(false);
  });

  it("a successful claim resets the bucket", async () => {
    for (let i = 0; i < 10; i++) await registerClaimFailure(SHARED);
    expect(await isClaimThrottled(SHARED)).toBe(true);
    await resetClaimThrottle(SHARED);
    expect(await isClaimThrottled(SHARED)).toBe(false);
  });
});

/**
 * B1 regression, carried forward through the credential redesign.
 *
 * The original defect: the route charged a per-IP failure even with no credential
 * presented, and `AdminRoom` claims on every session-less admin render — so
 * ordinary admin-URL opens from a venue's shared wifi 429'd the CREATOR's own
 * claim, and a 429 rendered as the code gate. Measured then: 3 failing runs of 5.
 *
 * Round 2 fixed it by re-keying onto the caller's identity, which the security
 * gate then showed hands an unauthenticated caller unbounded CLIENT-CHOSEN bucket
 * keys (evicting the login throttle from the shared LRU). So the property is now
 * held by a different and stronger mechanism: verification happens FIRST and a
 * valid credential is never subject to the budget at all, while the key is
 * server-derived. These tests pin BOTH halves.
 */
describe("the throttle can never deny a legitimate creator (B1) and its key is server-derived (O1)", () => {
  it("a flood of session-less renders from the venue IP does not block the creator", async () => {
    const { room, token } = await roomWithClaim("bar venue nat");
    // 40 patrons/bookmarks open /<room>/admin with no claim cookie — four times
    // the failure ceiling, all from the one public IP the creator is on.
    for (let i = 0; i < 40; i++) {
      expect((await claimRoute(claimReq(room.id))).status).toBe(401);
    }
    expect((await claimRoute(claimReq(room.id, { token }))).status).toBe(200);
  });

  it("a SPENT budget on the creator's own IP still lets a valid token through", async () => {
    // The strongest form of the property, and the one round 2 could not state:
    // even with the bucket fully spent — by anyone, on this very IP — a live
    // credential wins, because it is verified before the budget is consulted.
    const { room, token } = await roomWithClaim("bar orcamento gasto");
    for (let i = 0; i < 25; i++) {
      await claimRoute(claimReq(room.id, { token: "wrong-token" }));
    }
    expect(await isClaimThrottled(VENUE_IP)).toBe(true);
    expect((await claimRoute(claimReq(room.id, { token }))).status).toBe(200);
    // And a successful claim clears the bucket it never had to satisfy.
    expect(await isClaimThrottled(VENUE_IP)).toBe(false);
  });

  it("invented tokens cannot create unbounded bucket keys — the key is the IP (O1)", async () => {
    // Round 2's keyspace was client-chosen, so 1100 rotating values evicted the
    // login bucket from the shared process-wide LRU and reset the host-code
    // brute-force control. Rotating the credential now changes no key at all.
    const { room } = await roomWithClaim("bar chaves");
    const before = await isLoginThrottled(VENUE_IP);
    for (let i = 0; i < 30; i++) {
      await claimRoute(claimReq(room.id, { token: `invented-${i}` }));
    }
    // One bucket, not thirty: the IP's. Proven by it being throttled at all.
    expect(await isClaimThrottled(VENUE_IP)).toBe(true);
    expect(await isLoginThrottled(VENUE_IP)).toBe(before);
  });

  it("a genuinely exhausted IP gets 429 — DISTINGUISHABLE from a 401 rejection", async () => {
    const { room } = await roomWithClaim("bar exausto");
    for (let i = 0; i < 12; i++) {
      await claimRoute(claimReq(room.id, { token: "wrong" }));
    }
    const res = await claimRoute(claimReq(room.id, { token: "wrong" }));
    expect(res.status).toBe(429);
    // The client keys off this to say "wait a minute" instead of "wrong code".
    expect(await res.json()).toEqual({ authed: false, throttled: true });
  });

  it("a caller with NO credential is never charged, so patrons cost nothing", async () => {
    const { room } = await roomWithClaim("bar gratis");
    for (let i = 0; i < 30; i++) {
      await claimRoute(claimReq(room.id, { ip: "198.51.100.30" }));
    }
    expect(await isClaimThrottled("198.51.100.30")).toBe(false);
  });
});
