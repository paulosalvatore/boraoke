/**
 * TICKET-118 — host-session REVOCATION.
 *
 * WHAT THIS SUITE MUST PROVE, AND THE HOLLOW SHAPE IT MUST NOT TAKE. The defect
 * is that a host session, once minted, could never be ended: `sessionValue` was
 * a pure HMAC over the immutable `hostCodeHash`, so two logins returned the
 * byte-identical value and nothing anywhere could invalidate one. The TICKET-104
 * re-gate measured an attacker's already-minted session still moderating after
 * the owner's logout, and rolling itself a fresh 30-day cookie on every probe.
 *
 * So the load-bearing test is: mint a session, revoke, and prove **that same old
 * session value** stops working. Two hollow shapes are deliberately avoided, and
 * both would have passed against the pre-fix code:
 *
 *   1. Asserting only that the NEW session works. True before the fix too.
 *   2. Asserting that a stolen CLAIM TOKEN stops working. Also true before the
 *      fix — `revokeRoomClaimTokens` has shipped since TICKET-104, so a suite
 *      that routes its "attacker" through the claim route is measuring the
 *      feature that already worked, not this one. Every revocation assertion
 *      below therefore uses a session value obtained DIRECTLY from
 *      `issueSession`, with no claim token in play, so claim revocation cannot
 *      carry the test.
 */
import {
  _clearLoginThrottle,
  claimCookieName,
  hostCookieName,
  issueSession,
  resolveRoomSecret,
  verifySessionValue,
} from "@/lib/host-auth";
import { NextRequest } from "next/server";
import { createHmac } from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { POST as revokeRoute } from "@/app/api/host/revoke-sessions/route";
import { POST as claimRoute } from "@/app/api/host/claim/route";
import { GET as sessionProbe, POST as logoutRoute } from "@/app/api/host/session/route";
import { POST as loginRoute } from "@/app/api/host/login/route";
import { POST as moderationRoute } from "@/app/api/host/moderation/route";
import {
  DEFAULT_ROOM,
  createRoom,
  getPublicRoom,
  getRoom,
  getRoomSessionEpoch,
  issueRoomClaimToken,
  normaliseSessionEpoch,
  revokeRoomHostSessions,
  roomBackend,
  revokeRoomClaimToken,
  setRoomLanguage,
  setRoomMode,
  setRoomModeration,
  verifyRoomClaimToken,
} from "@/lib/rooms";

const VENUE_IP = "203.0.113.118";

async function mustCreateRoom(name: string) {
  const created = await createRoom(name);
  if (!created) throw new Error("room ceiling hit in test");
  return created;
}

/**
 * A room, the OWNER's live claim token for it (pinned, as room creation does —
 * TICKET-120), and a live host session: the owner's device, the only one that may
 * sign out other devices (S3).
 */
async function venue(name: string) {
  const { room, hostCode } = await mustCreateRoom(name);
  const token = await issueRoomClaimToken(room.id, { owner: true });
  if (!token) throw new Error("claim token not issued");
  const session = await issueSession(room.id);
  if (!session) throw new Error("session not issued");
  return { room, hostCode, token, session };
}

/** A same-origin `POST /api/host/revoke-sessions` — the shape `AdminRoom` sends. */
function revokeReq(
  roomId: string,
  opts: { session?: string; claimToken?: string; fetchSite?: string; origin?: string } = {},
): NextRequest {
  const headers: Record<string, string> = { host: "127.0.0.1:3040" };
  const jar: string[] = [];
  if (opts.session) jar.push(`${hostCookieName(roomId)}=${opts.session}`);
  if (opts.claimToken) jar.push(`${claimCookieName(roomId)}=${opts.claimToken}`);
  if (jar.length) headers.cookie = jar.join("; ");
  if (opts.fetchSite) headers["sec-fetch-site"] = opts.fetchSite;
  if (opts.origin) headers.origin = opts.origin;
  return new NextRequest(
    `http://127.0.0.1:3040/api/host/revoke-sessions?room=${encodeURIComponent(roomId)}`,
    { method: "POST", headers },
  );
}

/** A host-authority request to a REAL state-changing host route. */
function moderationReq(roomId: string, session: string | undefined, on = true): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (session) headers.cookie = `${hostCookieName(roomId)}=${session}`;
  return new NextRequest(
    `http://127.0.0.1:3040/api/host/moderation?room=${encodeURIComponent(roomId)}`,
    { method: "POST", headers, body: JSON.stringify({ moderation: on }) },
  );
}

function probeReq(roomId: string, session?: string, claimToken?: string): NextRequest {
  const jar: string[] = [];
  if (session) jar.push(`${hostCookieName(roomId)}=${session}`);
  if (claimToken) jar.push(`${claimCookieName(roomId)}=${claimToken}`);
  const headers: Record<string, string> = {};
  if (jar.length) headers.cookie = jar.join("; ");
  return new NextRequest(
    `http://127.0.0.1:3040/api/host/session?room=${encodeURIComponent(roomId)}`,
    { headers },
  );
}

function claimReq(roomId: string, token?: string): NextRequest {
  const headers: Record<string, string> = { "x-forwarded-for": VENUE_IP };
  if (token !== undefined) headers.cookie = `${claimCookieName(roomId)}=${token}`;
  return new NextRequest(
    `http://127.0.0.1:3040/api/host/claim?room=${encodeURIComponent(roomId)}`,
    { method: "POST", headers },
  );
}

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

