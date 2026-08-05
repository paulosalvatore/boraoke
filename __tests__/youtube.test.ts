import {
  parseYouTubeVideoId,
  checkEmbeddable,
  EMBEDDABLE_CHECK_TIMEOUT_MS,
} from "@/lib/youtube";

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

  it("calls videos.list with part=status and the id/key as query params (1 quota unit)", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(statusPayload(true)));
    await checkEmbeddable(VALID_ID, KEY, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const url = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/youtube/v3/videos");
    expect(url.searchParams.get("part")).toBe("status");
    expect(url.searchParams.get("id")).toBe(VALID_ID);
    expect(url.searchParams.get("key")).toBe(KEY);
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
