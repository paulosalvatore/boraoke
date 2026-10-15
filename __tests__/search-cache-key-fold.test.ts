/**
 * TICKET-135 — the search cache key folds accents, punctuation, NFC/NFD and the
 * position of "karaoke", so spelling variants of one question share one cache
 * entry (and one billed call). Google still receives the patron's original `q`.
 *
 * TICKET-136 — retention guard: nothing this cache stores may outlive the
 * 30-day YouTube API data limit the karaoke index enforces.
 *
 * The Data API is never contacted — fetch is stubbed.
 */
import type { NextRequest } from "next/server";

import { GET } from "@/app/api/search/route";
import { foldSearchKey, normalizeQuery } from "@/lib/search-prefix";
import { cacheKey, MEMORY_CACHE_TTL_MS, _resetCache, _resetRateLimit } from "@/lib/youtube-search";
import { SEARCH_CACHE_TTL_MS, SEARCH_CACHE_EMPTY_TTL_MS } from "@/lib/search-cache";
import { INDEX_MAX_AGE_MS } from "@/lib/karaoke-index/types";
import { _resetSearchBudget } from "@/lib/search-budget";
import { PRODUCTION_QUERIES, UNGRADABLE } from "../work/measurements/ticket-108/queries";

jest.mock("@/lib/live-search-gate", () => ({
  ...jest.requireActual("@/lib/live-search-gate"),
  liveCooldown: () => ({ ok: true }),
}));
jest.mock("@/lib/telemetry", () => ({ track: async () => {} }));
jest.mock("@/lib/karaoke-index/store", () => ({ getKaraokeIndex: async () => null }));

const DAY = 24 * 60 * 60 * 1000;
const ENV = { ...process.env };

describe("cacheKey folds spelling variants into one key (acceptance)", () => {
  it.each([
    [["maná", "mana", "Maná", "MANA"]],
    [["Cerol na Mão", "cerol na mao", "cerol  na   mão", "cerol na mão!"]],
    [["karaoke evidencias", "evidencias karaoke", "evidências karaokê", "Evidências, Karaokê", "KARAOKÊ evidências"]],
  ])("%j share one key", (variants) => {
    const keys = new Set(variants.map((v) => cacheKey(v, "BR")));
    expect(keys.size).toBe(1);
  });

  it("NFC and NFD spellings of the same text share one key", () => {
    const nfc = "Evidências".normalize("NFC");
    const nfd = "Evidências".normalize("NFD");
    expect(nfc).not.toBe(nfd); // the inputs really differ byte-wise
    expect(cacheKey(nfc, "BR")).toBe(cacheKey(nfd, "BR"));
  });

  it("moves karaoke to the end and keeps only one", () => {
    expect(cacheKey("karaoke evidencias", "BR")).toBe("BR::evidencias karaoke");
    expect(cacheKey("karaoke karaokê evidencias", "BR")).toBe("BR::evidencias karaoke");
    expect(foldSearchKey("karaoke")).toBe("karaoke");
  });

  it("keeps the pre-135 key for plain lowercase ASCII (most existing entries stay valid)", () => {
    expect(cacheKey("  Foo   Bar ", "BR")).toBe("BR::foo bar");
    expect(cacheKey("escurinho do cinema karaoke", "BR")).toBe("BR::escurinho do cinema karaoke");
  });
});

describe("cacheKey keeps different questions apart", () => {
  it("sing and listen mode still differ (the karaoke token stays in the key)", () => {
    expect(cacheKey("evidencias", "BR")).not.toBe(cacheKey("evidencias karaoke", "BR"));
  });

  it("karaoke inside a longer word is not the karaoke token", () => {
    expect(cacheKey("karaokestar", "BR")).not.toBe(cacheKey("star karaoke", "BR"));
  });

  it("region stays in the key", () => {
    expect(cacheKey("mana", "BR")).not.toBe(cacheKey("mana", "PT"));
  });

  it("non-Latin queries keep their letters (they must not all fold to one key)", () => {
    const qs = ["千本桜", "残酷な天使のテーゼ", "Кино", "Звезда", "사랑", "हम", "हमि", "Røyksopp", "Royksopp"];
    const keys = qs.map((q) => cacheKey(q, "BR"));
    expect(new Set(keys).size).toBe(qs.length);
    // ...and in sing mode, where every one of them ends in "karaoke".
    const sing = qs.map((q) => cacheKey(`${q} karaoke`, "BR"));
    expect(new Set(sing).size).toBe(qs.length);
    expect(sing).not.toContain("BR::karaoke");
  });

  it("digits are kept", () => {
    expect(cacheKey("evidencias 2", "BR")).not.toBe(cacheKey("evidencias 3", "BR"));
    expect(cacheKey("evidencias 2", "BR")).not.toBe(cacheKey("evidencias", "BR"));
  });

  it("a query with no letter or digit keeps its own pre-135 key instead of an empty one", () => {
    expect(foldSearchKey("???")).toBe("");
    expect(cacheKey("???", "BR")).toBe("BR::???");
    expect(cacheKey("???", "BR")).not.toBe(cacheKey("!!!", "BR"));
    expect(cacheKey("???", "BR")).not.toBe("BR::");
  });
});

