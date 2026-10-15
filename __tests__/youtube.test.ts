import { parseYouTubeVideoId, looksLikeBareVideoId, MAX_PARSE_INPUT } from "@/lib/youtube";
import {
  checkEmbeddable,
  fetchVideoDetails,
  fetchOEmbed,
  cleanMetaText,
  formatDuration,
  videoApiKey,
  EMBEDDABLE_CHECK_TIMEOUT_MS,
  OEMBED_TIMEOUT_MS,
} from "@/lib/youtube-server";

describe("parseYouTubeVideoId", () => {
  const VALID_ID = "dQw4w9WgXcQ";

  describe("raw video IDs", () => {
    it("accepts a valid 11-char raw video ID", () => {
      expect(parseYouTubeVideoId(VALID_ID)).toBe(VALID_ID);
    });

    it("rejects IDs shorter than 11 chars", () => {
      expect(parseYouTubeVideoId("short")).toBeNull();
    });

    it("rejects IDs longer than 11 chars", () => {
      expect(parseYouTubeVideoId("dQw4w9WgXcQQ")).toBeNull();
    });
  });

  describe("watch URLs", () => {
    it("parses standard watch URL", () => {
      expect(parseYouTubeVideoId(`https://www.youtube.com/watch?v=${VALID_ID}`)).toBe(VALID_ID);
    });

    it("parses watch URL without www", () => {
      expect(parseYouTubeVideoId(`https://youtube.com/watch?v=${VALID_ID}`)).toBe(VALID_ID);
    });

    it("parses watch URL with extra query params", () => {
      expect(parseYouTubeVideoId(`https://www.youtube.com/watch?v=${VALID_ID}&t=42s&list=PL123`)).toBe(VALID_ID);
    });
  });

  describe("youtu.be short URLs", () => {
    it("parses youtu.be short URL", () => {
      expect(parseYouTubeVideoId(`https://youtu.be/${VALID_ID}`)).toBe(VALID_ID);
    });

    it("parses youtu.be URL with query params", () => {
      expect(parseYouTubeVideoId(`https://youtu.be/${VALID_ID}?t=30`)).toBe(VALID_ID);
    });
  });

  describe("embed / shorts / live URLs", () => {
    it("parses embed URL", () => {
      expect(parseYouTubeVideoId(`https://www.youtube.com/embed/${VALID_ID}`)).toBe(VALID_ID);
    });

    it("parses shorts URL", () => {
      expect(parseYouTubeVideoId(`https://www.youtube.com/shorts/${VALID_ID}`)).toBe(VALID_ID);
    });

    it("parses live URL", () => {
      expect(parseYouTubeVideoId(`https://www.youtube.com/live/${VALID_ID}`)).toBe(VALID_ID);
    });
  });

  describe("mobile URLs", () => {
    it("parses m.youtube.com watch URL", () => {
      expect(parseYouTubeVideoId(`https://m.youtube.com/watch?v=${VALID_ID}`)).toBe(VALID_ID);
    });
  });

  describe("invalid inputs", () => {
    it("returns null for empty string", () => {
      expect(parseYouTubeVideoId("")).toBeNull();
    });

    it("returns null for a random string", () => {
      expect(parseYouTubeVideoId("not a url at all!!!")).toBeNull();
    });

    it("returns null for a non-YouTube URL", () => {
      expect(parseYouTubeVideoId("https://vimeo.com/123456789")).toBeNull();
    });

    it("returns null for a watch URL with missing v param", () => {
      expect(parseYouTubeVideoId("https://www.youtube.com/watch?list=PL123")).toBeNull();
    });
  });
});

/* ------------------------------------------------------------------------- *
 * TICKET-61 — embeddability pre-check (checkEmbeddable)
 *
 * Every case here mocks the YouTube Data API; nothing ever touches the network
 * (no key exists in dev/CI anyway). The contract under test is: exactly one
 * verdict says "not-embeddable", everything else fails open to "unknown".
 * ------------------------------------------------------------------------- */

