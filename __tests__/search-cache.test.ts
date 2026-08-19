/**
 * Search-cache unit tests (TICKET-55) — MEMORY PATH + REDIS PATH.
 *
 * CI runs in memory mode (no Upstash env), mirroring the rate-limit-counter
 * tests. The memory block proves the no-Upstash fallback is the pre-existing
 * in-memory LRU (60s TTL) and that Redis is never touched. The Redis block
 * mocks `@upstash/redis` so `Redis.fromEnv()` yields a fake with spyable
 * get/set, and asserts: prefixed keys, the 12h non-empty vs 10min empty TTLs,
 * L1-before-Redis ordering, L1 warming on a Redis hit, corrupt-payload
 * rejection, and fail-open on every thrown Redis error.
 */
import {
  getCachedSearch,
  setCachedSearch,
  SEARCH_CACHE_TTL_MS,
  SEARCH_CACHE_EMPTY_TTL_MS,
} from "@/lib/search-cache";
import { cacheKey, _resetCache, type SearchResult } from "@/lib/youtube-search";

const ORIGINAL_ENV = { ...process.env };

const RESULTS: SearchResult[] = [
  {
    videoId: "aaaaaaaaaaa",
    title: "Evidências",
    channelTitle: "Chitãozinho & Xororó",
    duration: "4:13",
    thumbnailUrl: "https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg",
  },
];

// Fake @upstash/redis whose Redis.fromEnv() returns a stub with spyable
// get/set (same technique as rate-limit-counter.test.ts — the module builds
// its client via Redis.fromEnv(), so this is the only way to drive the Redis
// branch without a live Upstash).
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
  // Force the memory path regardless of ambient env.
  delete process.env.UPSTASH_REDIS_REST_URL;
  process.env.STORE_DRIVER = "memory";
  _resetCache();
  getMock.mockClear();
  setMock.mockClear();
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.useRealTimers();
});

describe("search-cache (memory fallback — no Upstash env)", () => {
  it("misses on an unknown key", async () => {
    expect(await getCachedSearch(cacheKey("evidencias", "BR"))).toBeNull();
  });

  it("set then get round-trips (miss populates, hit serves)", async () => {
    const key = cacheKey("evidencias", "BR");
    await setCachedSearch(key, RESULTS);
    expect(await getCachedSearch(key)).toEqual(RESULTS);
  });

  it("normalized keys share one entry (case + whitespace collapse)", async () => {
    await setCachedSearch(cacheKey("  Evidências   Ao Vivo ", "BR"), RESULTS);
    expect(
      await getCachedSearch(cacheKey("evidências ao vivo", "BR")),
    ).toEqual(RESULTS);
  });

  it("keeps the pre-existing 60s memory TTL (expired entry misses)", async () => {
    jest.useFakeTimers();
    const key = cacheKey("evidencias", "BR");
    await setCachedSearch(key, RESULTS);
    jest.advanceTimersByTime(59_000);
    expect(await getCachedSearch(key)).toEqual(RESULTS);
    jest.advanceTimersByTime(2_001); // past the 60s memory TTL
    expect(await getCachedSearch(key)).toBeNull();
  });

  it("never touches Redis on the memory path", async () => {
    const key = cacheKey("evidencias", "BR");
    await setCachedSearch(key, RESULTS);
    await getCachedSearch(key);
    await getCachedSearch(cacheKey("something else", "BR"));
    expect(getMock).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
  });
});

// ─── Redis path (mocked @upstash/redis; jest.resetModules per test) ──────────

