import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync } from "zlib";

import {
  _resetKaraokeIndex,
  decodeShard,
  encodeShard,
  freshShards,
  getKaraokeIndex,
} from "@/lib/karaoke-index/store";
import { pickChannelsToRefresh, runRefresh } from "@/lib/karaoke-index/refresh";
import { INDEX_MAX_AGE_MS, type ChannelShard } from "@/lib/karaoke-index/types";

const DAY = 24 * 60 * 60 * 1000;

function shard(id: string, title: string, harvestedAt: number): ChannelShard {
  return { v: 1, channelId: id, channelTitle: `Chan ${id}`, harvestedAt, rows: [[`vid-${id}`, title, "3:00"]] };
}

describe("shard encoding", () => {
  it("round-trips and rejects garbage", () => {
    const s = shard("UCa", "Evidências", 123);
    expect(decodeShard(encodeShard(s))).toEqual(s);
    expect(decodeShard("not base64 gzip")).toBeNull();
    expect(decodeShard(42)).toBeNull();
    expect(decodeShard(gzipSync(Buffer.from(JSON.stringify({ v: 2 }))).toString("base64"))).toBeNull();
  });
});

describe("retention on the read path", () => {
  const ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ENV };
    _resetKaraokeIndex();
  });

  it("freshShards drops expired and null shards", () => {
    const now = 100 * DAY;
    const out = freshShards([shard("a", "x", now - DAY), null, shard("b", "y", now - INDEX_MAX_AGE_MS)], now);
    expect(out.map((s) => s.channelId)).toEqual(["a"]);
  });

  it("never serves an expired shard, even from a warm instance", async () => {
    const now = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "kidx-"));
    const file = join(dir, "idx.json.gz");
    writeFileSync(
      file,
      gzipSync(
        Buffer.from(
          JSON.stringify({
            shards: [
              shard("fresh", "Evidências Karaokê", now - 2 * DAY),
              shard("stale", "Escurinho do Cinema Karaokê", now - INDEX_MAX_AGE_MS - 1),
            ],
          }),
        ),
      ),
    );
    process.env.STORE_DRIVER = "memory";
    process.env.KARAOKE_INDEX_FILE = file;

    const idx = await getKaraokeIndex(now);
    expect(idx?.size).toBe(1);
    expect(idx?.search("evidencias karaoke").confidence).toBe(1);
    expect(idx?.search("escurinho karaoke").confidence).toBe(0); // the stale shard was dropped

    // Time passes: the remaining shard crosses the limit while cached in memory.
    // The instance must rebuild immediately, not wait for the hourly reload.
    const later = now - 2 * DAY + INDEX_MAX_AGE_MS + 1;
    expect(await getKaraokeIndex(later)).toBeNull();
  });

  it("the fixture file is never honoured in production", async () => {
    process.env.STORE_DRIVER = "memory";
    process.env.KARAOKE_INDEX_FILE = "/nonexistent";
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(await getKaraokeIndex()).toBeNull();
  });
});

describe("refresh job", () => {
  it("refreshes never-harvested channels first, then oldest, ties by rank", () => {
    const stamps = new Map([
      ["a", 500],
      ["b", 0],
      ["c", 100],
    ]);
    expect(pickChannelsToRefresh(["a", "b", "c", "d"], stamps)).toEqual(["b", "d", "c", "a"]);
  });

  const UC = (n: number) => `UC${String(n).padStart(22, "0")}`;
  function fakeApi(paths: string[]): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      const json = url.pathname.endsWith("/playlistItems")
        ? { items: [{ snippet: { title: "Song", channelTitle: "C" }, contentDetails: { videoId: `v${url.searchParams.get("playlistId")}` } }] }
        : { items: (url.searchParams.get("id") ?? "").split(",").map((id) => ({ id, contentDetails: { duration: "PT3M" }, status: { embeddable: true } })) };
      return new Response(JSON.stringify(json), { status: 200 });
    }) as typeof fetch;
  }

  it("writes complete shards, respects the unit budget, and never calls search", async () => {
    const paths: string[] = [];
    const written: ChannelShard[] = [];
    const report = await runRefresh({
      key: "k",
      channels: [UC(1), UC(2), UC(3)],
      stamps: new Map(),
      write: async (s) => {
        written.push(s);
      },
      fetchImpl: fakeApi(paths),
      maxUnits: 4, // 2 units per one-page channel -> exactly two channels
    });
    expect(written.map((s) => s.channelId)).toEqual([UC(1), UC(2)]);
    expect(report.unitsUsed).toBe(4);
    expect(report.searchListCalls).toBe(0);
    expect(paths.some((p) => /search/i.test(p))).toBe(false);
  });

  it("does not overwrite a shard with a channel cut short by the time budget", async () => {
    const written: ChannelShard[] = [];
    const report = await runRefresh({
      key: "k",
      channels: [UC(1)],
      stamps: new Map(),
      write: async (s) => {
        written.push(s);
      },
      fetchImpl: fakeApi([]),
      timeBudgetMs: -1, // already past the deadline
    });
    expect(written).toEqual([]);
    expect(report.refreshed).toEqual([]);
  });
});