const VALID_ID = "dQw4w9WgXcQ";
const KEY = "test-key";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function statusPayload(embeddable: boolean) {
  return { items: [{ id: VALID_ID, status: { embeddable } }] };
}

describe("checkEmbeddable (TICKET-61)", () => {
  it("returns 'embeddable' when status.embeddable is true", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(statusPayload(true)));
    await expect(
      checkEmbeddable(VALID_ID, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBe("embeddable");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns 'not-embeddable' when status.embeddable is false", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(statusPayload(false)));
    await expect(
      checkEmbeddable(VALID_ID, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBe("not-embeddable");
  });

  it("calls videos.list ONCE with part=status,snippet,contentDetails and the id/key as query params (1 quota unit)", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(statusPayload(true)));
    await checkEmbeddable(VALID_ID, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const url = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/youtube/v3/videos");
    expect(url.searchParams.get("part")).toBe("status,snippet,contentDetails");
    expect(url.searchParams.get("id")).toBe(VALID_ID);
    expect(url.searchParams.get("key")).toBe(KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  describe("fail-open cases (never throw, never warn)", () => {
    it("returns 'unknown' when no API key is configured", async () => {
      const fetchImpl = jest.fn();
      await expect(
        checkEmbeddable(VALID_ID, undefined, { fetchImpl: fetchImpl as unknown as typeof fetch }),
      ).resolves.toBe("unknown");
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("returns 'unknown' (and makes no call) for an invalid video id", async () => {
      const fetchImpl = jest.fn();
      await expect(
        checkEmbeddable("not-an-id", KEY, { fetchImpl: fetchImpl as unknown as typeof fetch }),
      ).resolves.toBe("unknown");
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("returns 'unknown' on quota exhaustion (403 quotaExceeded)", async () => {
      const fetchImpl = jest.fn(async () =>
        jsonResponse({ error: { errors: [{ reason: "quotaExceeded" }] } }, 403),
      );
      await expect(
        checkEmbeddable(VALID_ID, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch }),
      ).resolves.toBe("unknown");
    });

    it("returns 'unknown' on a 5xx API error", async () => {
      const fetchImpl = jest.fn(async () => jsonResponse({}, 500));
      await expect(
        checkEmbeddable(VALID_ID, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch }),
      ).resolves.toBe("unknown");
    });

    it("returns 'unknown' when the request throws (network error / abort timeout)", async () => {
      const fetchImpl = jest.fn(async () => {
        throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
      });
      await expect(
        checkEmbeddable(VALID_ID, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch }),
      ).resolves.toBe("unknown");
    });

    it("returns 'unknown' on malformed JSON", async () => {
      const fetchImpl = jest.fn(async () =>
        ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } }) as unknown as Response,
      );
      await expect(
        checkEmbeddable(VALID_ID, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch }),
      ).resolves.toBe("unknown");
    });

    it("returns 'unknown' for an empty items array (deleted/private video)", async () => {
      const fetchImpl = jest.fn(async () => jsonResponse({ items: [] }));
      await expect(
        checkEmbeddable(VALID_ID, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch }),
      ).resolves.toBe("unknown");
    });
  });

  it("aborts the call with a bounded timeout signal", async () => {
    let sawSignal = false;
    const fetchImpl = jest.fn(async (_url: string, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return jsonResponse(statusPayload(true));
    });
    await checkEmbeddable(VALID_ID, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(sawSignal).toBe(true);
    expect(EMBEDDABLE_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });
});

/* ------------------------------------------------------------------------- *
 * TICKET-140 — paste-a-link gaps
 * ------------------------------------------------------------------------- */

describe("TICKET-140 gap 1: an 11-letter word is not a video id", () => {
  // Typed words: each is exactly 11 valid id characters and was taken as an
  // id by the old parser, so search never ran.
  const WORDS = [
    "Imagination",
    "Bittersweet",
    "Unbreakable",
    "imagination",
    "UNBREAKABLE",
    "rock-n-roll",
    "hip-hop-pop",
  ];
  it.each(WORDS)("%s is searched, not taken as an id", (w) => {
    expect(w).toHaveLength(11);
    expect(parseYouTubeVideoId(w)).toBeNull();
    expect(looksLikeBareVideoId(w)).toBe(false);
  });

  // Real-shaped ids still resolve bare: a digit, an underscore, or mixed case.
  const IDS = ["dQw4w9WgXcQ", "kJQP7kiw5Fk", "abc_defghij", "fJ9rUzIMcZQ", "aBcDeFgHiJk", "-abcdef1hij"];
  it.each(IDS)("%s is still accepted as a bare id", (id) => {
    expect(parseYouTubeVideoId(id)).toBe(id);
  });

  it("a word-shaped id still resolves when pasted as a link (URLs skip the heuristic)", () => {
    expect(parseYouTubeVideoId("https://youtu.be/Imagination")).toBe("Imagination");
    expect(parseYouTubeVideoId("https://www.youtube.com/watch?v=Bittersweet")).toBe("Bittersweet");
  });
});

describe("TICKET-140 gap 2: more URL forms (table-driven)", () => {
  const ID = "dQw4w9WgXcQ";
  const ACCEPT: Array<[string, string]> = [
    ["music.youtube.com watch", `https://music.youtube.com/watch?v=${ID}&feature=share`],
    ["youtube-nocookie embed", `https://www.youtube-nocookie.com/embed/${ID}`],
    ["youtube-nocookie embed, no www", `https://youtube-nocookie.com/embed/${ID}?start=10`],
    ["upper-case scheme + host", `HTTPS://YOUTU.BE/${ID}`],
    ["upper-case host on watch", `https://WWW.YOUTUBE.COM/watch?v=${ID}`],
    ["mixed-case scheme", `Https://www.youtube.com/watch?v=${ID}`],
    ["youtu.be trailing slash", `https://youtu.be/${ID}/`],
    ["youtu.be trailing slash + si", `https://youtu.be/${ID}/?si=abc`],
    ["share text, pt-BR", `olha esse https://youtu.be/${ID} 🔥`],
    ["share text, link first", `https://www.youtube.com/watch?v=${ID} canta essa`],
    ["share text, parenthesised", `(https://youtu.be/${ID})`],
    ["share text, trailing comma", `vai: https://youtu.be/${ID}, bora`],
    ["share text, newline", `Assista no YouTube:\nhttps://youtu.be/${ID}?si=x`],
    // Already-supported forms must keep working.
    ["watch, v not first", `https://www.youtube.com/watch?feature=x&v=${ID}&t=42s`],
    ["m.youtube.com", `https://m.youtube.com/watch?v=${ID}`],
    ["youtu.be with si and t", `https://youtu.be/${ID}?si=AbC&t=30`],
    ["shorts", `https://youtube.com/shorts/${ID}`],
    ["live", `https://www.youtube.com/live/${ID}`],
    ["/v/", `https://www.youtube.com/v/${ID}`],
    ["scheme-less", `youtube.com/watch?v=${ID}`],
  ];
  it.each(ACCEPT)("accepts %s", (_name, input) => {
    expect(parseYouTubeVideoId(input)).toBe(ID);
  });

  const REFUSE: Array<[string, string]> = [
    ["look-alike suffix host", `https://youtube.com.evil.com/watch?v=${ID}`],
    ["look-alike youtu.be suffix", `https://youtu.be.evil.com/${ID}`],
    ["host in path", `https://evil.com/youtube.com/watch?v=${ID}`],
    ["userinfo trick", `https://youtube.com@evil.com/watch?v=${ID}`],
    ["nocookie look-alike", `https://youtube-nocookie.com.evil.com/embed/${ID}`],
    ["non-http scheme", `javascript://youtube.com/watch?v=${ID}`],
    ["ftp scheme", `ftp://youtu.be/${ID}`],
    ["embed id with trailing junk", `https://www.youtube.com/embed/${ID}x`],
    ["youtu.be extra segment", `https://youtu.be/${ID}/extra`],
    ["embed id with an extra path segment", `https://www.youtube.com/embed/${ID}/extra`],
    ["shorts id with an extra path segment", `https://youtube.com/shorts/${ID}/x/y`],
    ["nocookie watch path (not an embed)", `https://www.youtube-nocookie.com/watch?v=${ID}`],
    ["share text with only a look-alike", `olha https://youtube.com.evil.com/watch?v=${ID}`],
    ["share text with a bare id, no link", `olha ${ID} essa`],
  ];
  it.each(REFUSE)("refuses %s", (_name, input) => {
    expect(parseYouTubeVideoId(input)).toBeNull();
  });
});

describe("TICKET-140 gap 3: fetchVideoDetails returns title/channel/duration from the same call", () => {
  it("maps snippet + contentDetails into meta", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        items: [
          {
            id: VALID_ID,
            status: { embeddable: true },
            snippet: { title: "Never Gonna Give You Up", channelTitle: "Rick Astley" },
            contentDetails: { duration: "PT3M33S" },
          },
        ],
      }),
    );
    const d = await fetchVideoDetails(VALID_ID, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(d).toEqual({
      status: "embeddable",
      meta: { title: "Never Gonna Give You Up", channelTitle: "Rick Astley", duration: "3:33" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ignores an answer about a different video", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ items: [{ id: "otherVideo1", status: { embeddable: false } }] }),
    );
    const d = await fetchVideoDetails(VALID_ID, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(d).toEqual({ status: "unknown" });
  });
});

describe("TICKET-140 gap 3: fetchOEmbed (keyless title lookup)", () => {
  it("returns title + channel on 200, via a fixed host and URLSearchParams", async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ title: "Bohemian Rhapsody (Karaoke)", author_name: "Sing King" }),
    );
    const r = await fetchOEmbed(VALID_ID, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r).toEqual({
      kind: "found",
      meta: { title: "Bohemian Rhapsody (Karaoke)", channelTitle: "Sing King" },
    });
    const [u, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(u);
    expect(url.pathname).toBe("/oembed");
    expect(url.searchParams.get("url")).toBe(`https://www.youtube.com/watch?v=${VALID_ID}`);
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("key")).toBeNull(); // no key, no quota
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(OEMBED_TIMEOUT_MS).toBeLessThanOrEqual(1500);
  });

  it.each([400, 401, 403, 404])("HTTP %i is a definite 'missing'", async (status) => {
    const fetchImpl = jest.fn(async () => jsonResponse({}, status));
    await expect(fetchOEmbed(VALID_ID, { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toEqual({
      kind: "missing",
    });
  });

  it("5xx, a throw (timeout) and a payload with no title are transient errors", async () => {
    const f5 = jest.fn(async () => jsonResponse({}, 503));
    const fThrow = jest.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    });
    const fEmpty = jest.fn(async () => jsonResponse({ author_name: "x" }));
    for (const f of [f5, fThrow, fEmpty]) {
      await expect(fetchOEmbed(VALID_ID, { fetchImpl: f as unknown as typeof fetch })).resolves.toEqual({
        kind: "error",
      });
    }
  });

  it("never puts an invalid id in a URL", async () => {
    const fetchImpl = jest.fn();
    await expect(
      fetchOEmbed("x&url=evil", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ kind: "missing" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("TICKET-140: cleanMetaText", () => {
  it("strips control and bidi characters, collapses whitespace and caps length", () => {
    expect(cleanMetaText("  a\u0000b\u202Ec\n\td  ", 50)).toBe("a b c d");
    expect(cleanMetaText("x".repeat(200), 10)).toHaveLength(10);
    expect(cleanMetaText(42, 10)).toBeUndefined();
    expect(cleanMetaText("   ", 10)).toBeUndefined();
  });
});

describe("TICKET-140: origin overrides never send the real key and never apply on a deployed site", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("a loopback YOUTUBE_API_ORIGIN replaces the real key with a placeholder", () => {
    process.env.YOUTUBE_API_KEY = "real-key";
    process.env.YOUTUBE_API_ORIGIN = "http://127.0.0.1:4140";
    expect(videoApiKey()).toBe("local-stub-key");
  });

  it("a non-loopback override is ignored (real key, real origin)", () => {
    process.env.YOUTUBE_API_KEY = "real-key";
    process.env.YOUTUBE_API_ORIGIN = "https://evil.example";
    expect(videoApiKey()).toBe("real-key");
  });

  it("a production process ignores the override unless the local e2e flag is set off Vercel", () => {
    process.env.YOUTUBE_API_KEY = "real-key";
    process.env.YOUTUBE_API_ORIGIN = "http://127.0.0.1:4140";
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.VERCEL = "1";
    process.env.BORAOKE_E2E_STUBS = "1";
    expect(videoApiKey()).toBe("real-key"); // on Vercel: never
    delete process.env.VERCEL;
    delete process.env.BORAOKE_E2E_STUBS;
    expect(videoApiKey()).toBe("real-key"); // no flag: never
    process.env.BORAOKE_E2E_STUBS = "1";
    expect(videoApiKey()).toBe("local-stub-key"); // local e2e build only
  });
});

describe("parser cost stays flat on hostile input (cyber MEDIUM-1)", () => {
  // The server parses `youtubeUrl` BEFORE its submit rate limit, so its cost
  // must not grow with what an unauthenticated caller sends. The bounds are
  // generous on purpose (a loaded CI box): the old end-anchored regex took
  // ~30 ms for one 4,000-character input and ~20 s at 100,000.
  const time = (fn: () => void) => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  it("a long punctuation run inside a link token parses in linear time", () => {
    // Under the length cap, so this reaches the punctuation strip itself.
    const token = `https://youtu.be/dQw4w9WgXcQ${".".repeat(MAX_PARSE_INPUT - 40)}a`;
    expect(token.length).toBeLessThanOrEqual(MAX_PARSE_INPUT);
    let ms = 0;
    for (let i = 0; i < 200; i++) ms += time(() => parseYouTubeVideoId(token));
    expect(ms).toBeLessThan(50); // 200 parses; quadratic was ~0.8 ms each at this size
  });

  it("the share-text path is linear too", () => {
    const text = `olha youtu${".".repeat(MAX_PARSE_INPUT - 20)}a b`;
    let ms = 0;
    for (let i = 0; i < 200; i++) ms += time(() => parseYouTubeVideoId(text));
    expect(ms).toBeLessThan(50);
  });

  it("input over the cap is refused before any regex, however long", () => {
    const huge = `${".".repeat(100_000)}a`;
    expect(time(() => expect(parseYouTubeVideoId(huge)).toBeNull())).toBeLessThan(50);
    expect(parseYouTubeVideoId(`https://youtu.be/dQw4w9WgXcQ ${"x".repeat(MAX_PARSE_INPUT)}`)).toBeNull();
  });

  it("the cap leaves real links and share text alone, and still strips the glue", () => {
    expect(MAX_PARSE_INPUT).toBe(512);
    expect(parseYouTubeVideoId("(https://youtu.be/dQw4w9WgXcQ).")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeVideoId("“https://youtu.be/dQw4w9WgXcQ”!?")).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeVideoId("olha <https://youtu.be/dQw4w9WgXcQ>, 🔥")).toBe("dQw4w9WgXcQ");
    const padded = `${" ".repeat(MAX_PARSE_INPUT - 30)}https://youtu.be/dQw4w9WgXcQ`;
    expect(padded.length).toBeLessThanOrEqual(MAX_PARSE_INPUT);
    expect(parseYouTubeVideoId(padded)).toBe("dQw4w9WgXcQ");
  });
});

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration("PT4M5S")).toBe("4:05");
    expect(formatDuration("PT1H2M3S")).toBe("1:02:03");
    expect(formatDuration("PT45S")).toBe("0:45");
    expect(formatDuration("P0D")).toBe("");
    expect(formatDuration("nope")).toBe("");
  });
});