// ─────────────────────────────────────────────────────────────────────────────
describe("an ALREADY-MINTED session stops working after the owner signs out all devices", () => {
  it("the OLD session value is dead — on a real host route, not just a helper", async () => {
    const v = await venue("Bar Revogacao");
    // The attacker's copy, taken while it was valid. No claim token involved, so
    // claim revocation cannot be what kills it.
    const stolen = v.session;

    // POSITIVE CONTROL — the harness can detect success. Without this, a broken
    // harness and a passing security test are the same output.
    expect((await moderationRoute(moderationReq(v.room.id, stolen))).status).toBe(200);

    const res = await revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token }));
    expect(res.status).toBe(200);

    // THE ASSERTION THIS TICKET EXISTS FOR.
    expect(await verifySessionValue(v.room.id, stolen)).toBe(false);
    expect((await moderationRoute(moderationReq(v.room.id, stolen))).status).toBe(401);
  });

  it("the old session can no longer ROLL ITSELF a fresh cookie — the re-gate's exact finding", async () => {
    const v = await venue("Bar Rolagem");
    const stolen = v.session;
    // Control: before the revoke the probe both authenticates AND re-issues.
    const before = await sessionProbe(probeReq(v.room.id, stolen));
    expect(before.status).toBe(200);
    expect(setCookie(before, hostCookieName(v.room.id))).toBe(stolen);

    await revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token }));

    const after = await sessionProbe(probeReq(v.room.id, stolen));
    expect(after.status).toBe(401);
    // And it mints/extends NOTHING on the way out.
    expect(after.headers.getSetCookie?.() ?? []).toEqual([]);
  });

  it("a session copied by a SECOND device dies while the acting device keeps working", async () => {
    const v = await venue("Bar Dois Aparelhos");
    const otherDevice = v.session; // byte-identical copy, which is the whole defect
    expect((await moderationRoute(moderationReq(v.room.id, otherDevice))).status).toBe(200);

    const res = await revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token }));
    const fresh = setCookie(res, hostCookieName(v.room.id));

    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(otherDevice); // the lever actually rotated something
    expect((await moderationRoute(moderationReq(v.room.id, otherDevice))).status).toBe(401);
    expect((await moderationRoute(moderationReq(v.room.id, fresh))).status).toBe(200);
  });

  it("a stolen CLAIM token cannot mint a replacement session either", async () => {
    // Both halves are needed: the claim route converts a claim token into a
    // session, so revoking sessions without revoking claims revokes nothing.
    const v = await venue("Bar Reivindica");
    const stolenClaim = v.token;
    const attackerToken = (await issueRoomClaimToken(v.room.id))!; // a second device's
    expect((await claimRoute(claimReq(v.room.id, attackerToken))).status).toBe(200);

    await revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: stolenClaim }));

    expect((await claimRoute(claimReq(v.room.id, attackerToken))).status).toBe(401);
    expect(await verifyRoomClaimToken(v.room.id, attackerToken)).toBe(false);
  });

  it("successive revokes keep killing — epoch N, N+1 and N+2 sessions are all dead at N+3", async () => {
    const v = await venue("Bar Monotonico");
    const seen: string[] = [v.session];
    let session = v.session;
    let claim: string | undefined = v.token;
    for (let i = 0; i < 3; i++) {
      const res = await revokeRoute(revokeReq(v.room.id, { session, claimToken: claim }));
      expect(res.status).toBe(200);
      session = setCookie(res, hostCookieName(v.room.id))!;
      claim = setCookie(res, claimCookieName(v.room.id)) ?? claim;
      seen.push(session);
    }
    expect(await getRoomSessionEpoch(v.room.id)).toBe(3);
    expect(new Set(seen).size).toBe(seen.length); // every epoch's value is distinct
    for (const dead of seen.slice(0, -1)) {
      expect(await verifySessionValue(v.room.id, dead)).toBe(false);
    }
    expect(await verifySessionValue(v.room.id, session)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the acting device is never locked out by its own successful use of the lever", () => {
  it("its claim token SURVIVES, so it needs nothing from the response to get back in", async () => {
    // This is the anti-lockout property. If the response were lost to a network
    // drop after the write commits, the next admin mount auto-claims with this
    // surviving token and gets a session at the new epoch.
    const v = await venue("Bar Sem Travar");
    await revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token }));

    expect(await verifyRoomClaimToken(v.room.id, v.token)).toBe(true);
    const claimed = await claimRoute(claimReq(v.room.id, v.token));
    expect(claimed.status).toBe(200);
    const recovered = setCookie(claimed, hostCookieName(v.room.id))!;
    expect((await moderationRoute(moderationReq(v.room.id, recovered))).status).toBe(200);
  });

  it("the response's session cookie is derived from the epoch that is ACTUALLY stored", async () => {
    const v = await venue("Bar Coerente");
    const res = await revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token }));
    const issued = setCookie(res, hostCookieName(v.room.id))!;
    // Recomputed independently from the record, not from the route's own notion.
    const secret = (await resolveRoomSecret(v.room.id))!;
    const expected = createHmac("sha256", secret.token)
      .update(`cantai-host-session-v1:e${secret.epoch}`)
      .digest("hex");
    expect(issued).toBe(expected);
    expect(await verifySessionValue(v.room.id, issued)).toBe(true);
  });

  it("when every rebind is clobbered, the owner is minted a fresh OWNER claim, so the pin survives", async () => {
    const v = await venue("Bar Rebind Perdido");
    // Every rebind write (4 attempts) is silently lost: a stale writer wins each
    // time. Later writes (the route's fresh mint) go through.
    const original = roomBackend.update.bind(roomBackend);
    let lost = 0;
    const spy = jest.spyOn(roomBackend, "update").mockImplementation(async (rec) => {
      if (lost++ < 4) return;
      return original(rec);
    });
    let res: Response;
    try {
      res = await revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token }));
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(200);
    const mintedClaim = setCookie(res, claimCookieName(v.room.id))!;
    const mintedSession = setCookie(res, hostCookieName(v.room.id))!;
    expect(mintedClaim).toBeTruthy();
    expect(mintedClaim).not.toBe(v.token);
    expect((await moderationRoute(moderationReq(v.room.id, mintedSession))).status).toBe(200);
    // The fresh token is the owner's, so this device can still use the lever.
    const room = (await getRoom(v.room.id))!;
    expect(room.ownerClaimTokenHash).toBe(
      createHmac("sha256", "boraoke-claim-token-v1").update(mintedClaim).digest("hex"),
    );
  });

  it("re-entering the host code after a revoke still works — the other devices' way back", async () => {
    const v = await venue("Bar Codigo");
    await revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token }));

    const res = await loginRoute(
      new NextRequest(`http://127.0.0.1:3040/api/host/login?room=${v.room.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.118" },
        body: JSON.stringify({ token: v.hostCode }),
      }),
    );
    expect(res.status).toBe(200);
    const session = setCookie(res, hostCookieName(v.room.id))!;
    expect(await verifySessionValue(v.room.id, session)).toBe(true);
    expect(session).not.toBe(v.session); // and NOT the revoked value
  });

  it("CONCURRENT revokes from the acting device never leave it without a credential", async () => {
    // A concurrency probe because a probe is what caught the round-4 race on this
    // surface (`stored=1 aLives=false bLives=true`) after two rounds of review
    // had passed the design.
    const v = await venue("Bar Concorrente");
    const stolen = v.session;
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token })),
      ),
    );
    // The per-room throttle (S3) is charged atomically BEFORE acting, so a burst
    // cannot all slip past a check: exactly its budget (3) succeed, the rest are
    // 429 with no bump. A 200 still means its atomic bump happened.
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, ...Array(9).fill(429)]);
    expect(await getRoomSessionEpoch(v.room.id)).toBe(3);

    // The device is still in, and the pre-revoke session is still dead.
    expect(await verifyRoomClaimToken(v.room.id, v.token)).toBe(true);
    expect(await verifySessionValue(v.room.id, stolen)).toBe(false);
    const recovered = await claimRoute(claimReq(v.room.id, v.token));
    expect(recovered.status).toBe(200);
    expect(
      (await moderationRoute(moderationReq(v.room.id, setCookie(recovered, hostCookieName(v.room.id))))).status,
    ).toBe(200);
  });

  it("a revoke racing an unrelated room write still leaves the device with a working credential", async () => {
    const v = await venue("Bar Corrida Mista");
    const stolen = v.session;
    const [revoked] = await Promise.all([
      revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token })),
      setRoomMode(v.room.id, "per-table-2"),
      issueRoomClaimToken(v.room.id),
    ]);
    expect(revoked.status).toBe(200);
    // Whatever the race did to the record, the old session is dead and the
    // device's new one works.
    expect(await verifySessionValue(v.room.id, stolen)).toBe(false);
    const issued = setCookie(revoked, hostCookieName(v.room.id))!;
    expect(await verifySessionValue(v.room.id, issued)).toBe(true);
  });

  it("CONCURRENT authenticated probes during a revoke never lock the device out", async () => {
    const v = await venue("Bar Sondagem");
    const res = await revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token }));
    const fresh = setCookie(res, hostCookieName(v.room.id))!;
    const probes = await Promise.all(
      Array.from({ length: 12 }, () => sessionProbe(probeReq(v.room.id, fresh, v.token))),
    );
    for (const p of probes) expect(p.status).toBe(200);
    expect(await verifyRoomClaimToken(v.room.id, v.token)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the revoke route is AUTHENTICATED — the same two refusals as logout", () => {
  it("a cookie-less POST changes NOTHING — no bump, no revocation, no cookie", async () => {
    const v = await venue("Bar Csrf 118");
    const res = await revokeRoute(revokeReq(v.room.id));
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie?.() ?? []).toEqual([]);
    expect(await getRoomSessionEpoch(v.room.id)).toBe(0);
    expect(await verifySessionValue(v.room.id, v.session)).toBe(true);
    expect(await verifyRoomClaimToken(v.room.id, v.token)).toBe(true);
  });

  it("a WRONG session value cannot revoke", async () => {
    const v = await venue("Bar Sessao Errada");
    const res = await revokeRoute(revokeReq(v.room.id, { session: "f".repeat(64) }));
    expect(res.status).toBe(401);
    expect(await getRoomSessionEpoch(v.room.id)).toBe(0);
  });

  it("a valid session presented from ANOTHER SITE cannot revoke", async () => {
    const v = await venue("Bar Outro Site");
    for (const fetchSite of ["cross-site", "none"]) {
      const res = await revokeRoute(revokeReq(v.room.id, { session: v.session, fetchSite }));
      expect(res.status).toBe(401);
    }
    expect(await getRoomSessionEpoch(v.room.id)).toBe(0);
    expect(await verifySessionValue(v.room.id, v.session)).toBe(true);
  });

  it("a valid session with a FOREIGN Origin cannot revoke either", async () => {
    const v = await venue("Bar Origem");
    for (const origin of ["http://evil.test", "null", "http://127.0.0.1:3040.evil.test"]) {
      const res = await revokeRoute(revokeReq(v.room.id, { session: v.session, origin }));
      expect(res.status).toBe(401);
    }
    expect(await getRoomSessionEpoch(v.room.id)).toBe(0);
  });

  it("the owner's OWN same-origin and same-site requests DO work — the controls", async () => {
    const a = await venue("Bar Mesma Origem");
    expect(
      (await revokeRoute(revokeReq(a.room.id, { session: a.session, claimToken: a.token, fetchSite: "same-origin" })))
        .status,
    ).toBe(200);
    const b = await venue("Bar Mesmo Site");
    expect(
      (await revokeRoute(revokeReq(b.room.id, { session: b.session, claimToken: b.token, fetchSite: "same-site" })))
        .status,
    ).toBe(200);
  });

  it("another room's valid session cannot revoke THIS room", async () => {
    const mine = await venue("Bar Meu 118");
    const other = await venue("Bar Alheio 118");
    const res = await revokeRoute(revokeReq(mine.room.id, { session: other.session }));
    expect(res.status).toBe(401);
    expect(await getRoomSessionEpoch(mine.room.id)).toBe(0);
    expect(await verifySessionValue(mine.room.id, mine.session)).toBe(true);
  });

  it("is not a room-existence oracle — a real room and a made-up one reply identically", async () => {
    const v = await venue("Bar Oraculo 118");
    const real = await revokeRoute(revokeReq(v.room.id));
    const fake = await revokeRoute(revokeReq("bar-que-nao-existe-118"));
    expect(real.status).toBe(fake.status);
    expect(await real.json()).toEqual(await fake.json());
  });

  it("a malformed room id is a 400, never a Redis key", async () => {
    const res = await revokeRoute(revokeReq("../../etc/passwd"));
    expect(res.status).toBe(400);
  });

  it("the legacy `default` room has no per-room sessions to revoke", async () => {
    // It has no record, so there is no epoch to bump; it is governed by the env
    // HOST_TOKEN. Authenticated, then honestly refused — never a false success.
    const session = (await issueSession(DEFAULT_ROOM))!;
    const res = await revokeRoute(revokeReq(DEFAULT_ROOM, { session }));
    expect(res.status).toBe(404);
    expect(await verifySessionValue(DEFAULT_ROOM, session)).toBe(true);
  });

  it("a plain LOGOUT signs out only this device: no epoch bump, the others stay in (TICKET-112)", async () => {
    // Tech Lead decision 2026-10-15. Logout means "get me off this device"; ending
    // every device's access is the explicit "sign out other devices" action.
    const v = await venue("Bar Logout Intacto");
    const phone = v.session; // the owner's phone holds the same session value
    const ownersClaim = (await issueRoomClaimToken(v.room.id))!;
    const res = await logoutRoute(
      new NextRequest(`http://127.0.0.1:3040/api/host/session?room=${v.room.id}`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:3040",
          cookie: `${hostCookieName(v.room.id)}=${v.session}; ${claimCookieName(v.room.id)}=${v.token}`,
        },
      }),
    );
    expect(res.status).toBe(200);
    // This device's credential is gone, server-side...
    expect(await verifyRoomClaimToken(v.room.id, v.token)).toBe(false);
    // ...and nobody else's is touched.
    expect(await getRoomSessionEpoch(v.room.id)).toBe(0);
    expect(await verifySessionValue(v.room.id, phone)).toBe(true);
    expect(await verifyRoomClaimToken(v.room.id, ownersClaim)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("epoch 0 is the LEGACY derivation, so shipping this logs nobody out", () => {
  it("a record with no sessionEpoch derives the byte-identical pre-TICKET-118 value", async () => {
    const { room } = await mustCreateRoom("Bar Legado");
    const rec = (await getRoom(room.id))!;
    expect(rec.sessionEpoch).toBeUndefined(); // no migration write happened
    // The pre-fix implementation, written out in full so this pins the actual
    // bytes rather than re-deriving through the code under test.
    const legacy = createHmac("sha256", rec.hostCodeHash)
      .update("cantai-host-session-v1")
      .digest("hex");
    expect(await issueSession(room.id)).toBe(legacy);
    expect(await verifySessionValue(room.id, legacy)).toBe(true);
  });

  it("a login on an untouched room writes no new field — the record keeps its pre-TICKET-118 shape", async () => {
    const { room } = await mustCreateRoom("Bar Formato");
    await issueRoomClaimToken(room.id);
    const rec = (await getRoom(room.id))!;
    expect(rec.sessionEpoch).toBeUndefined();
    expect(rec.claimTokenEpoch).toBeUndefined();
    expect(Object.keys(rec).sort()).toEqual(
      ["claimTokenHashes", "createdAt", "hostCodeHash", "id", "name", "settings"].sort(),
    );
  });

  it("a claim list written for an EARLIER epoch grants nothing (the stale-list fail-closed rule)", async () => {
    const { room } = await mustCreateRoom("Bar Lista Velha");
    const token = (await issueRoomClaimToken(room.id, { owner: true }))!;
    const listAtEpoch0 = (await getRoom(room.id))!;
    await revokeRoomHostSessions(room.id, { presentedClaimToken: token });
    expect(await verifyRoomClaimToken(room.id, token)).toBe(true); // kept, rebound to epoch 1
    // A stale writer puts the epoch-0 list back, tag and all.
    await roomBackend.update(listAtEpoch0);
    expect(await getRoomSessionEpoch(room.id)).toBe(1); // the counter held
    expect(await verifyRoomClaimToken(room.id, token)).toBe(false); // the list is dead
    // ...and the next mint starts a fresh list at the live epoch rather than reviving it.
    const fresh = (await issueRoomClaimToken(room.id))!;
    expect(await verifyRoomClaimToken(room.id, fresh)).toBe(true);
    expect(await verifyRoomClaimToken(room.id, token)).toBe(false);
    expect((await getRoom(room.id))!.claimTokenHashes).toEqual([
      createHmac("sha256", "boraoke-claim-token-v1").update(fresh).digest("hex"),
    ]);
  });

  it("the epoch is server-side bookkeeping — never in PublicRoom", async () => {
    const { room } = await mustCreateRoom("Bar Publico 118");
    await revokeRoomHostSessions(room.id);
    const pub = (await getPublicRoom(room.id))!;
    expect(Object.keys(pub)).not.toContain("sessionEpoch");
    expect(JSON.stringify(pub)).not.toContain("sessionEpoch");
  });

  it("a hand-written record at a later epoch invalidates every epoch-0 value", async () => {
    const { room } = await mustCreateRoom("Bar Mao 118");
    const legacy = (await issueSession(room.id))!;
    const rec = (await getRoom(room.id))!;
    await roomBackend.update({ ...rec, sessionEpoch: 7 });
    expect(await verifySessionValue(room.id, legacy)).toBe(false);
    expect(await getRoomSessionEpoch(room.id)).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("normaliseSessionEpoch", () => {
  it("honours non-negative integers", () => {
    expect(normaliseSessionEpoch(0)).toBe(0);
    expect(normaliseSessionEpoch(1)).toBe(1);
    expect(normaliseSessionEpoch(42)).toBe(42);
    expect(normaliseSessionEpoch(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("COERCES a numeric string rather than failing open to 0", () => {
    // A JSON-driver round trip handing back "3" must NOT resurrect every session
    // that epoch 3 revoked. This is the security-relevant case.
    expect(normaliseSessionEpoch("3")).toBe(3);
    expect(normaliseSessionEpoch(" 12 ")).toBe(12);
  });

  it("reads absent and un-interpretable input as 0 — the legacy derivation", () => {
    for (const raw of [
      undefined,
      null,
      "",
      "   ",
      "abc",
      "3abc",
      NaN,
      Infinity,
      -Infinity,
      -1,
      -0.5,
      1.5,
      "1.5",
      true,
      false,
      {},
      [],
      () => 3,
    ]) {
      expect(normaliseSessionEpoch(raw)).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("revokeRoomHostSessions — the helper's own contract", () => {
  it("bumps by exactly one and reports the new epoch", async () => {
    const { room } = await mustCreateRoom("Bar Helper");
    const owner = (await issueRoomClaimToken(room.id, { owner: true }))!;
    expect(await revokeRoomHostSessions(room.id, { presentedClaimToken: owner })).toMatchObject({
      ok: true,
      epoch: 1,
      keptClaimToken: true,
    });
    expect(await revokeRoomHostSessions(room.id, { presentedClaimToken: owner })).toMatchObject({
      ok: true,
      epoch: 2,
      keptClaimToken: true,
    });
  });

  it("keeps ONLY the owner's token, and never removes the owner pin", async () => {
    const { room } = await mustCreateRoom("Bar Preserva");
    const mine = (await issueRoomClaimToken(room.id, { owner: true }))!;
    const others = [(await issueRoomClaimToken(room.id))!, (await issueRoomClaimToken(room.id))!];
    const pin = (await getRoom(room.id))!.ownerClaimTokenHash;
    expect(pin).toBeTruthy();

    const res = await revokeRoomHostSessions(room.id, { presentedClaimToken: mine });
    expect(res).toMatchObject({ ok: true, epoch: 1, keptClaimToken: true });
    expect(await verifyRoomClaimToken(room.id, mine)).toBe(true);
    for (const dead of others) expect(await verifyRoomClaimToken(room.id, dead)).toBe(false);
    expect((await getRoom(room.id))!.ownerClaimTokenHash).toBe(pin);
  });

  it("an INVENTED token is refused and nothing changes (not written into the record on its own say-so)", async () => {
    const { room } = await mustCreateRoom("Bar Inventado");
    await issueRoomClaimToken(room.id, { owner: true });
    const before = await getRoom(room.id);
    const res = await revokeRoomHostSessions(room.id, { presentedClaimToken: "nunca-foi-emitido" });
    expect(res).toEqual({ ok: false, reason: "not-owner" });
    expect(await getRoom(room.id)).toEqual(before);
    expect(await verifyRoomClaimToken(room.id, "nunca-foi-emitido")).toBe(false);
  });

  it("a LIVE but non-owner (staff) token is refused: no bump, nobody signed out (S3)", async () => {
    const { room } = await mustCreateRoom("Bar Staff Helper");
    const owner = (await issueRoomClaimToken(room.id, { owner: true }))!;
    const staff = (await issueRoomClaimToken(room.id))!;
    expect(await revokeRoomHostSessions(room.id, { presentedClaimToken: staff })).toEqual({
      ok: false,
      reason: "not-owner",
    });
    expect(await revokeRoomHostSessions(room.id)).toEqual({ ok: false, reason: "not-owner" });
    expect(await getRoomSessionEpoch(room.id)).toBe(0);
    expect(await verifyRoomClaimToken(room.id, owner)).toBe(true);
    expect(await verifyRoomClaimToken(room.id, staff)).toBe(true);
  });

  it("an owner token in a list whose epoch tag is DEAD is refused (S5)", async () => {
    const { room } = await mustCreateRoom("Bar Lista Morta");
    const owner = (await issueRoomClaimToken(room.id, { owner: true }))!;
    // The list is tagged with an earlier epoch than the room's current one.
    await roomBackend.bumpSessionEpoch(room.id, 0);
    expect(await verifyRoomClaimToken(room.id, owner)).toBe(false);
    expect(await revokeRoomHostSessions(room.id, { presentedClaimToken: owner })).toEqual({
      ok: false,
      reason: "not-owner",
    });
    expect(await getRoomSessionEpoch(room.id)).toBe(1);
  });

  it("reports no-room for a room with no record", async () => {
    expect(await revokeRoomHostSessions("bar-inexistente-118")).toEqual({
      ok: false,
      reason: "no-room",
    });
    expect(await revokeRoomHostSessions(DEFAULT_ROOM)).toEqual({ ok: false, reason: "no-room" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * TICKET-127 INTERLEAVINGS — a stale whole-record write landing AFTER a revoke.
 *
 * Every room mutation is a whole-record read-modify-write with no compare-and-swap
 * (`RoomBackend.update` is a plain SET). So a login, a claim mint or a settings
 * change that READ the record before the revoke and WRITES it back after the revoke
 * has returned carries the pre-revoke record with it: the old epoch and the old
 * claim-hash list. If the epoch lived only in that record, the stale write would
 * roll it back, every session the owner just ended would verify again, and every
 * pruned claim token (the attacker's included) would be live again, after the owner
 * had been told "signed out". A bounded re-read inside the revoke cannot catch it,
 * because the clobber lands after the revoke has finished.
 *
 * These probes force that interleaving deterministically: the stale writer's
 * `roomBackend.update` is held at a gate until the revoke has fully returned.
 */
async function withStaleWriter<T>(
  writer: () => Promise<unknown>,
  during: () => Promise<T>,
): Promise<T> {
  const original = roomBackend.update.bind(roomBackend);
  let reachedWrite!: () => void;
  const atWrite = new Promise<void>((r) => (reachedWrite = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const spy = jest.spyOn(roomBackend, "update").mockImplementationOnce(async (rec) => {
    reachedWrite(); // the writer has READ the record and is about to write it back
    await gate;
    return original(rec);
  });
  try {
    const pending = writer();
    await atWrite;
    const out = await during();
    release();
    await pending;
    return out;
  } finally {
    spy.mockRestore();
  }
}

function loginReq(roomId: string, hostCode: string, ip: string): NextRequest {
  return new NextRequest(`http://127.0.0.1:3040/api/host/login?room=${roomId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ token: hostCode }),
  });
}

describe("a stale write that lands AFTER the revoke cannot undo it (TICKET-127)", () => {
  it("a concurrent LOGIN that read before the revoke and wrote after it", async () => {
    const v = await venue("Bar Login Atrasado");
    const stolenSession = v.session;
    const stolenClaim = (await issueRoomClaimToken(v.room.id))!; // another device's credential
    // Positive controls: both stolen credentials work before the revoke.
    expect((await moderationRoute(moderationReq(v.room.id, stolenSession))).status).toBe(200);
    expect(await verifyRoomClaimToken(v.room.id, stolenClaim)).toBe(true);

    const revoked = await withStaleWriter(
      () => loginRoute(loginReq(v.room.id, v.hostCode, "198.51.100.127")),
      () => revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token })),
    );
    expect(revoked.status).toBe(200);

    // The revocation stuck: the epoch did not roll back...
    expect(await getRoomSessionEpoch(v.room.id)).toBeGreaterThanOrEqual(1);
    // ...the stolen session is still dead, on a real host route...
    expect(await verifySessionValue(v.room.id, stolenSession)).toBe(false);
    expect((await moderationRoute(moderationReq(v.room.id, stolenSession))).status).toBe(401);
    // ...and the pruned claim token was NOT resurrected by the stale list.
    expect(await verifyRoomClaimToken(v.room.id, stolenClaim)).toBe(false);
    expect((await claimRoute(claimReq(v.room.id, stolenClaim))).status).toBe(401);
    // The acting device is not locked out: the session it was handed still works.
    const fresh = setCookie(revoked, hostCookieName(v.room.id))!;
    expect((await moderationRoute(moderationReq(v.room.id, fresh))).status).toBe(200);
  });

  it("a concurrent SETTINGS change (staff flips the mode) that read before the revoke", async () => {
    const v = await venue("Bar Modo Atrasado");
    const stolenSession = v.session;
    const stolenClaim = (await issueRoomClaimToken(v.room.id))!;
    const revoked = await withStaleWriter(
      () => setRoomMode(v.room.id, "per-table-2"),
      () => revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token })),
    );
    expect(revoked.status).toBe(200);
    expect(await verifySessionValue(v.room.id, stolenSession)).toBe(false);
    expect(await verifyRoomClaimToken(v.room.id, stolenClaim)).toBe(false);
    const fresh = setCookie(revoked, hostCookieName(v.room.id))!;
    expect((await moderationRoute(moderationReq(v.room.id, fresh))).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * The same race, as a randomized probe over every writer that touches the room
 * record. For each seed, some writers READ the room before the revoke starts and
 * some read it in the middle of the revoke (after the epoch bump, before the
 * claim list is rewritten). Every one of their WRITES is held until the revoke
 * has returned, then they land in a seeded random order. Writers are identified
 * by async context, not call order, so the revoke's own writes are never held.
 *
 * Invariants checked for every seed:
 *   1. The epoch never goes back (it ends above where it started).
 *   2. No session from before the revoke verifies.
 *   3. No claim token from before the revoke verifies, except possibly the acting
 *      device's own (the race may also kill that one; it never revives others).
 *   4. The acting device is not locked out: the session cookie the revoke handed
 *      back works on a real host route.
 *   5. Nothing is wedged: a later host-code login works and its claim token is live.
 */
const staleCtx = new AsyncLocalStorage<true>();

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function settle(cond: () => boolean, what: string) {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  if (!cond()) throw new Error(`probe harness stalled waiting for ${what}`);
}

type Writer = () => Promise<unknown>;

async function revokeAmidStaleWriters(
  before: Writer[],
  midway: Writer[],
  revoke: () => Promise<Response>,
  rand: () => number,
): Promise<Response> {
  const update = roomBackend.update.bind(roomBackend);
  const bump = roomBackend.bumpSessionEpoch.bind(roomBackend);
  const held: Array<() => void> = [];
  const running: Promise<unknown>[] = [];
  const start = (w: Writer) => running.push(staleCtx.run(true, w));
  const updSpy = jest.spyOn(roomBackend, "update").mockImplementation(async (rec) => {
    if (staleCtx.getStore()) await new Promise<void>((go) => held.push(go));
    return update(rec);
  });
  const bumpSpy = jest.spyOn(roomBackend, "bumpSessionEpoch").mockImplementation(async (id, floor) => {
    const n = await bump(id, floor);
    midway.forEach(start);
    await settle(() => held.length === before.length + midway.length, "mid-revoke readers");
    return n;
  });
  try {
    before.forEach(start);
    await settle(() => held.length === before.length, "pre-revoke readers");
    const res = await revoke();
    const order = held.map((_, i) => i).sort(() => rand() - 0.5);
    for (const i of order) {
      held[i]();
      await new Promise((r) => setImmediate(r));
    }
    await Promise.all(running);
    return res;
  } finally {
    updSpy.mockRestore();
    bumpSpy.mockRestore();
  }
}

describe("randomized stale-writer probe around a revoke (TICKET-127 x TICKET-118)", () => {
  const SEEDS = 120;
  it(`holds every invariant across ${SEEDS} seeded interleavings`, async () => {
    let ipN = 0;
    const ip = () => `192.0.2.${(ipN++ % 250) + 1}`;
    for (let seed = 1; seed <= SEEDS; seed++) {
      _clearLoginThrottle();
      const rand = seeded(seed);
      const v = await venue(`Bar Sonda ${seed}`);
      const staff = [(await issueRoomClaimToken(v.room.id))!, (await issueRoomClaimToken(v.room.id))!];
      const stolenSession = v.session;
      const preEpoch = await getRoomSessionEpoch(v.room.id);

      // Each writer must write exactly once (the harness waits for that).
      const kinds: Writer[] = [
        () => loginRoute(loginReq(v.room.id, v.hostCode, ip())),
        () => issueRoomClaimToken(v.room.id),
        () => setRoomMode(v.room.id, rand() < 0.5 ? "per-table-2" : "per-person-1"),
        () => setRoomLanguage(v.room.id, "en"),
        () => setRoomModeration(v.room.id, rand() < 0.5),
      ];
      const pick = (n: number) => Array.from({ length: n }, () => kinds[Math.floor(rand() * kinds.length)]);
      const before = pick(1 + Math.floor(rand() * 4));
      const midway = pick(Math.floor(rand() * 3));
      // A staff device logging out at the same moment (TICKET-112 logout is a
      // write too). Only before the revoke, so its hash is still in the list it reads.
      staff.forEach((t) => {
        if (rand() < 0.3) before.push(() => revokeRoomClaimToken(v.room.id, t));
      });

      const res = await revokeAmidStaleWriters(
        before,
        midway,
        () => revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token })),
        rand,
      );
      const ctx = `seed ${seed} (before=${before.length}, midway=${midway.length})`;
      expect([ctx, res.status]).toEqual([ctx, 200]);
      // 1
      expect([ctx, (await getRoomSessionEpoch(v.room.id)) > preEpoch]).toEqual([ctx, true]);
      // 2
      expect([ctx, await verifySessionValue(v.room.id, stolenSession)]).toEqual([ctx, false]);
      // 3
      for (const t of staff) {
        expect([ctx, await verifyRoomClaimToken(v.room.id, t)]).toEqual([ctx, false]);
      }
      // 4
      const fresh = setCookie(res, hostCookieName(v.room.id))!;
      expect([ctx, (await moderationRoute(moderationReq(v.room.id, fresh))).status]).toEqual([ctx, 200]);
      // 5
      const later = await loginRoute(loginReq(v.room.id, v.hostCode, ip()));
      expect([ctx, later.status]).toEqual([ctx, 200]);
      const laterClaim = setCookie(later, claimCookieName(v.room.id))!;
      expect([ctx, await verifyRoomClaimToken(v.room.id, laterClaim)]).toEqual([ctx, true]);
    }
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * CYBER S1 (HIGH) — the claim route used to verify the claim with one store read
 * and derive the session with a SECOND one. A revoke landing between the two let
 * a just-revoked claim token mint a session at the NEW epoch: the attacker
 * survived the very action that was meant to end them, then signed the owner out.
 *
 * The gate holds the claim request right AFTER its first store read has returned
 * (a pre-revoke snapshot), runs the owner's revoke to completion, and then lets
 * the claim finish. On the pre-fix route the second read sees the new epoch and
 * the minted session verifies; with verification and derivation on one snapshot,
 * the minted value is at the old epoch and is already dead.
 */
const claimCtx = new AsyncLocalStorage<{ reads: number }>();

describe("Cyber S1 — a claim verified before a revoke cannot mint a session that survives it", () => {
  it("a claim request straddling the bump gets a session that is ALREADY dead", async () => {
    const v = await venue("Bar Toctou 118");
    const copiedClaim = (await issueRoomClaimToken(v.room.id))!; // copied off a staff device
    const origGet = roomBackend.get.bind(roomBackend);
    let readReturned!: () => void;
    const afterFirstRead = new Promise<void>((r) => (readReturned = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const spy = jest.spyOn(roomBackend, "get").mockImplementation(async (id) => {
      const out = await origGet(id);
      const s = claimCtx.getStore();
      if (s && ++s.reads === 1) {
        readReturned();
        await gate;
      }
      return out;
    });
    let attackerRes: Response;
    let ownerRes: Response;
    try {
      const pending = claimCtx.run({ reads: 0 }, () => claimRoute(claimReq(v.room.id, copiedClaim)));
      await afterFirstRead; // the claim has read the PRE-revoke record
      ownerRes = await revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token }));
      release();
      attackerRes = await pending;
    } finally {
      spy.mockRestore();
    }
    // Controls: the interleaving really happened — the revoke landed (epoch 1)
    // while the claim held a snapshot on which its token was live.
    expect(ownerRes.status).toBe(200);
    expect(await getRoomSessionEpoch(v.room.id)).toBe(1);
    const minted = setCookie(attackerRes, hostCookieName(v.room.id));

    // THE PROPERTY: whatever the straddling claim was handed, it does not verify
    // and cannot act. (Pre-fix: verifies true, moderation 200.)
    expect(await verifySessionValue(v.room.id, minted)).toBe(false);
    expect((await moderationRoute(moderationReq(v.room.id, minted))).status).toBe(401);
    // ...so it cannot counter-revoke either, and the owner stays in.
    expect((await revokeRoute(revokeReq(v.room.id, { session: minted }))).status).toBe(401);
    const ownerSession = setCookie(ownerRes, hostCookieName(v.room.id))!;
    expect(await verifySessionValue(v.room.id, ownerSession)).toBe(true);
    expect(await verifyRoomClaimToken(v.room.id, v.token)).toBe(true);
    expect(await verifyRoomClaimToken(v.room.id, copiedClaim)).toBe(false);
  });

  it("the claim route makes ONE store read for a valid claim (verify and derive share it)", async () => {
    const v = await venue("Bar Uma Leitura");
    const spy = jest.spyOn(roomBackend, "get");
    try {
      const res = await claimRoute(claimReq(v.room.id, v.token));
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * CYBER S2 (MEDIUM) — the rebind used to decide which hash to keep from the list
 * it read INSIDE its loop. An ordinary concurrent host-code login between the bump
 * and the rebind (not a stale write) replaced the list, so the acting device's own
 * hash was "not found" and dropped, along with the new login's token. One lost
 * response then locked the acting device out. Single fault: the login, plus the
 * response never arriving.
 */
describe("Cyber S2 — a concurrent login between bump and rebind costs nobody their credential", () => {
  it("the acting device can still re-claim after a LOST response, and the concurrent login stays in", async () => {
    const v = await venue("Bar Rebind 118");
    const bump = roomBackend.bumpSessionEpoch.bind(roomBackend);
    let staffLogin: Response | undefined;
    const spy = jest.spyOn(roomBackend, "bumpSessionEpoch").mockImplementationOnce(async (id, floor) => {
      const n = await bump(id, floor);
      // A staff member types the host code right now; it completes normally.
      staffLogin = await loginRoute(loginReq(v.room.id, v.hostCode, "198.51.100.9"));
      return n;
    });
    let res: Response;
    try {
      res = await revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token }));
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(200);
    expect(staffLogin!.status).toBe(200);
    // The response is LOST: the device holds only its pre-revoke cookies.
    expect(await verifySessionValue(v.room.id, v.session)).toBe(false); // old session is dead
    expect(await verifyRoomClaimToken(v.room.id, v.token)).toBe(true); // pre-fix: false
    const reclaim = await claimRoute(claimReq(v.room.id, v.token));
    expect(reclaim.status).toBe(200); // pre-fix: 401, locked out
    expect(
      (await moderationRoute(moderationReq(v.room.id, setCookie(reclaim, hostCookieName(v.room.id))))).status,
    ).toBe(200);
    // The concurrent login proved the host code after the bump, so it is kept.
    const staffClaim = setCookie(staffLogin!, claimCookieName(v.room.id))!;
    expect(await verifyRoomClaimToken(v.room.id, staffClaim)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * CYBER S3 (MEDIUM; TM house default, pending TL confirmation) — any host session
 * used to be able to sign out every other device, the owner included, and drop
 * the owner pin, with no throttle. A stolen session could loop it and keep a
 * code-holding owner out 20 times out of 20. Now: owner's device only, the pin is
 * never removed, and successful uses are capped per room.
 */
function ownerLogin(roomId: string, hostCode: string) {
  return loginRoute(loginReq(roomId, hostCode, "198.51.100.77"));
}

describe("Cyber S3 — only the owner's device can sign out other devices", () => {
  it("a STAFF device (session + its own live claim) is refused: nothing changes, the owner stays in", async () => {
    const v = await venue("Bar Staff 118");
    const pin = (await getRoom(v.room.id))!.ownerClaimTokenHash;
    const staff = await ownerLogin(v.room.id, v.hostCode); // a staff member who knows the code
    const staffSession = setCookie(staff, hostCookieName(v.room.id))!;
    const staffClaim = setCookie(staff, claimCookieName(v.room.id))!;
    const res = await revokeRoute(revokeReq(v.room.id, { session: staffSession, claimToken: staffClaim }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ownerOnly: true });
    expect(res.headers.getSetCookie?.() ?? []).toEqual([]);
    expect(await getRoomSessionEpoch(v.room.id)).toBe(0);
    expect(await verifySessionValue(v.room.id, v.session)).toBe(true);
    expect(await verifyRoomClaimToken(v.room.id, v.token)).toBe(true);
    expect((await getRoom(v.room.id))!.ownerClaimTokenHash).toBe(pin);
  });

  it("a STOLEN session alone can no longer sign the owner out, and cannot loop it", async () => {
    const v = await venue("Bar Roubado 118");
    const stolen = v.session; // a copy of the owner's own session value, no claim cookie
    for (let i = 0; i < 5; i++) {
      expect((await revokeRoute(revokeReq(v.room.id, { session: stolen }))).status).toBe(403);
    }
    expect(await getRoomSessionEpoch(v.room.id)).toBe(0);
    // Refusals were never charged to the throttle: the owner's own use still works,
    // and it kills the stolen copy.
    const owner = await revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token }));
    expect(owner.status).toBe(200);
    expect(await verifySessionValue(v.room.id, stolen)).toBe(false);
  });

  it("the owner pin is never removed by the action", async () => {
    const v = await venue("Bar Pino 118");
    const pin = (await getRoom(v.room.id))!.ownerClaimTokenHash;
    await revokeRoute(revokeReq(v.room.id, { session: v.session, claimToken: v.token }));
    expect((await getRoom(v.room.id))!.ownerClaimTokenHash).toBe(pin);
    expect(await verifyRoomClaimToken(v.room.id, v.token)).toBe(true);
  });

  it("is throttled per room: the 4th use inside 10 minutes is a 429 that bumps nothing", async () => {
    const v = await venue("Bar Limite 118");
    let session = v.session;
    for (let i = 0; i < 3; i++) {
      const r = await revokeRoute(revokeReq(v.room.id, { session, claimToken: v.token }));
      expect(r.status).toBe(200);
      session = setCookie(r, hostCookieName(v.room.id))!;
    }
    const fourth = await revokeRoute(revokeReq(v.room.id, { session, claimToken: v.token }));
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toMatchObject({ throttled: true });
    expect(await getRoomSessionEpoch(v.room.id)).toBe(3);
    expect(await verifySessionValue(v.room.id, session)).toBe(true); // still signed in
    // Another room's budget is its own.
    const w = await venue("Bar Limite Outro 118");
    expect((await revokeRoute(revokeReq(w.room.id, { session: w.session, claimToken: w.token }))).status).toBe(200);
  });

  it("the server tells the admin page which device is the owner's (session probe, claim, login)", async () => {
    const v = await venue("Bar Dono 118");
    const staffClaim = (await issueRoomClaimToken(v.room.id))!;
    expect(await (await sessionProbe(probeReq(v.room.id, v.session, v.token))).json()).toMatchObject({
      authed: true,
      owner: true,
    });
    expect(await (await sessionProbe(probeReq(v.room.id, v.session, staffClaim))).json()).toMatchObject({
      authed: true,
      owner: false,
    });
    expect(await (await claimRoute(claimReq(v.room.id, v.token))).json()).toMatchObject({ owner: true });
    expect(await (await claimRoute(claimReq(v.room.id, staffClaim))).json()).toMatchObject({ owner: false });
    expect(await (await ownerLogin(v.room.id, v.hostCode)).json()).toMatchObject({ owner: false });
  });
});
