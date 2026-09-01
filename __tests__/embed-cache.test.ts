/**
 * Embed-cache unit tests (TICKET-95, MEDIUM-1 of the TICKET-67 cyber
 * follow-ups) — MEMORY-ONLY L1 PATH + REDIS PATH.
 *
 * Mirrors __tests__/search-cache.test.ts's structure: CI runs in memory mode
 * (no Upstash env), proving the L1-only path. The Redis block mocks
 * `@upstash/redis` so `Redis.fromEnv()` yields a fake with spyable get/set,
 * and asserts: prefixed keys, the 24h definitive vs 10min unknown TTL split,
 * L1-before-Redis ordering, L1 warming on a Redis hit, corrupt-payload
 * rejection, and fail-open on every thrown Redis error.
 */
import {
  getCachedEmbeddable,
  setCachedEmbeddable,
  _resetEmbedCache,
  _resetEmbedCacheClient,
  EMBED_CACHE_TTL_MS,
  EMBED_CACHE_UNKNOWN_TTL_MS,
} from "@/lib/embed-cache";

const ORIGINAL_ENV = { ...process.env };
const VIDEO_ID = "dQw4w9WgXcQ";
const VIDEO_ID_2 = "aaaaaaaaaaa";

const getMock = jest.fn(async (): Promise<unknown> => null);
const setMock = jest.fn(async (): Promise<unknown> => "OK");
jest.mock("@upstash/redis", () => ({
  Redis: {
    fromEnv: () => ({
      get: (...a: unknown[]) => getMock(...a),
      set: (...a: unknown[]) => setMock(...a),
    }),
  },
}));

beforeEach(() => {
  // Force the memory-only path regardless of ambient env.
  delete process.env.UPSTASH_REDIS_REST_URL;
  process.env.STORE_DRIVER = "memory";
  _resetEmbedCache();
  _resetEmbedCacheClient();
  getMock.mockClear();
  setMock.mockClear();
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.useRealTimers();
});

