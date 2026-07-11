/**
 * Rate-limit counter unit tests (TICKET-48) — MEMORY PATH + REDIS EVAL PATH.
 *
 * CI runs in memory mode (no Upstash env), mirroring how the standalone
 * throttle tests avoid a real Redis. The memory-path block exercises the
 * fixed-window semantics, the max-failures gate, reset, window expiry, and the
 * LRU cap. The Redis-path block (TICKET-50) mocks `@upstash/redis` so
 * `Redis.fromEnv()` yields a fake with `.eval`, and asserts the single-EVAL
 * atomic register-failure (no more separate INCR + EXPIRE) plus fail-open.
 */
import {
  isThrottled,
  registerFailure,
  resetKey,
  _clearAll,
} from "@/lib/rate-limit-counter";

const ORIGINAL_ENV = { ...process.env };
const OPTS = { max: 5, windowMs: 60_000 };

beforeEach(() => {
  // Force the memory path regardless of ambient env.
  delete process.env.UPSTASH_REDIS_REST_URL;
  process.env.STORE_DRIVER = "memory";
  _clearAll();
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.useRealTimers();
});

describe("rate-limit-counter (memory path)", () => {
  it("is not throttled before any failure", async () => {
    expect(await isThrottled("k", OPTS)).toBe(false);
  });

  it("trips exactly at the max-failures gate", async () => {
    const key = "login:203.0.113.7";
    for (let i = 0; i < OPTS.max; i++) {
      expect(await isThrottled(key, OPTS)).toBe(false);
      await registerFailure(key, OPTS);
    }
    expect(await isThrottled(key, OPTS)).toBe(true);
  });

  it("resetKey clears the counter", async () => {
    const key = "login:203.0.113.8";
    for (let i = 0; i < OPTS.max; i++) await registerFailure(key, OPTS);
    expect(await isThrottled(key, OPTS)).toBe(true);
    await resetKey(key);
    expect(await isThrottled(key, OPTS)).toBe(false);
  });

  it("expires the window after windowMs", async () => {
    jest.useFakeTimers();
    const key = "login:203.0.113.9";
    for (let i = 0; i < OPTS.max; i++) await registerFailure(key, OPTS);
    expect(await isThrottled(key, OPTS)).toBe(true);
    jest.advanceTimersByTime(OPTS.windowMs + 1);
    expect(await isThrottled(key, OPTS)).toBe(false);
  });

  it("anchors the window at the first failure (not sliding)", async () => {
    jest.useFakeTimers();
    const key = "login:203.0.113.10";
    await registerFailure(key, OPTS); // window opens at t=0
    jest.advanceTimersByTime(OPTS.windowMs - 1);
    for (let i = 0; i < OPTS.max; i++) await registerFailure(key, OPTS);
    // Still within the original window → throttled.
    expect(await isThrottled(key, OPTS)).toBe(true);
    // Cross the original window boundary → the first failure's window expired.
    jest.advanceTimersByTime(2);
    expect(await isThrottled(key, OPTS)).toBe(false);
  });

  it("caps tracked keys (LRU eviction, no unbounded growth)", async () => {
    await registerFailure("first-key", OPTS);
    for (let i = 0; i < 1000; i++) await registerFailure(`flood-${i}`, OPTS);
    // first-key's original bucket was evicted by the flood; fresh failures start
    // a new window — still under the max.
    for (let i = 0; i < OPTS.max - 1; i++) await registerFailure("first-key", OPTS);
    expect(await isThrottled("first-key", OPTS)).toBe(false);
  });

  it("keeps distinct keys independent", async () => {
    for (let i = 0; i < OPTS.max; i++) await registerFailure("key-a", OPTS);
    expect(await isThrottled("key-a", OPTS)).toBe(true);
    expect(await isThrottled("key-b", OPTS)).toBe(false);
  });
});

// ─── Redis path (TICKET-50: single-EVAL atomic registerFailure) ──────────────

// Fake @upstash/redis whose Redis.fromEnv() returns a stub with spyable
// eval/incr/expire. The counter module builds its client via Redis.fromEnv(),
// so this is the only way to drive its Redis branch without a live Upstash.
const evalMock = jest.fn(async () => 1);
const incrMock = jest.fn(async () => 1);
const expireMock = jest.fn(async () => 1);
jest.mock("@upstash/redis", () => ({
  Redis: {
    fromEnv: () => ({
      eval: (...a: unknown[]) => evalMock(...a),
      incr: (...a: unknown[]) => incrMock(...a),
      expire: (...a: unknown[]) => expireMock(...a),
    }),
  },
}));

describe("rate-limit-counter (redis EVAL path)", () => {
  beforeEach(() => {
    jest.resetModules();
    evalMock.mockClear();
    incrMock.mockClear();
    expireMock.mockClear();
    evalMock.mockImplementation(async () => 1);
    // Force the Redis path.
    process.env.STORE_DRIVER = "upstash";
    process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "faketoken";
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("registerFailure calls .eval once with the prefixed counter key", async () => {
    const { registerFailure: rf } = await import("@/lib/rate-limit-counter");
    await rf("login:198.51.100.1", { max: 5, windowMs: 60_000 });
    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, keys, args] = evalMock.mock.calls[0] as [
      string,
      string[],
      unknown[],
    ];
    expect(script).toMatch(/INCR/);
    expect(script).toMatch(/PEXPIRE/);
    expect(keys).toEqual(["rl:login:198.51.100.1"]);
    // TTL passed as whole milliseconds (PEXPIRE), not ceil-to-seconds.
    expect(args).toEqual([60_000]);
  });

  it("no longer uses the separate INCR + EXPIRE two-round-trip", async () => {
    const { registerFailure: rf } = await import("@/lib/rate-limit-counter");
    await rf("login:198.51.100.2", { max: 5, windowMs: 60_000 });
    expect(incrMock).not.toHaveBeenCalled();
    expect(expireMock).not.toHaveBeenCalled();
  });

  it("floors a sub-millisecond window to a positive TTL", async () => {
    const { registerFailure: rf } = await import("@/lib/rate-limit-counter");
    await rf("login:198.51.100.3", { max: 5, windowMs: 0.4 });
    const [, , args] = evalMock.mock.calls[0] as [string, string[], unknown[]];
    expect(args).toEqual([1]);
  });

  it("fails open when .eval throws (no-op, no throw to caller)", async () => {
    evalMock.mockImplementation(async () => {
      throw new Error("redis down");
    });
    const { registerFailure: rf } = await import("@/lib/rate-limit-counter");
    await expect(
      rf("login:198.51.100.4", { max: 5, windowMs: 60_000 }),
    ).resolves.toBeUndefined();
    expect(evalMock).toHaveBeenCalledTimes(1);
  });
});
