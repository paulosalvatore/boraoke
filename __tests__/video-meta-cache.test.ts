/**
 * Title cache (`vm:<videoId>`, lib/video-meta.ts): the memory L1 and the
 * production Redis path.
 *
 * Mirrors __tests__/embed-cache.test.ts. `@upstash/redis` is mocked with a
 * Map-backed fake, so a value written by `setCachedMeta` is read back only if
 * the write and the read agree on the key and the stored shape. Every
 * production submit goes through this cache; a broken round-trip would
 * silently turn each repeat submit into a live oEmbed call.
 */
import {
  getCachedMeta,
  setCachedMeta,
  _resetMetaCache,
  _resetMetaCacheClient,
  META_CACHE_TTL_MS,
  META_CACHE_MISSING_TTL_MS,
} from "@/lib/video-meta";

const ORIGINAL_ENV = { ...process.env };
const VIDEO_ID = "dQw4w9WgXcQ";
const META = { title: "Evidências (Karaokê)", channelTitle: "Karaokê BR", duration: "4:05" };

const redisData = new Map<string, unknown>();
const getMock = jest.fn(async (key: string): Promise<unknown> => redisData.get(key) ?? null);
const setMock = jest.fn(async (key: string, value: unknown): Promise<unknown> => {
  redisData.set(key, value);
  return "OK";
});
jest.mock("@upstash/redis", () => ({
  Redis: {
    fromEnv: () => ({
      get: (...a: unknown[]) => getMock(...(a as [string])),
      set: (...a: unknown[]) => setMock(...(a as [string, unknown])),
    }),
  },
}));

function useMemoryDriver() {
  delete process.env.UPSTASH_REDIS_REST_URL;
  process.env.STORE_DRIVER = "memory";
  _resetMetaCacheClient();
}

function useRedisDriver() {
  process.env.STORE_DRIVER = "upstash";
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "faketoken";
  _resetMetaCacheClient();
}

beforeEach(() => {
  redisData.clear();
  getMock.mockClear();
  setMock.mockClear();
  getMock.mockImplementation(async (key: string) => redisData.get(key) ?? null);
  setMock.mockImplementation(async (key: string, value: unknown) => {
    redisData.set(key, value);
    return "OK";
  });
  _resetMetaCache();
  useMemoryDriver();
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetMetaCacheClient();
  jest.useRealTimers();
});

