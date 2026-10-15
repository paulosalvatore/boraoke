import {
  boundedLevenshtein,
  FUZZY_Q,
  KaraokeIndex,
  MAX_FUZZY_TOKENS,
  MAX_QUERY_TOKENS,
  PREFIX_Q,
} from "@/lib/karaoke-index/matcher";
import {
  decideTier,
  GOOD_MATCH_THRESHOLD,
  INDEX_MORE_TOKEN,
  INDEX_RESULT_LIMIT,
  MIN_INDEX_QUERY_CHARS,
} from "@/lib/karaoke-index/tier";
import { INDEX_MAX_AGE_MS, isShardFresh, type ChannelShard } from "@/lib/karaoke-index/types";

const NOW = 1_800_000_000_000;

function shard(channelTitle: string, rows: [string, string][], harvestedAt = NOW): ChannelShard {
  return {
    v: 1,
    channelId: `UC${channelTitle.replace(/\W/g, "").padEnd(22, "x").slice(0, 22)}`,
    channelTitle,
    harvestedAt,
    rows: rows.map(([id, title]) => [id, title, "3:30"]),
  };
}

const INDEX = new KaraokeIndex([
  shard("Karaokê Club", [
    ["v-escurinho", "Escurinho do Cinema - Rita Lee (Karaokê)"],
    ["v-escuta", "Escuta Aqui - Banda X (Karaokê)"],
    ["v-medley", "Medley Rita Lee: Escurinho do Cinema, Lança Perfume, Mania de Você, Ovelha Negra"],
    ["v-gado", "Admirável Gado Novo - Zé Ramalho (Karaokê)"],
    ["v-soda", "Soda Stereo - De Música Ligera (Karaoke)"],
  ]),
  shard("Clubinho do Karaokê", [["v-evid", "Evidências - Chitãozinho e Xororó (Karaokê)"]]),
]);

describe("boundedLevenshtein", () => {
  it("computes small distances and bails past the bound", () => {
    expect(boundedLevenshtein("stete", "stereo", 2)).toBe(2);
    expect(boundedLevenshtein("onda", "onfs", 2)).toBe(2);
    expect(boundedLevenshtein("abc", "abcdefgh", 2)).toBe(3);
  });
});

describe("KaraokeIndex.search", () => {
  it("drops karaoke boilerplate and articles from the query", () => {
    expect(INDEX.search("escurinho do cinema karaoke").tokens).toEqual(["escurinho", "cinema"]);
  });

  it("exact full-coverage match scores 1.0 and the specific title outranks the medley", () => {
    const r = INDEX.search("escurinho do cinema karaoke");
    expect(r.confidence).toBe(1);
    expect(r.hits[0].video.videoId).toBe("v-escurinho");
    expect(r.hits.map((h) => h.video.videoId)).toContain("v-medley");
  });

  it("mid-word typing scores as a prefix match", () => {
    const r = INDEX.search("escurinho do cin karaoke");
    expect(r.confidence).toBeCloseTo((1 + PREFIX_Q) / 2);
    expect(r.hits[0].video.videoId).toBe("v-escurinho");
  });

  it("diacritics are folded on both sides", () => {
    expect(INDEX.search("evidencias karaoke").hits[0].video.videoId).toBe("v-evid");
    expect(INDEX.search("evidências karaoke").confidence).toBe(1);
  });

  it("typos fall back to bounded fuzzy matching at FUZZY_Q", () => {
    const r = INDEX.search("soda stete karaoke");
    expect(r.hits[0].video.videoId).toBe("v-soda");
    expect(r.confidence).toBeCloseTo((1 + FUZZY_Q) / 2);
  });

  it("matches title words in any order", () => {
    expect(INDEX.search("rita lee escurinho").hits[0].video.videoId).toBe("v-escurinho");
  });

  it("channel names never satisfy a query word (the 'brasil karaoke' collision)", () => {
    const idx = new KaraokeIndex([
      shard("Neon Karaokê Brasil", [
        ["v-pitty", "Pitty - Admirável Chip Novo (Karaokê)"],
        ["v-skank", "Skank - Garota Nacional (Karaokê)"],
      ]),
      shard("Karaokê Show Oficial", [["v-plain", "Karaokê"]]),
      shard("Karaokê Club", [["v-cazuza", "Brasil - Cazuza (Karaokê)"]]),
    ]);
    const brasil = idx.search("brasil karaoke");
    expect(brasil.hits.map((h) => h.video.videoId)).toEqual(["v-cazuza"]);
    // A word that appears ONLY in a channel name matches nothing at all.
    expect(idx.search("neon karaoke").hits).toEqual([]);
    expect(idx.search("show karaoke").hits).toEqual([]);
  });

  it("requires EVERY discriminating token: a missing word means confidence 0", () => {
    const r = INDEX.search("escurinho do sertao karaoke");
    expect(r.hits).toEqual([]);
    expect(r.confidence).toBe(0);
  });

  it("an empty index answers nothing", () => {
    expect(new KaraokeIndex([]).search("escurinho karaoke").confidence).toBe(0);
  });
});

