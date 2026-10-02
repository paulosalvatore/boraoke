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
  setRoomMode,
  verifyRoomClaimToken,
} from "@/lib/rooms";

const VENUE_IP = "203.0.113.118";

async function mustCreateRoom(name: string) {
  const created = await createRoom(name);
  if (!created) throw new Error("room ceiling hit in test");
  return created;
}

/** A room, a live claim token for it, and a live host session — the venue's real state. */
async function venue(name: string) {
  const { room, hostCode } = await mustCreateRoom(name);
  const token = await issueRoomClaimToken(room.id);
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

  it("a device holding a session but NO claim token is minted one, so it is not left worse off", async () => {
    const { room } = await mustCreateRoom("Bar Sem Claim");
    const session = (await issueSession(room.id))!;
    const res = await revokeRoute(revokeReq(room.id, { session }));
    expect(res.status).toBe(200);
    const mintedClaim = setCookie(res, claimCookieName(room.id));
    const mintedSession = setCookie(res, hostCookieName(room.id))!;
    expect(mintedClaim).toBeTruthy();
    expect(await verifyRoomClaimToken(room.id, mintedClaim)).toBe(true);
    expect((await moderationRoute(moderationReq(room.id, mintedSession))).status).toBe(200);
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
    // Every one either succeeded or reported contention honestly — never a false success.
    for (const r of results) expect([200, 503]).toContain(r.status);
    expect(results.some((r) => r.status === 200)).toBe(true);

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
      setRoomMode(v.room.id, "rotation"),
      issueRoomClaimToken(v.room.id),
    ]);
    expect([200, 503]).toContain(revoked.status);

    // Whatever the race did to the record, the device can always get back in, and
    // the route never claimed success without the bump landing.
    if (revoked.status === 200) {
      expect(await verifySessionValue(v.room.id, stolen)).toBe(false);
      const issued = setCookie(revoked, hostCookieName(v.room.id))!;
      expect(await verifySessionValue(v.room.id, issued)).toBe(true);
    } else {
      // Contention reported honestly: sessions are still live, and we said so.
      expect(await getRoomSessionEpoch(v.room.id)).toBe(0);
    }
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

  it("logout is UNCHANGED — it does not bump the epoch", async () => {
    // Deliberate scope choice: logout means "get me off this tablet". Making it
    // also kill the owner's own phone's live session would regress the ordinary
    // path into the shown-once-code dead end TICKET-104 removes.
    const v = await venue("Bar Logout Intacto");
    const phone = v.session;
    const headers: Record<string, string> = {
      host: "127.0.0.1:3040",
      cookie: `${hostCookieName(v.room.id)}=${v.session}`,
    };
    const res = await logoutRoute(
      new NextRequest(`http://127.0.0.1:3040/api/host/session?room=${v.room.id}`, {
        method: "POST",
        headers,
      }),
    );
    expect(res.status).toBe(200);
    expect(await getRoomSessionEpoch(v.room.id)).toBe(0);
    expect(await verifySessionValue(v.room.id, phone)).toBe(true);
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
    expect(await revokeRoomHostSessions(room.id)).toEqual({ ok: true, epoch: 1, keptClaimToken: false });
    expect(await revokeRoomHostSessions(room.id)).toEqual({ ok: true, epoch: 2, keptClaimToken: false });
  });

  it("keeps ONLY the presented token, and only when it is genuinely live", async () => {
    const { room } = await mustCreateRoom("Bar Preserva");
    const mine = (await issueRoomClaimToken(room.id))!;
    const others = [(await issueRoomClaimToken(room.id))!, (await issueRoomClaimToken(room.id))!];

    const res = await revokeRoomHostSessions(room.id, { presentedClaimToken: mine });
    expect(res).toEqual({ ok: true, epoch: 1, keptClaimToken: true });
    expect(await verifyRoomClaimToken(room.id, mine)).toBe(true);
    for (const dead of others) expect(await verifyRoomClaimToken(room.id, dead)).toBe(false);
  });

  it("an INVENTED token is not written into the record on its own say-so", async () => {
    const { room } = await mustCreateRoom("Bar Inventado");
    await issueRoomClaimToken(room.id);
    const res = await revokeRoomHostSessions(room.id, { presentedClaimToken: "nunca-foi-emitido" });
    expect(res).toEqual({ ok: true, epoch: 1, keptClaimToken: false });
    expect((await getRoom(room.id))!.claimTokenHashes).toBeUndefined();
    expect(await verifyRoomClaimToken(room.id, "nunca-foi-emitido")).toBe(false);
  });

  it("reports no-room distinctly from contention", async () => {
    expect(await revokeRoomHostSessions("bar-inexistente-118")).toEqual({
      ok: false,
      reason: "no-room",
    });
    expect(await revokeRoomHostSessions(DEFAULT_ROOM)).toEqual({ ok: false, reason: "no-room" });
  });
});
