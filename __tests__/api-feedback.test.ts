/**
 * API tests for /api/feedback (TICKET-11): POST validation + durable rate limit,
 * the admin-token-guarded GET watermark read, and the PATCH status-update path.
 * Runs against the memory-driver singleton (CI default), cleared between tests.
 */
import { GET, PATCH, POST } from "@/app/api/feedback/route";
import { feedbackStore } from "@/lib/feedback-store";
import { RATE_LIMIT_MAX } from "@/lib/feedback-types";
import { NextRequest } from "next/server";

const VALID_UUID = "123e4567-e89b-42d3-a456-426614174000";
const ADMIN_TOKEN = "test-admin-token-abc123";

function postReq(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://127.0.0.1:3011/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(async () => {
  await feedbackStore.clear();
});

describe("POST /api/feedback — validation", () => {
  it("accepts a sentiment-only submission (201) and persists it", async () => {
    const res = await POST(postReq({ sentiment: "love", context: { uuid: VALID_UUID, route: "/", role: "patron" } }));
    expect(res.status).toBe(201);
    const items = await feedbackStore.list();
    expect(items).toHaveLength(1);
    expect(items[0].sentiment).toBe("love");
    expect(items[0].status).toBe("new");
  });

  it("rejects a missing/invalid sentiment (400)", async () => {
    expect((await POST(postReq({ context: { uuid: VALID_UUID, route: "/", role: "patron" } }))).status).toBe(400);
    expect((await POST(postReq({ sentiment: "ecstatic", context: { uuid: VALID_UUID, route: "/", role: "patron" } }))).status).toBe(400);
  });

  it("rejects a missing/invalid context.uuid (400)", async () => {
    expect((await POST(postReq({ sentiment: "happy", context: { route: "/", role: "patron" } }))).status).toBe(400);
    expect((await POST(postReq({ sentiment: "happy", context: { uuid: "not-a-uuid", route: "/", role: "patron" } }))).status).toBe(400);
  });

  it("rejects an invalid category but accepts a valid one", async () => {
    expect((await POST(postReq({ sentiment: "happy", category: "nope", context: { uuid: VALID_UUID, route: "/", role: "patron" } }))).status).toBe(400);
    const ok = await POST(postReq({ sentiment: "happy", category: "song-search", text: "acha sertanejo", context: { uuid: VALID_UUID, route: "/", role: "patron" } }));
    expect(ok.status).toBe(201);
    const items = await feedbackStore.list();
    expect(items[0].category).toBe("song-search");
    expect(items[0].text).toBe("acha sertanejo");
  });

  it("rejects invalid JSON and oversized bodies (400)", async () => {
    expect((await POST(postReq("{not json"))).status).toBe(400);
    const huge = "x".repeat(9000);
    expect((await POST(postReq({ sentiment: "happy", text: huge, context: { uuid: VALID_UUID, route: "/", role: "patron" } }))).status).toBe(400);
  });

  it("server-augments context (appVersion, userAgent, createdAt) and never trusts the client for them", async () => {
    process.env.GIT_SHA = "abc1234";
    const res = await POST(
      postReq(
        { sentiment: "happy", context: { uuid: VALID_UUID, route: "/host", role: "host", appVersion: "HACKED", createdAt: "1999-01-01" } },
        { "user-agent": "Mozilla/5.0 (iPhone) Safari" },
      ),
    );
    expect(res.status).toBe(201);
    const rec = (await feedbackStore.list())[0];
    expect(rec.context.appVersion).toBe("abc1234"); // from env, not the client's "HACKED"
    expect(rec.context.userAgent).toContain("iPhone");
    expect(rec.context.createdAt).not.toBe("1999-01-01");
    expect(rec.context.role).toBe("host");
    delete process.env.GIT_SHA;
  });
});

