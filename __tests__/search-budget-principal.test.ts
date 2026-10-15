/**
 * reserveSearchCall(now, principal) on the UPSTASH path (TICKET-126): what is
 * sent to Redis, and how every reply maps to a decision. The script's own
 * semantics are executed against a real Redis in
 * search-principal-lua.integration.test.ts; this suite pins the wiring and the
 * fail-closed mapping, which no Lua test can see.
 */
import {
  reserveSearchCall,
  RESERVE_PRINCIPAL_SCRIPT,
  RESERVE_SEARCH_SCRIPT,
  SEARCH_DAILY_BUDGET,
  DEFAULT_DEVICE_DAILY_CAP,
  DEFAULT_IP_DAILY_CAP,
  pacificDayKey,
  _resetSearchBudget,
  _resetBudgetClient,
} from "@/lib/search-budget";

let reply: unknown = 5;
let throwErr: Error | null = null;
const calls: Array<{ script: string; keys: string[]; args: (string | number)[] }> = [];

jest.mock("@upstash/redis", () => ({
  Redis: {
    fromEnv: () => ({
      eval: async (script: string, keys: string[], args: (string | number)[]) => {
        calls.push({ script, keys, args });
        if (throwErr) throw throwErr;
        return reply;
      },
    }),
  },
}));

const ENV = { ...process.env };
const NOW = new Date("2026-10-14T20:00:00Z");
const WHO = { device: "u:123e4567-e89b-42d3-a456-000000000001", ip: "203.0.113.7" };

beforeEach(() => {
  process.env.STORE_DRIVER = "upstash";
  calls.length = 0;
  reply = 5;
  throwErr = null;
  _resetSearchBudget();
  _resetBudgetClient();
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

it("sends the three-key script with platform, ip and device keys and the caps", async () => {
  await reserveSearchCall(NOW, WHO);
  expect(calls).toHaveLength(1);
  const [{ script, keys, args }] = calls;
  expect(script).toBe(RESERVE_PRINCIPAL_SCRIPT);
  const day = pacificDayKey(NOW);
  expect(keys[0]).toBe(`sb:${day}`);
  expect(keys[1]).toMatch(new RegExp(`^sb:${day}:ip:[0-9a-f]{32}$`));
  expect(keys[2]).toMatch(new RegExp(`^sb:${day}:dev:[0-9a-f]{32}$`));
  expect(args.slice(0, 3)).toEqual([SEARCH_DAILY_BUDGET, DEFAULT_IP_DAILY_CAP, DEFAULT_DEVICE_DAILY_CAP]);
  // No raw address or id in a key name.
  expect(keys.join(" ")).not.toContain("203.0.113.7");
  expect(keys.join(" ")).not.toContain("123e4567");
});

it("gives different principals different keys, and the same principal the same keys", async () => {
  await reserveSearchCall(NOW, WHO);
  await reserveSearchCall(NOW, WHO);
  await reserveSearchCall(NOW, { device: "u:other", ip: "203.0.113.8" });
  expect(calls[0].keys).toEqual(calls[1].keys);
  expect(calls[2].keys[1]).not.toBe(calls[0].keys[1]);
  expect(calls[2].keys[2]).not.toBe(calls[0].keys[2]);
});

it("passes env overrides through as the caps", async () => {
  process.env.SEARCH_DEVICE_DAILY_CAP = "4";
  process.env.SEARCH_IP_DAILY_CAP = "20";
  await reserveSearchCall(NOW, WHO);
  expect(calls[0].args.slice(1, 3)).toEqual([20, 4]);
});

it("keeps the platform-only script when no principal is given (pre-existing callers)", async () => {
  await reserveSearchCall(NOW);
  expect(calls[0].script).toBe(RESERVE_SEARCH_SCRIPT);
  expect(calls[0].keys).toHaveLength(1);
});

it.each([
  [-1, "cap"],
  [-2, "ip"],
  [-3, "device"],
  [-7, "cap"],
])("maps reply %d to a denial with reason %s", async (code, reason) => {
  reply = code;
  expect(await reserveSearchCall(NOW, WHO)).toMatchObject({ ok: false, remaining: 0, reason });
});

it("grants on a non-negative integer reply", async () => {
  reply = 0;
  expect(await reserveSearchCall(NOW, WHO)).toMatchObject({ ok: true, remaining: 0 });
});

it.each([null, "", "3", [], 1.5, undefined])("FAILS CLOSED on a malformed reply %j", async (bad) => {
  reply = bad;
  expect(await reserveSearchCall(NOW, WHO)).toMatchObject({ ok: false, reason: "store" });
});

it("FAILS CLOSED when the store errors", async () => {
  throwErr = new Error("ECONNREFUSED");
  expect(await reserveSearchCall(NOW, WHO)).toMatchObject({ ok: false, reason: "store" });
});