describe("search-cache (redis path)", () => {
  beforeEach(() => {
    jest.resetModules();
    getMock.mockClear();
    setMock.mockClear();
    getMock.mockImplementation(async () => null);
    setMock.mockImplementation(async () => "OK");
    // Force the Redis path.
    process.env.STORE_DRIVER = "upstash";
    process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "faketoken";
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  /** Fresh module instances sharing one registry (search-cache + its L1). */
  async function freshModules() {
    const sc = await import("@/lib/search-cache");
    const ys = await import("@/lib/youtube-search");
    ys._resetCache();
    return { sc, ys };
  }

  it("miss: GETs the sc:-prefixed key and returns null", async () => {
    const { sc, ys } = await freshModules();
    const key = ys.cacheKey("evidencias", "BR");
    expect(await sc.getCachedSearch(key)).toBeNull();
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith("sc:BR::evidencias");
  });

  it("set (non-empty): SET with the sc: key and the 12h px TTL", async () => {
    const { sc, ys } = await freshModules();
    await sc.setCachedSearch(ys.cacheKey("evidencias", "BR"), RESULTS);
    expect(setMock).toHaveBeenCalledTimes(1);
    // TICKET-83: the stored payload is a PAGE ({ results, nextPageToken? }),
    // not a bare array, so a page's forward cursor is cached with its rows.
    expect(setMock).toHaveBeenCalledWith(
      "sc:BR::evidencias",
      { results: RESULTS },
      { px: SEARCH_CACHE_TTL_MS },
    );
    expect(SEARCH_CACHE_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });

  it("set (empty): cached with the short 10min px TTL", async () => {
    const { sc, ys } = await freshModules();
    await sc.setCachedSearch(ys.cacheKey("zxqjvw nothing", "BR"), []);
    expect(setMock).toHaveBeenCalledWith(
      "sc:BR::zxqjvw nothing",
      { results: [] },
      { px: SEARCH_CACHE_EMPTY_TTL_MS },
    );
    expect(SEARCH_CACHE_EMPTY_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("redis hit returns the payload and warms the memory L1 (second get skips Redis)", async () => {
    const { sc, ys } = await freshModules();
    getMock.mockImplementation(async () => RESULTS);
    const key = ys.cacheKey("evidencias", "BR");
    expect(await sc.getCachedSearch(key)).toEqual(RESULTS);
    expect(await sc.getCachedSearch(key)).toEqual(RESULTS);
    expect(getMock).toHaveBeenCalledTimes(1); // L1 answered the second call
  });

  it("a local set serves follow-up gets from the L1 without a Redis GET", async () => {
    const { sc, ys } = await freshModules();
    const key = ys.cacheKey("evidencias", "BR");
    await sc.setCachedSearch(key, RESULTS);
    expect(await sc.getCachedSearch(key)).toEqual(RESULTS);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("rejects a corrupt Redis payload as a miss", async () => {
    const { sc, ys } = await freshModules();
    getMock.mockImplementation(async () => ({ nonsense: true }));
    expect(await sc.getCachedSearch(ys.cacheKey("evidencias", "BR"))).toBeNull();
    getMock.mockImplementation(async () => [{ notAVideoId: 1 }]);
    expect(await sc.getCachedSearch(ys.cacheKey("outra busca", "BR"))).toBeNull();
  });

  it("fails open when GET throws (miss, no throw to caller)", async () => {
    const { sc, ys } = await freshModules();
    getMock.mockImplementation(async () => {
      throw new Error("redis down");
    });
    await expect(
      sc.getCachedSearch(ys.cacheKey("evidencias", "BR")),
    ).resolves.toBeNull();
  });

  it("fails open when SET throws (no throw; L1 still warmed)", async () => {
    const { sc, ys } = await freshModules();
    setMock.mockImplementation(async () => {
      throw new Error("redis down");
    });
    const key = ys.cacheKey("evidencias", "BR");
    await expect(sc.setCachedSearch(key, RESULTS)).resolves.toBeUndefined();
    // The per-instance L1 was written before the failed Redis SET.
    expect(await sc.getCachedSearch(key)).toEqual(RESULTS);
  });

  // ── TICKET-83: paged payloads ────────────────────────────────────────────
  it("stores a deep page under its OWN pageToken-scoped key", async () => {
    const { sc, ys } = await freshModules();
    await sc.setCachedSearchPage(ys.cacheKey("evidencias", "BR", "CURSOR_2"), {
      results: RESULTS,
      nextPageToken: "CURSOR_3",
    });
    expect(setMock).toHaveBeenCalledWith(
      "sc:BR::P:CURSOR_2::evidencias",
      { results: RESULTS, nextPageToken: "CURSOR_3" },
      { px: SEARCH_CACHE_TTL_MS },
    );
  });

  it("reads a page back with its cursor intact (paging back burns no quota)", async () => {
    const { sc, ys } = await freshModules();
    getMock.mockImplementation(async () => ({
      results: RESULTS,
      nextPageToken: "CURSOR_3",
    }));
    const hit = await sc.getCachedSearchPage(ys.cacheKey("evidencias", "BR", "CURSOR_2"));
    expect(hit?.results).toEqual(RESULTS);
    expect(hit?.nextPageToken).toBe("CURSOR_3");
  });

  it("still accepts a LEGACY bare-array entry written before TICKET-83", async () => {
    // Entries live for 12h; a deploy must not invalidate them (each one is
    // one of the platform's 100 daily searches that would otherwise be re-spent).
    const { sc, ys } = await freshModules();
    getMock.mockImplementation(async () => RESULTS);
    const hit = await sc.getCachedSearchPage(ys.cacheKey("evidencias", "BR"));
    expect(hit?.results).toEqual(RESULTS);
    expect(hit?.nextPageToken).toBeUndefined();
  });
});
