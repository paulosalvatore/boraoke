/**
 * REAL-REDIS execution of TICKET-126's two scripts: RESERVE_PRINCIPAL_SCRIPT
 * (platform + IP + device, all or none) and RELEASE_LOCK_SCRIPT (single-flight
 * compare-and-delete). Opt-in like search-budget-lua.integration.test.ts: set
 * REDIS_TEST_URL to a redis:// server, e.g.
 *   docker run --rm -d -p 6426:6379 redis:7-alpine
 *   REDIS_TEST_URL=redis://127.0.0.1:6426 npx jest principal-lua
 * The JS-level suites never interpret the Lua, so this is the only proof that
 * the SHIPPED script text does what its docblock says.
 */
import { RESERVE_PRINCIPAL_SCRIPT } from "@/lib/search-budget";
import { RELEASE_LOCK_SCRIPT } from "@/lib/search-single-flight";
import { Resp } from "./helpers/resp";

const REDIS_URL = process.env.REDIS_TEST_URL;
const maybe = REDIS_URL ? describe : describe.skip;

if (!REDIS_URL) {
  it("SKIPPED: set REDIS_TEST_URL to execute the real Lua against a real Redis", () => {
    expect(RESERVE_PRINCIPAL_SCRIPT).toContain("INCR");
  });
}

maybe("RESERVE_PRINCIPAL_SCRIPT executed by a real Redis", () => {
  let r: Resp;
  const G = "sb:t126:global";
  const IP_A = "sb:t126:ip:a";
  const IP_B = "sb:t126:ip:b";
  const DEV_1 = "sb:t126:dev:1";
  const DEV_2 = "sb:t126:dev:2";
  const DEV_3 = "sb:t126:dev:3";

  beforeAll(async () => {
    r = new Resp();
    await r.connect(REDIS_URL!);
  });
  afterAll(() => r?.end());
  beforeEach(async () => {
    await r.cmd("DEL", G, IP_A, IP_B, DEV_1, DEV_2, DEV_3);
  });

  const reserve = (ip: string, dev: string, caps = { budget: 90, ip: 45, dev: 10 }, ttl = 60_000) =>
    r.cmd("EVAL", RESERVE_PRINCIPAL_SCRIPT, 3, G, ip, dev, caps.budget, caps.ip, caps.dev, ttl);
  const get = async (k: string) => Number((await r.cmd("GET", k)) ?? 0);

  it("grants the device cap, then returns -3 and charges NOTHING on the denial", async () => {
    for (let i = 0; i < 10; i++) expect(Number(await reserve(IP_A, DEV_1))).toBe(90 - (i + 1));
    expect(await reserve(IP_A, DEV_1)).toBe(-3);
    expect(await reserve(IP_A, DEV_1)).toBe(-3);
    expect(await get(G)).toBe(10);
    expect(await get(IP_A)).toBe(10);
    expect(await get(DEV_1)).toBe(10);
  });

  it("returns -2 at the IP cap before the device cap, charging nothing", async () => {
    const caps = { budget: 90, ip: 3, dev: 10 };
    expect(await reserve(IP_A, DEV_1, caps)).toBe(89);
    expect(await reserve(IP_A, DEV_2, caps)).toBe(88);
    expect(await reserve(IP_A, DEV_3, caps)).toBe(87);
    expect(await reserve(IP_A, DEV_1, caps)).toBe(-2);
    expect(await get(G)).toBe(3);
    expect(await get(DEV_1)).toBe(1);
    // A different network is unaffected.
    expect(await reserve(IP_B, DEV_1, caps)).toBe(86);
  });

  it("returns -1 when the platform is spent, ahead of any personal reason", async () => {
    const caps = { budget: 2, ip: 1, dev: 1 };
    expect(await reserve(IP_A, DEV_1, caps)).toBe(1);
    expect(await reserve(IP_B, DEV_2, caps)).toBe(0);
    expect(await reserve(IP_A, DEV_1, caps)).toBe(-1); // both personal caps also spent: platform wins
  });

  it("sets TTLs on create only, on all three keys", async () => {
    await reserve(IP_A, DEV_1, undefined, 120_000);
    for (const k of [G, IP_A, DEV_1]) {
      const t = Number(await r.cmd("PTTL", k));
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThanOrEqual(120_000);
    }
    const before = Number(await r.cmd("PTTL", DEV_1));
    await reserve(IP_A, DEV_1, undefined, 999_000);
    expect(Number(await r.cmd("PTTL", DEV_1))).toBeLessThanOrEqual(before);
  });

  it("grants exactly the device cap under 100 pipelined concurrent evals from one device", async () => {
    const replies = await Promise.all(Array.from({ length: 100 }, () => reserve(IP_A, DEV_1)));
    const granted = replies.filter((v) => Number(v) >= 0);
    expect(granted).toHaveLength(10);
    expect(new Set(granted.map(Number)).size).toBe(10);
    expect(replies.filter((v) => v === -3)).toHaveLength(90);
    expect(await get(G)).toBe(10);
  });
});

maybe("RELEASE_LOCK_SCRIPT executed by a real Redis", () => {
  let r: Resp;
  const L = "sf:t126:lock";
  beforeAll(async () => {
    r = new Resp();
    await r.connect(REDIS_URL!);
  });
  afterAll(() => r?.end());
  beforeEach(async () => {
    await r.cmd("DEL", L);
  });

  it("deletes the lock only for the token that holds it", async () => {
    expect(await r.cmd("SET", L, "mine", "NX", "PX", 10_000)).toBe("OK");
    expect(await r.cmd("SET", L, "theirs", "NX", "PX", 10_000)).toBeNull();
    expect(await r.cmd("EVAL", RELEASE_LOCK_SCRIPT, 1, L, "theirs")).toBe(0);
    expect(await r.cmd("GET", L)).toBe("mine");
    expect(await r.cmd("EVAL", RELEASE_LOCK_SCRIPT, 1, L, "mine")).toBe(1);
    expect(await r.cmd("GET", L)).toBeNull();
  });

  it("an expired leader cannot delete the next leader's lock", async () => {
    await r.cmd("SET", L, "old", "NX", "PX", 50);
    await new Promise((res) => setTimeout(res, 120));
    expect(await r.cmd("SET", L, "new", "NX", "PX", 10_000)).toBe("OK");
    expect(await r.cmd("EVAL", RELEASE_LOCK_SCRIPT, 1, L, "old")).toBe(0);
    expect(await r.cmd("GET", L)).toBe("new");
  });
});