describe("abuse bounds on attacker-controlled queries", () => {
  // A realistic-size vocabulary (~25k distinct words), so a full fuzzy scan
  // costs what it costs in production.
  const words: string[] = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const letters = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < 25_000; i++) {
    const len = 4 + Math.floor(rnd() * 7);
    words.push(Array.from({ length: len }, () => letters[Math.floor(rnd() * 26)]).join(""));
  }
  const big = new KaraokeIndex([
    shard(
      "Big",
      Array.from({ length: 5_000 }, (_, i) => [`v${i}`, words.slice(i * 5, i * 5 + 5).join(" ")] as [string, string]),
    ),
  ]);

  it("the security gate's crafted 18-word typo query is refused without scanning", () => {
    const q = "qzxv wqzx xqvz zvqx vzqw qwzv wvqz zqwv xzvq vxqz qzvw wxqv zxwq qvxz xwvz vwxq zwqx wqvx karaoke";
    expect(q.length).toBeLessThanOrEqual(100);
    const t0 = process.hrtime.bigint();
    const r = big.search(q);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(r.tokens.length).toBeGreaterThan(MAX_QUERY_TOKENS);
    expect(r.fuzzyScans).toBe(0);
    expect(r.hits).toEqual([]);
    expect(ms).toBeLessThan(25);
    expect(decideTier({ q, pageToken: "", index: big })).toEqual({ tier: "live", reason: "query-too-long" });
  });

  it("at most MAX_FUZZY_TOKENS fuzzy vocabulary scans per query, even when every word is a near-miss", () => {
    // 8 tokens that each fuzzy-match a real vocabulary word (one substituted
    // letter) but exact/prefix-match nothing — the worst case for scan cost,
    // since an unmatched token would otherwise end the search early.
    const typos: string[] = [];
    for (const w of words) {
      if (typos.length === MAX_QUERY_TOKENS) break;
      if (w.length < 7) continue;
      const t = w.slice(0, 3) + (w[3] === "z" ? "y" : "z") + w.slice(4);
      if (!words.some((v) => v.startsWith(t)) && !typos.includes(t)) typos.push(t);
    }
    expect(typos).toHaveLength(MAX_QUERY_TOKENS);
    const r = big.search(`${typos.join(" ")} karaoke`);
    expect(r.tokens).toHaveLength(MAX_QUERY_TOKENS);
    expect(r.fuzzyScans).toBe(MAX_FUZZY_TOKENS);
    expect(r.hits).toEqual([]); // the 3rd near-miss is not scanned, so the query goes live
  });
});

