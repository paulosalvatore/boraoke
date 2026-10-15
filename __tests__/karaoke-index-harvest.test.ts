import {
  assertNoSearchList,
  harvestChannel,
  isPlayableHere,
  resolveSeedChannels,
  UnitLedger,
  uploadsPlaylistId,
} from "@/lib/karaoke-index/harvest";

const CH = "UC" + "a".repeat(22);

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake Data API: two playlist pages, the second page's videos include unplayable rows. */
function fakeApi(calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname.endsWith("/playlistItems")) {
      const second = url.searchParams.get("pageToken") === "P2";
      const ids = second ? ["v3", "v4", "v5"] : ["v1", "v2"];
      return jsonRes({
        nextPageToken: second ? undefined : "P2",
        items: ids.map((id) => ({
          snippet: { title: `Song ${id} &amp; Karaoke`, channelTitle: "Karaokê Club" },
          contentDetails: { videoId: id },
        })),
      });
    }
    if (url.pathname.endsWith("/videos")) {
      const ids = (url.searchParams.get("id") ?? "").split(",");
      if (url.searchParams.get("part") === "snippet") {
        return jsonRes({ items: ids.map((id) => ({ id, snippet: { channelId: CH, channelTitle: "Karaokê Club" } })) });
      }
      return jsonRes({
        items: ids.map((id) => ({
          id,
          contentDetails: {
            duration: id === "v4" ? "P0D" : "PT3M5S",
            ...(id === "v5" ? { regionRestriction: { blocked: ["BR"] } } : {}),
          },
          status: { embeddable: id !== "v3", privacyStatus: "public", uploadStatus: "processed" },
        })),
      });
    }
    return jsonRes({}, 404);
  }) as typeof fetch;
}

describe("karaoke index harvest", () => {
  it("refuses any search endpoint before a request is made", () => {
    expect(() => assertNoSearchList("https://www.googleapis.com/youtube/v3/search?q=x")).toThrow(/REFUSED/);
    expect(() => assertNoSearchList("https://www.googleapis.com/youtube/v3/videos?id=x")).not.toThrow();
    expect(() => assertNoSearchList("https://www.googleapis.com/youtube/v3/playlistItems")).not.toThrow();
  });

  it("derives the uploads playlist and rejects non-channel ids", () => {
    expect(uploadsPlaylistId(CH)).toBe("UU" + "a".repeat(22));
    expect(uploadsPlaylistId("UCshort")).toBeNull();
    expect(uploadsPlaylistId("PL" + "a".repeat(22))).toBeNull();
  });

  it("harvests pages, keeps only playable rows, stores only id/title/duration, charges 1 unit per call", async () => {
    const calls: string[] = [];
    const ledger = new UnitLedger(100);
    const r = await harvestChannel(CH, { key: "k", ledger, fetchImpl: fakeApi(calls) }, { maxPages: 14, now: 1000 });
    expect(r.shard).not.toBeNull();
    expect(r.shard!.harvestedAt).toBe(1000);
    expect(r.shard!.channelTitle).toBe("Karaokê Club");
    // v3 not embeddable, v4 is a P0D stream, v5 blocked in BR.
    expect(r.shard!.rows).toEqual([
      ["v1", "Song v1 & Karaoke", "3:05"],
      ["v2", "Song v2 & Karaoke", "3:05"],
    ]);
    expect(calls.every((p) => !/search/i.test(p))).toBe(true);
    expect(ledger.used).toBe(4); // 2 playlist pages + 2 videos.list
    expect(r.calls).toBe(4);
  });

  it("never exceeds the unit ledger, and never starts a page it cannot finish", async () => {
    const calls: string[] = [];
    const ledger = new UnitLedger(3);
    const r = await harvestChannel(CH, { key: "k", ledger, fetchImpl: fakeApi(calls) }, { maxPages: 14 });
    expect(ledger.used).toBe(2);
    expect(r.note).toMatch(/budget/);
    expect(r.shard!.rows).toHaveLength(2);
  });

  it("resolves seeds to channels in seed order with one unit per 50 ids", async () => {
    const calls: string[] = [];
    const ledger = new UnitLedger(10);
    const ids = Array.from({ length: 51 }, (_, i) => `s${i}`);
    const m = await resolveSeedChannels(ids, { key: "k", ledger, fetchImpl: fakeApi(calls) });
    expect([...m.keys()]).toEqual([CH]);
    expect(ledger.used).toBe(2);
  });

  it("isPlayableHere honours allow-lists that exclude BR", () => {
    expect(
      isPlayableHere({ contentDetails: { duration: "PT3M", regionRestriction: { allowed: ["US"] } } }),
    ).toBe(false);
    expect(isPlayableHere({ contentDetails: { duration: "PT3M" } })).toBe(true);
  });
});