describe("the uppercase page marker stays outside the folded part", () => {
  it("variants share a deep-page key too, with the cursor verbatim", () => {
    const a = cacheKey("maná karaokê", "BR", "CAoQAA");
    expect(a).toBe(cacheKey("karaoke mana", "BR", "CAoQAA"));
    expect(a).toBe("BR::P:CAoQAA::mana karaoke");
  });

  it("cursors that differ only by case stay different keys (the token is never folded)", () => {
    expect(cacheKey("mana", "BR", "CAoQAA")).not.toBe(cacheKey("mana", "BR", "caoqaa"));
  });

  it("a crafted query cannot forge a deep-page key", () => {
    const real = cacheKey("evidencias", "BR", "CURSOR2");
    for (const forged of ["P:CURSOR2::evidencias", "p:cursor2::evidencias", "P CURSOR2 evidencias", "P:CURSOR2:: evidencias"]) {
      expect(cacheKey(forged, "BR")).not.toBe(real);
      expect(cacheKey(forged, "BR")).not.toContain("P:");
    }
    // The fallback (no letters) can't carry a marker either.
    expect(cacheKey("::::", "BR")).not.toContain("P:");
  });
});

describe("the fold agrees with the karaoke index normaliser", () => {
  // normalizeQuery with the karaoke token moved to the end: the fold must be
  // exactly this for every real production string (all Latin script).
  function indexForm(q: string): string {
    const t = normalizeQuery(q).split(" ").filter(Boolean);
    const w = t.filter((x) => x !== "karaoke");
    if (w.length < t.length) w.push("karaoke");
    return w.join(" ");
  }
  const REAL = [...PRODUCTION_QUERIES.map((g) => g.q), ...UNGRADABLE];

  it.each(REAL)("%s", (q) => {
    expect(foldSearchKey(q)).toBe(indexForm(q));
  });

  it("two queries that share a fold also share the index form", () => {
    const sample = [...REAL, "Røyksopp", "Royksopp", "千本桜", "maná", "MANA"];
    for (const a of sample) {
      for (const b of sample) {
        if (foldSearchKey(a) === foldSearchKey(b)) expect(indexForm(a)).toBe(indexForm(b));
      }
    }
  });
});

describe("GET /api/search — Google gets the original query, the variant gets the cache", () => {
  function req(q: string, n: number): NextRequest {
    const uuid = `123e4567-e89b-42d3-a456-${String(n).padStart(12, "0")}`;
    return new Request(
      `http://127.0.0.1:3135/api/search?q=${encodeURIComponent(q)}&uuid=${uuid}&live=1`,
    ) as unknown as NextRequest;
  }
  let sent: string[];

  beforeEach(() => {
    _resetCache();
    _resetRateLimit();
    _resetSearchBudget();
    process.env.STORE_DRIVER = "memory";
    delete process.env.UPSTASH_REDIS_REST_URL;
    process.env.YOUTUBE_API_KEY = "FAKE_KEY";
    sent = [];
    global.fetch = (async (u: string) => {
      const url = new URL(String(u));
      if (url.pathname.endsWith("/search")) sent.push(url.searchParams.get("q") ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: [{ id: { videoId: "vMana00001" }, snippet: { title: "Maná", channelTitle: "c" } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    process.env = { ...ENV };
  });

  it("TICKET-136: a week-old cached cursor Google no longer accepts fails soft and is not cached", async () => {
    // Page 1 is served from a cache entry written days ago; its nextPageToken
    // has since expired on Google's side. Asking for page 2 must degrade, never
    // 500, and must not cache the failure (a later valid answer can land).
    let searchCalls = 0;
    global.fetch = (async (u: string) => {
      if (new URL(String(u)).pathname.endsWith("/search")) searchCalls++;
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { errors: [{ reason: "invalidPageToken" }] } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const deepReq = (n: number) =>
      new Request(
        `http://127.0.0.1:3135/api/search?q=mana&uuid=123e4567-e89b-42d3-a456-${String(n).padStart(12, "0")}&live=1&pageToken=OLDCURSOR&page=2`,
      ) as unknown as NextRequest;
    const res = await GET(deepReq(3));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ degraded: true, reason: "error", results: [] });
    // Not cached: the same page asked again goes back to Google.
    await GET(deepReq(4));
    expect(searchCalls).toBe(2);
  });

  it("the first variant bills with its own text; the second is a free cache hit", async () => {
    const first = await (await GET(req("Maná", 1))).json();
    expect(first.cached).toBeUndefined();
    expect(sent).toEqual(["Maná"]);

    const second = await (await GET(req("mana", 2))).json();
    expect(second.cached).toBe(true);
    expect(second.results.map((r: { videoId: string }) => r.videoId)).toEqual(["vMana00001"]);
    expect(sent).toEqual(["Maná"]); // no second call
  });
});

describe("TICKET-136 — cache TTLs and the 30-day retention ceiling", () => {
  it("non-empty pages live 7 days", () => {
    expect(SEARCH_CACHE_TTL_MS).toBe(7 * DAY);
  });

  it("empty pages stay at 10 minutes", () => {
    expect(SEARCH_CACHE_EMPTY_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("no cache tier keeps a page longer than the 30-day API data limit", () => {
    expect(INDEX_MAX_AGE_MS).toBe(30 * DAY);
    expect(SEARCH_CACHE_TTL_MS).toBeLessThanOrEqual(INDEX_MAX_AGE_MS);
    expect(SEARCH_CACHE_EMPTY_TTL_MS).toBeLessThanOrEqual(INDEX_MAX_AGE_MS);
    // A Redis hit re-warms the L1, so a page can live SEARCH_CACHE_TTL_MS plus
    // one L1 lifetime. That sum must also stay inside the limit.
    expect(SEARCH_CACHE_TTL_MS + MEMORY_CACHE_TTL_MS).toBeLessThanOrEqual(INDEX_MAX_AGE_MS);
  });
});
