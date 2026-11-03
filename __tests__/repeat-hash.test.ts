/**
 * Salted hashes for the cross-day repeat measurement: stability across
 * spelling variants, operator separation, missing-salt behaviour, and that the
 * live search route and the queue route actually emit the fields.
 */
import { GET } from "@/app/api/search/route";
import { POST as queuePost } from "@/app/api/queue/route";
import { cacheKey, _resetCache, _resetRateLimit } from "@/lib/youtube-search";
import { _resetSearchBudget } from "@/lib/search-budget";
import { hashCacheKey, hashVideoId, REPEAT_HASH_HEX_LENGTH, REPEAT_HASH_SALT_ENV } from "@/lib/repeat-hash";
import { telemetryStore } from "@/lib/telemetry-store";
import { store } from "@/lib/store";
import { NextRequest } from "next/server";

jest.mock("@/lib/live-search-gate", () => ({
  ...jest.requireActual("@/lib/live-search-gate"),
  liveCooldown: () => ({ ok: true }),
}));
jest.mock("@/lib/karaoke-index/store", () => ({ getKaraokeIndex: async () => null }));

const SALT_BACKUP = process.env[REPEAT_HASH_SALT_ENV];
const KEY_BACKUP = process.env.YOUTUBE_API_KEY;
const setSalt = (v: string | undefined) => {
  if (v === undefined) delete process.env[REPEAT_HASH_SALT_ENV];
  else process.env[REPEAT_HASH_SALT_ENV] = v;
};
const keyHash = (q: string) => hashCacheKey(cacheKey(q, "BR"));

beforeEach(() => setSalt("salt-one"));
afterAll(() => {
  setSalt(SALT_BACKUP);
  if (KEY_BACKUP === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = KEY_BACKUP;
});

describe("key hash follows the folded cache key", () => {
  it.each([
    [["maná", "mana", "MANA"]],
    [["Cerol na Mão", "cerol na mao"]],
    [["karaoke evidencias", "evidências karaokê"]],
  ])("%j share one hash", (variants) => {
    const hashes = new Set(variants.map(keyHash));
    expect(hashes.size).toBe(1);
    expect([...hashes][0]).toMatch(new RegExp(`^[0-9a-f]{${REPEAT_HASH_HEX_LENGTH}}$`));
  });

  it("operator forms hash differently from the plain form", () => {
    const plain = keyHash("evidencias karaoke");
    for (const q of ["evidencias -karaoke", "evidencias | karaoke", '"evidencias" karaoke']) {
      expect(keyHash(q)).not.toBe(plain);
    }
  });

  it("different songs and regions hash differently", () => {
    expect(keyHash("mana")).not.toBe(keyHash("evidencias"));
    expect(hashCacheKey(cacheKey("mana", "BR"))).not.toBe(hashCacheKey(cacheKey("mana", "PT")));
  });

  it("a key and a video id never share a hash for the same string", () => {
    expect(hashCacheKey("dQw4w9WgXcQ")).not.toBe(hashVideoId("dQw4w9WgXcQ"));
  });
});

describe("salt handling", () => {
  it("omits the hash when the salt is missing or blank, and never throws", () => {
    for (const v of [undefined, "", "   "]) {
      setSalt(v);
      expect(hashCacheKey("BR::mana")).toBeUndefined();
      expect(hashVideoId("dQw4w9WgXcQ")).toBeUndefined();
    }
  });

  it("different salts give different hashes, the same salt is stable", () => {
    setSalt("salt-one");
    const a = hashVideoId("dQw4w9WgXcQ");
    expect(hashVideoId("dQw4w9WgXcQ")).toBe(a);
    setSalt("salt-two");
    expect(hashVideoId("dQw4w9WgXcQ")).not.toBe(a);
    expect(keyHash("mana")).not.toBe((setSalt("salt-one"), keyHash("mana")));
  });

  it("the hash does not contain the raw value", () => {
    expect(hashVideoId("dQw4w9WgXcQ")).not.toContain("dQw4");
  });
});

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const flush = () => new Promise((r) => setTimeout(r, 0));
const TODAY = () => new Date().toISOString().slice(0, 10);

describe("routes emit the fields", () => {
  const realFetch = global.fetch;
  beforeEach(async () => {
    _resetCache();
    _resetRateLimit();
    _resetSearchBudget();
    await telemetryStore.clear();
    await store.clear("default");
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    global.fetch = (async (url: string) =>
      url.includes("/search")
        ? okJson({ items: [{ id: { videoId: "aaaaaaaaaaa" }, snippet: { title: "t", channelTitle: "c", thumbnails: { medium: { url: "u" } } } }] })
        : okJson({ items: [{ id: "aaaaaaaaaaa", contentDetails: { duration: "PT4M13S" } }] })) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  const search = (q: string, uuid = UUID) =>
    GET(new Request(`http://127.0.0.1:3040/api/search?q=${encodeURIComponent(q)}&uuid=${uuid}&live=1`) as unknown as NextRequest);
  const searchEvents = async () =>
    (await telemetryStore.listRange(TODAY(), TODAY())).filter((e) => e.event === "search_performed");

  it("a live search carries keyHash; the folded variant served from cache does not bill or hash", async () => {
    await search("maná");
    await flush();
    const [live] = await searchEvents();
    expect(live.props).toMatchObject({ source: "live", keyHash: keyHash("mana") });

    await search("mana", "123e4567-e89b-42d3-a456-426614174001");
    await flush();
    const cached = (await searchEvents()).filter((e) => e.props?.source === "cache");
    expect(cached).toHaveLength(1);
    expect(cached[0].props).not.toHaveProperty("keyHash");
  });

  it("without a salt the live event is exactly as before", async () => {
    setSalt(undefined);
    await search("maná");
    await flush();
    const [live] = await searchEvents();
    expect(live.props).toEqual({ results: 1, source: "live" });
  });

  it("song_queued carries videoHash, and omits it without a salt", async () => {
    const queue = () =>
      queuePost(
        new NextRequest("http://127.0.0.1:3012/api/queue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ videoId: "dQw4w9WgXcQ", nickname: "Ana", patronUuid: UUID, mode: "sing", room: "default" }),
        }),
      );
    expect((await queue()).status).toBe(201);
    await flush();
    let [e] = (await telemetryStore.listRange(TODAY(), TODAY())).filter((x) => x.event === "song_queued");
    expect(e.props).toMatchObject({ kind: "search", mode: "sing", videoHash: hashVideoId("dQw4w9WgXcQ") });

    await telemetryStore.clear();
    await store.clear("default");
    setSalt(undefined);
    expect((await queue()).status).toBe(201);
    await flush();
    [e] = (await telemetryStore.listRange(TODAY(), TODAY())).filter((x) => x.event === "song_queued");
    expect(e.props).toEqual({ kind: "search", mode: "sing" });
  });
});
