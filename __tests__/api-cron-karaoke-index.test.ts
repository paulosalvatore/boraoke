/**
 * GET /api/cron/karaoke-index — auth is fail-closed and the refresh (which
 * spends Data API units) runs only for the correct bearer.
 */
const runRefresh = jest.fn(async () => ({
  refreshed: [],
  skipped: [],
  unitsUsed: 0,
  elapsedMs: 0,
  searchListCalls: 0,
}));
jest.mock("@/lib/karaoke-index/refresh", () => ({ runRefresh: (...a: unknown[]) => runRefresh(...(a as [])) }));
jest.mock("@/lib/karaoke-index/store", () => ({
  getIndexRedis: () => ({}),
  INDEX_CHANNELS: ["UC0000000000000000000001"],
  readStamps: async () => new Map(),
  writeShard: async () => undefined,
}));

import { randomBytes } from "crypto";

import { GET } from "@/app/api/cron/karaoke-index/route";

const ENV = { ...process.env };
// Generated per run: no credential-shaped literal in the repo.
const SECRET = randomBytes(24).toString("hex");

function req(auth?: string): Request {
  return new Request("http://localhost/api/cron/karaoke-index", {
    headers: auth === undefined ? {} : { authorization: auth },
  });
}

beforeEach(() => {
  runRefresh.mockClear();
  process.env = { ...ENV, YOUTUBE_API_KEY: "k" };
});
afterAll(() => {
  process.env = ENV;
});

it("503 when CRON_SECRET is unset (fail-closed), even with a bearer", async () => {
  delete process.env.CRON_SECRET;
  for (const h of [undefined, "Bearer anything", "Bearer "]) {
    expect((await GET(req(h))).status).toBe(503);
  }
  process.env.CRON_SECRET = "";
  expect((await GET(req("Bearer "))).status).toBe(503);
  expect(runRefresh).not.toHaveBeenCalled();
});

it("401 for a missing, wrong, malformed or near-miss bearer — refresh never runs", async () => {
  process.env.CRON_SECRET = SECRET;
  for (const h of [
    undefined,
    "Bearer ",
    "Bearer wrong",
    `bearer ${SECRET}`,
    SECRET,
    `Bearer ${SECRET}x`,
    `Bearer ${SECRET.slice(0, -1)}`,
    `Basic ${SECRET}`,
  ]) {
    const res = await GET(req(h));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(SECRET);
  }
  expect(runRefresh).not.toHaveBeenCalled();
});

it("200 and exactly one refresh for the correct bearer", async () => {
  process.env.CRON_SECRET = SECRET;
  const res = await GET(req(`Bearer ${SECRET}`));
  expect(res.status).toBe(200);
  expect((await res.json()).searchListCalls).toBe(0);
  expect(runRefresh).toHaveBeenCalledTimes(1);
});

it("503 when the key is missing, even with the correct bearer", async () => {
  process.env.CRON_SECRET = SECRET;
  delete process.env.YOUTUBE_API_KEY;
  expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(503);
  expect(runRefresh).not.toHaveBeenCalled();
});