describe("title cache TTL constants", () => {
  it("a found title lives 24 h, a definite 'missing' only 10 min", () => {
    expect(META_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(META_CACHE_MISSING_TTL_MS).toBe(10 * 60 * 1000);
  });
});

describe("title cache (memory L1, no Upstash)", () => {
  it("round-trips a title and never touches Redis", async () => {
    await setCachedMeta(VIDEO_ID, META);
    expect(await getCachedMeta(VIDEO_ID)).toEqual(META);
    expect(getMock).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
  });

  it("a found title outlives the 10 min window and expires after 24 h", async () => {
    jest.useFakeTimers();
    await setCachedMeta(VIDEO_ID, META);
    jest.advanceTimersByTime(META_CACHE_MISSING_TTL_MS + 60_000);
    expect(await getCachedMeta(VIDEO_ID)).toEqual(META);
    jest.advanceTimersByTime(META_CACHE_TTL_MS);
    expect(await getCachedMeta(VIDEO_ID)).toBeNull();
  });

  it("a 'missing' expires after 10 min, not 24 h", async () => {
    jest.useFakeTimers();
    await setCachedMeta(VIDEO_ID, "missing");
    jest.advanceTimersByTime(META_CACHE_MISSING_TTL_MS - 1_000);
    expect(await getCachedMeta(VIDEO_ID)).toBe("missing");
    jest.advanceTimersByTime(2_000);
    expect(await getCachedMeta(VIDEO_ID)).toBeNull();
  });

  it("an invalid id is a miss and a no-op, never a throw", async () => {
    await expect(setCachedMeta("not-an-id", META)).resolves.toBeUndefined();
    expect(await getCachedMeta("not-an-id")).toBeNull();
  });
});

describe("title cache (redis path)", () => {
  beforeEach(() => {
    useRedisDriver();
  });

  it("a miss GETs the vm:-prefixed key and returns null", async () => {
    expect(await getCachedMeta(VIDEO_ID)).toBeNull();
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith(`vm:${VIDEO_ID}`);
  });

  it("a found title is SET as {t,c,d} under vm:<id> with the 24 h px", async () => {
    await setCachedMeta(VIDEO_ID, META);
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith(
      `vm:${VIDEO_ID}`,
      { t: META.title, c: META.channelTitle, d: META.duration },
      { px: META_CACHE_TTL_MS },
    );
  });

  it("a 'missing' is SET as {missing:true} with the 10 min px", async () => {
    await setCachedMeta(VIDEO_ID, "missing");
    expect(setMock).toHaveBeenCalledWith(`vm:${VIDEO_ID}`, { missing: true }, { px: META_CACHE_MISSING_TTL_MS });
  });

  it("another instance (empty L1) reads back what this one stored", async () => {
    await setCachedMeta(VIDEO_ID, META);
    _resetMetaCache(); // a different serverless instance: no L1, same Redis
    expect(await getCachedMeta(VIDEO_ID)).toEqual(META);
    expect(getMock).toHaveBeenCalledWith(`vm:${VIDEO_ID}`);
  });

  it("another instance reads back a stored 'missing'", async () => {
    await setCachedMeta(VIDEO_ID, "missing");
    _resetMetaCache();
    expect(await getCachedMeta(VIDEO_ID)).toBe("missing");
  });

  it("a title with no channel or duration round-trips without inventing them", async () => {
    await setCachedMeta(VIDEO_ID, { title: "Só o título" });
    expect(setMock).toHaveBeenCalledWith(`vm:${VIDEO_ID}`, { t: "Só o título" }, { px: META_CACHE_TTL_MS });
    _resetMetaCache();
    expect(await getCachedMeta(VIDEO_ID)).toEqual({ title: "Só o título" });
  });

  it("a Redis hit warms L1: the next read makes no Redis call", async () => {
    redisData.set(`vm:${VIDEO_ID}`, { t: "Warm" });
    expect(await getCachedMeta(VIDEO_ID)).toEqual({ title: "Warm" });
    getMock.mockClear();
    expect(await getCachedMeta(VIDEO_ID)).toEqual({ title: "Warm" });
    expect(getMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a string", "garbage"],
    ["a number", 42],
    ["an array", ["t"]],
    ["a non-string title", { t: 42 }],
    ["an empty title", { t: "   " }],
    ["missing:'yes' (not literally true)", { missing: "yes" }],
  ])("a malformed stored value (%s) is a miss", async (_name, raw) => {
    redisData.set(`vm:${VIDEO_ID}`, raw);
    expect(await getCachedMeta(VIDEO_ID)).toBeNull();
  });

  it("re-cleans a stored value: control characters dropped, a bad duration ignored", async () => {
    redisData.set(`vm:${VIDEO_ID}`, { t: "A‮b", c: "Chan\u0000nel", d: "<script>" });
    expect(await getCachedMeta(VIDEO_ID)).toEqual({ title: "A b", channelTitle: "Chan nel" });
  });

  it("a Redis GET error fails open as a miss", async () => {
    getMock.mockImplementation(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(getCachedMeta(VIDEO_ID)).resolves.toBeNull();
  });

  it("a Redis SET error fails open, and this instance's L1 still answers", async () => {
    setMock.mockImplementation(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(setCachedMeta(VIDEO_ID, META)).resolves.toBeUndefined();
    getMock.mockClear();
    expect(await getCachedMeta(VIDEO_ID)).toEqual(META);
    expect(getMock).not.toHaveBeenCalled();
  });
});