describe("decideTier — the good-match threshold and routing", () => {
  it("caps an index answer at INDEX_RESULT_LIMIT rows so 'load more' reaches live quickly", () => {
    const many = new KaraokeIndex([
      shard("Many", Array.from({ length: 60 }, (_, i) => [`v${i}`, `Evidências versão ${i}`] as [string, string])),
    ]);
    const d = decideTier({ q: "evidencias karaoke", pageToken: "", index: many });
    expect(d.tier === "index" && d.results.length).toBe(INDEX_RESULT_LIMIT);
  });

  it("serves a confident sing-mode first page from the index, with the escape cursor", () => {
    const d = decideTier({ q: "escurinho do cinema karaoke", pageToken: "", index: INDEX });
    expect(d.tier).toBe("index");
    if (d.tier !== "index") throw new Error("unreachable");
    expect(d.results[0]).toEqual({
      videoId: "v-escurinho",
      title: "Escurinho do Cinema - Rita Lee (Karaokê)",
      channelTitle: "Karaokê Club",
      duration: "3:30",
      thumbnailUrl: "https://i.ytimg.com/vi/v-escurinho/mqdefault.jpg",
    });
  });

  it("goes live below the threshold (a typo-only match is not trusted)", () => {
    const d = decideTier({ q: "soda stete karaoke", pageToken: "", index: INDEX });
    expect((1 + FUZZY_Q) / 2).toBeLessThan(GOOD_MATCH_THRESHOLD);
    expect(d).toEqual({ tier: "live", reason: "weak-match", confidence: (1 + FUZZY_Q) / 2 });
  });

  it("the threshold boundary is inclusive: confidence exactly at the threshold serves", () => {
    // Exactly one prefix-matched token: confidence === PREFIX_Q.
    const d = decideTier({ q: "escurinh karaoke", pageToken: "", index: INDEX, threshold: PREFIX_Q });
    expect(d.tier).toBe("index");
    const below = decideTier({ q: "escurinh karaoke", pageToken: "", index: INDEX, threshold: PREFIX_Q + 0.01 });
    expect(below.tier).toBe("live");
  });

  it("never answers listen/dance mode (no 'karaoke' in the query)", () => {
    expect(decideTier({ q: "escurinho do cinema", pageToken: "", index: INDEX })).toEqual({
      tier: "live",
      reason: "not-sing-mode",
    });
  });

  it("never answers deep pages; the escape cursor routes live", () => {
    expect(decideTier({ q: "evidencias karaoke", pageToken: "CDIQAA", index: INDEX })).toEqual({
      tier: "live",
      reason: "deep-page",
    });
    expect(decideTier({ q: "evidencias karaoke", pageToken: INDEX_MORE_TOKEN, index: INDEX })).toEqual({
      tier: "live",
      reason: "index-escape",
    });
  });

  it("queries shorter than MIN_INDEX_QUERY_CHARS discriminating chars go live", () => {
    const short = "escurinho".slice(0, MIN_INDEX_QUERY_CHARS - 1);
    expect(decideTier({ q: `${short} karaoke`, pageToken: "", index: INDEX })).toEqual({
      tier: "live",
      reason: "query-too-short",
    });
  });

  it("no index (unavailable / expired) means live", () => {
    expect(decideTier({ q: "evidencias karaoke", pageToken: "", index: null })).toEqual({
      tier: "live",
      reason: "index-unavailable",
    });
  });
});

describe("retention window", () => {
  it("a shard is fresh until INDEX_MAX_AGE_MS, then expired", () => {
    expect(isShardFresh({ harvestedAt: NOW }, NOW + INDEX_MAX_AGE_MS - 1)).toBe(true);
    expect(isShardFresh({ harvestedAt: NOW }, NOW + INDEX_MAX_AGE_MS)).toBe(false);
    expect(isShardFresh({ harvestedAt: NOW + 3_600_000 }, NOW)).toBe(false); // from the future = corrupt
    expect(isShardFresh({ harvestedAt: Number.NaN }, NOW)).toBe(false);
  });
});