describe("embed-cache TTL constants", () => {
  it("definitive results get the long TTL, unknown gets the short TTL", () => {
    expect(EMBED_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(EMBED_CACHE_UNKNOWN_TTL_MS).toBe(10 * 60 * 1000);
    expect(EMBED_CACHE_UNKNOWN_TTL_MS).toBeLessThan(EMBED_CACHE_TTL_MS);
  });
});

describe("embed-cache (memory-only L1 — no Upstash env)", () => {
  it("misses on an unknown videoId", async () => {
    expect(await getCachedEmbeddable(VIDEO_ID)).toBeNull();
  });

  it("set then get round-trips for a definitive verdict", async () => {
    await setCachedEmbeddable(VIDEO_ID, "embeddable");
    expect(await getCachedEmbeddable(VIDEO_ID)).toBe("embeddable");
  });

  it("set then get round-trips for 'not-embeddable'", async () => {
    await setCachedEmbeddable(VIDEO_ID, "not-embeddable");
    expect(await getCachedEmbeddable(VIDEO_ID)).toBe("not-embeddable");
  });

  it("set then get round-trips for 'unknown'", async () => {
    await setCachedEmbeddable(VIDEO_ID, "unknown");
    expect(await getCachedEmbeddable(VIDEO_ID)).toBe("unknown");
  });

  it("distinct videoIds get distinct entries", async () => {
    await setCachedEmbeddable(VIDEO_ID, "embeddable");
    await setCachedEmbeddable(VIDEO_ID_2, "not-embeddable");
    expect(await getCachedEmbeddable(VIDEO_ID)).toBe("embeddable");
    expect(await getCachedEmbeddable(VIDEO_ID_2)).toBe("not-embeddable");
  });

  it("returns null (miss) for an invalid videoId, never throws", async () => {
    expect(await getCachedEmbeddable("not-a-valid-id")).toBeNull();
    await expect(setCachedEmbeddable("not-a-valid-id", "embeddable")).resolves.toBeUndefined();
  });

  it("a definitive verdict survives past the short unknown TTL window", async () => {
    jest.useFakeTimers();
    await setCachedEmbeddable(VIDEO_ID, "embeddable");
    jest.advanceTimersByTime(EMBED_CACHE_UNKNOWN_TTL_MS + 60_000);
    expect(await getCachedEmbeddable(VIDEO_ID)).toBe("embeddable");
  });

  it("a definitive verdict expires after its 24h TTL", async () => {
    jest.useFakeTimers();
    await setCachedEmbeddable(VIDEO_ID, "not-embeddable");
    jest.advanceTimersByTime(EMBED_CACHE_TTL_MS - 1_000);
    expect(await getCachedEmbeddable(VIDEO_ID)).toBe("not-embeddable");
    jest.advanceTimersByTime(2_000); // past the 24h TTL
    expect(await getCachedEmbeddable(VIDEO_ID)).toBeNull();
  });

  it("an 'unknown' verdict expires after its short 10min TTL (not pinned)", async () => {
    jest.useFakeTimers();
    await setCachedEmbeddable(VIDEO_ID, "unknown");
    jest.advanceTimersByTime(EMBED_CACHE_UNKNOWN_TTL_MS - 1_000);
    expect(await getCachedEmbeddable(VIDEO_ID)).toBe("unknown");
    jest.advanceTimersByTime(2_000); // past the 10min TTL
    expect(await getCachedEmbeddable(VIDEO_ID)).toBeNull();
  });

  it("never touches Redis on the memory-only path", async () => {
    await setCachedEmbeddable(VIDEO_ID, "embeddable");
    await getCachedEmbeddable(VIDEO_ID);
    await getCachedEmbeddable(VIDEO_ID_2);
    expect(getMock).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
  });
});

// ─── Redis path (mocked @upstash/redis) ───────────────────────────────────

describe("embed-cache (redis path)", () => {
  beforeEach(() => {
    getMock.mockClear();
    setMock.mockClear();
    getMock.mockImplementation(async () => null);
    setMock.mockImplementation(async () => "OK");
    process.env.STORE_DRIVER = "upstash";
    process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "faketoken";
    _resetEmbedCacheClient();
    _resetEmbedCache();
  });

  it("miss: GETs the ec:-prefixed key and returns null", async () => {
    expect(await getCachedEmbeddable(VIDEO_ID)).toBeNull();
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith(`ec:${VIDEO_ID}`);
  });

  it("set (definitive): SET with the ec: key and the 24h px TTL", async () => {
    await setCachedEmbeddable(VIDEO_ID, "embeddable");
    expect(setMock).toHaveBeenCalledWith(`ec:${VIDEO_ID}`, "embeddable", {
      px: EMBED_CACHE_TTL_MS,
    });
  });

  it("set (not-embeddable): also gets the 24h px TTL", async () => {
    await setCachedEmbeddable(VIDEO_ID, "not-embeddable");
    expect(setMock).toHaveBeenCalledWith(`ec:${VIDEO_ID}`, "not-embeddable", {
      px: EMBED_CACHE_TTL_MS,
    });
  });

  it("set (unknown): gets the short 10min px TTL", async () => {
    await setCachedEmbeddable(VIDEO_ID, "unknown");
    expect(setMock).toHaveBeenCalledWith(`ec:${VIDEO_ID}`, "unknown", {
      px: EMBED_CACHE_UNKNOWN_TTL_MS,
    });
  });

  it("redis hit returns the verdict and warms the L1 (second get skips Redis)", async () => {
    getMock.mockImplementation(async () => "embeddable");
    expect(await getCachedEmbeddable(VIDEO_ID)).toBe("embeddable");
    expect(await getCachedEmbeddable(VIDEO_ID)).toBe("embeddable");
    expect(getMock).toHaveBeenCalledTimes(1); // L1 answered the second call
  });

  it("a local set serves follow-up gets from the L1 without a Redis GET", async () => {
    await setCachedEmbeddable(VIDEO_ID, "not-embeddable");
    expect(await getCachedEmbeddable(VIDEO_ID)).toBe("not-embeddable");
    expect(getMock).not.toHaveBeenCalled();
  });

  it("rejects a corrupt Redis payload as a miss", async () => {
    getMock.mockImplementation(async () => ({ nonsense: true }));
    expect(await getCachedEmbeddable(VIDEO_ID)).toBeNull();
    getMock.mockImplementation(async () => "not-a-real-status");
    expect(await getCachedEmbeddable(VIDEO_ID_2)).toBeNull();
  });

  it("fails open when GET throws (miss, no throw to caller)", async () => {
    getMock.mockImplementation(async () => {
      throw new Error("redis down");
    });
    await expect(getCachedEmbeddable(VIDEO_ID)).resolves.toBeNull();
  });

  it("fails open when SET throws (no throw; L1 still warmed)", async () => {
    setMock.mockImplementation(async () => {
      throw new Error("redis down");
    });
    await expect(setCachedEmbeddable(VIDEO_ID, "embeddable")).resolves.toBeUndefined();
    // The per-instance L1 was written before the failed Redis SET.
    expect(await getCachedEmbeddable(VIDEO_ID)).toBe("embeddable");
    // Only ONE GET (the assertion above) — no extra Redis round-trip from the
    // failed SET itself.
    expect(getMock).not.toHaveBeenCalled();
  });
});