describe("POST /api/feedback — rate limit (5/uuid/hour)", () => {
  it("rejects the 6th submission per uuid with 429", async () => {
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect((await POST(postReq({ sentiment: "happy", context: { uuid: VALID_UUID, route: "/", role: "patron" } }))).status).toBe(201);
    }
    const sixth = await POST(postReq({ sentiment: "happy", context: { uuid: VALID_UUID, route: "/", role: "patron" } }));
    expect(sixth.status).toBe(429);
    // Only the 5 accepted ones are stored.
    expect(await feedbackStore.list()).toHaveLength(RATE_LIMIT_MAX);
  });

  it("isolates the limit per uuid", async () => {
    const other = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      await POST(postReq({ sentiment: "happy", context: { uuid: VALID_UUID, route: "/", role: "patron" } }));
    }
    // A different uuid is unaffected.
    expect((await POST(postReq({ sentiment: "happy", context: { uuid: other, route: "/", role: "patron" } }))).status).toBe(201);
  });
});

function adminReq(method: "GET" | "PATCH", opts: { token?: string; since?: string; body?: unknown } = {}) {
  const url = new URL("http://127.0.0.1:3011/api/feedback");
  if (opts.since) url.searchParams.set("since", opts.since);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new NextRequest(url, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("GET /api/feedback — admin watermark read", () => {
  afterEach(() => {
    delete process.env.FEEDBACK_ADMIN_TOKEN;
  });

  it("is fail-closed when no admin token is configured (401)", async () => {
    delete process.env.FEEDBACK_ADMIN_TOKEN;
    expect((await GET(adminReq("GET", { token: "anything" }))).status).toBe(401);
  });

  it("rejects a missing or wrong token (401)", async () => {
    process.env.FEEDBACK_ADMIN_TOKEN = ADMIN_TOKEN;
    expect((await GET(adminReq("GET"))).status).toBe(401);
    expect((await GET(adminReq("GET", { token: "wrong" }))).status).toBe(401);
  });

  it("rejects a same-length wrong token (401) — timing-safe compare path", async () => {
    process.env.FEEDBACK_ADMIN_TOKEN = ADMIN_TOKEN;
    // Same byte length as ADMIN_TOKEN, different content → exercises timingSafeEqual.
    const sameLenWrong = "x".repeat(ADMIN_TOKEN.length);
    expect(sameLenWrong).toHaveLength(ADMIN_TOKEN.length);
    expect((await GET(adminReq("GET", { token: sameLenWrong }))).status).toBe(401);
  });

  it("returns items + watermark with a valid token", async () => {
    process.env.FEEDBACK_ADMIN_TOKEN = ADMIN_TOKEN;
    await POST(postReq({ sentiment: "love", context: { uuid: VALID_UUID, route: "/", role: "patron" } }));
    const res = await GET(adminReq("GET", { token: ADMIN_TOKEN }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { items: unknown[]; watermark: string | null };
    expect(data.items).toHaveLength(1);
    expect(data.watermark).toBeTruthy();
  });
});

describe("PATCH /api/feedback — admin status update", () => {
  afterEach(() => {
    delete process.env.FEEDBACK_ADMIN_TOKEN;
  });

  it("requires the admin token (401)", async () => {
    delete process.env.FEEDBACK_ADMIN_TOKEN;
    expect((await PATCH(adminReq("PATCH", { body: { id: "x", status: "triaged" } }))).status).toBe(401);
  });

  it("flips a record new → triaged with a triageRef", async () => {
    process.env.FEEDBACK_ADMIN_TOKEN = ADMIN_TOKEN;
    await POST(postReq({ sentiment: "meh", context: { uuid: VALID_UUID, route: "/", role: "patron" } }));
    const id = (await feedbackStore.list())[0].id;
    const res = await PATCH(adminReq("PATCH", { token: ADMIN_TOKEN, body: { id, status: "triaged", triageRef: "cluster-3" } }));
    expect(res.status).toBe(200);
    const rec = await feedbackStore.get(id);
    expect(rec?.status).toBe("triaged");
    expect(rec?.triageRef).toBe("cluster-3");
  });

  it("404s an unknown id and 400s an invalid status", async () => {
    process.env.FEEDBACK_ADMIN_TOKEN = ADMIN_TOKEN;
    expect((await PATCH(adminReq("PATCH", { token: ADMIN_TOKEN, body: { id: "missing", status: "triaged" } }))).status).toBe(404);
    expect((await PATCH(adminReq("PATCH", { token: ADMIN_TOKEN, body: { id: "x", status: "bogus" } }))).status).toBe(400);
  });
});
