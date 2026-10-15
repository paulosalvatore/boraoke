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
  INDEX_RELOAD_MS,
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

  function writeFixture(shards: ChannelShard[]): string {
    const dir = mkdtempSync(join(tmpdir(), "kidx-"));
    const file = join(dir, "idx.json.gz");
    writeFileSync(file, gzipSync(Buffer.from(JSON.stringify({ shards }))));
    return file;
  }

  it("drops expired shards at load time", async () => {
    const now = Date.now();
    process.env.STORE_DRIVER = "memory";
    process.env.KARAOKE_INDEX_FILE = writeFixture([
      shard("fresh", "Evidências Karaokê", now - 2 * DAY),
      shard("stale", "Escurinho do Cinema Karaokê", now - INDEX_MAX_AGE_MS - 1),
    ]);
    const idx = await getKaraokeIndex(now);
    expect(idx?.size).toBe(1);
    expect(idx?.search("evidencias karaoke").confidence).toBe(1);
    expect(idx?.search("escurinho karaoke").confidence).toBe(0);
  });

  it("a warm instance rebuilds the MOMENT its oldest shard expires, not at the hourly reload", async () => {
    const now = Date.now();
    process.env.STORE_DRIVER = "memory";
    // Fresh at load: 10 minutes inside the retention limit.
    process.env.KARAOKE_INDEX_FILE = writeFixture([
      shard("edge", "Evidências Karaokê", now - INDEX_MAX_AGE_MS + 10 * 60 * 1000),
    ]);
    expect((await getKaraokeIndex(now))?.size).toBe(1);
    // 20 minutes later: past the limit, but well INSIDE the 1 h reload interval,
    // so only the expiry check can trigger the rebuild that drops it.
    const later = now + 20 * 60 * 1000;
    expect(later - now).toBeLessThan(INDEX_RELOAD_MS);
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
  /**
   * Fake Data API. Each channel's uploads playlist has `pages` pages; a page's
   * playlistItems call can be made to fail with `failPage`. Tracks in-flight
   * concurrency and an optional per-call delay.
   */
  function fakeApi(
    paths: string[],
    opts: { pages?: number; failPage?: number; delayMs?: number; inflight?: { now: number; max: number } } = {},
  ): typeof fetch {
    const pages = opts.pages ?? 1;
    return (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (opts.inflight) {
        opts.inflight.now++;
        opts.inflight.max = Math.max(opts.inflight.max, opts.inflight.now);
      }
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.inflight) opts.inflight.now--;
      if (url.pathname.endsWith("/playlistItems")) {
        const page = Number(url.searchParams.get("pageToken") ?? "1");
        if (opts.failPage === page) return new Response("{}", { status: 500 });
        const pl = url.searchParams.get("playlistId");
        return new Response(
          JSON.stringify({
            nextPageToken: page < pages ? String(page + 1) : undefined,
            items: [{ snippet: { title: `Song ${page}`, channelTitle: "C" }, contentDetails: { videoId: `v${pl}-${page}` } }],
          }),
          { status: 200 },
        );
      }
      const json = {
        items: (url.searchParams.get("id") ?? "")
          .split(",")
          .map((id) => ({ id, contentDetails: { duration: "PT3M" }, status: { embeddable: true } })),
      };
      return new Response(JSON.stringify(json), { status: 200 });
    }) as typeof fetch;
  }

  const collect = () => {
    const written: ChannelShard[] = [];
    return { written, write: async (s: ChannelShard) => void written.push(s) };
  };

  it("writes complete shards, respects the unit budget, and never calls search", async () => {
    const paths: string[] = [];
    const { written, write } = collect();
    const report = await runRefresh({
      key: "k",
      channels: [UC(1), UC(2), UC(3)],
      stamps: new Map(),
      write,
      fetchImpl: fakeApi(paths),
      maxUnits: 4, // 2 units reserved per one-page channel -> exactly two channels
      concurrency: 1,
      maxPages: 1,
    });
    expect(written.map((s) => s.channelId)).toEqual([UC(1), UC(2)]);
    expect(report.unitsUsed).toBe(4);
    expect(report.searchListCalls).toBe(0);
    expect(paths.some((p) => /search/i.test(p))).toBe(false);
  });

  it("never writes a channel cut short by the TIME budget (it would replace a complete shard)", async () => {
    const { written, write } = collect();
    const report = await runRefresh({
      key: "k",
      channels: [UC(1)],
      stamps: new Map(),
      write,
      // 3 pages, 20 ms per call: page 1 (2 calls) ends at ~40 ms, past the
      // 30 ms hard deadline, so page 2 never starts -> cut mid-channel.
      fetchImpl: fakeApi([], { pages: 3, delayMs: 20 }),
      hardDeadlineMs: 30,
      concurrency: 1,
      maxPages: 3,
    });
    expect(report.unitsUsed).toBe(2); // page 1 really was harvested: the guard is reached
    expect(written).toEqual([]);
    expect(report.skipped).toEqual([{ channelId: UC(1), note: "time budget reached mid-channel" }]);
  });

  it("a channel whose full budget cannot be reserved does not start (no wasted units)", async () => {
    const { written, write } = collect();
    const report = await runRefresh({
      key: "k",
      channels: [UC(1)],
      stamps: new Map(),
      write,
      fetchImpl: fakeApi([], { pages: 3 }),
      maxUnits: 5, // a 3-page channel needs 6 reserved
      maxPages: 3,
    });
    expect(report.unitsUsed).toBe(0);
    expect(written).toEqual([]);
  });

  it("never writes a channel cut short by an HTTP error mid-channel", async () => {
    const { written, write } = collect();
    const report = await runRefresh({
      key: "k",
      channels: [UC(1)],
      stamps: new Map(),
      write,
      fetchImpl: fakeApi([], { pages: 3, failPage: 2 }),
      concurrency: 1,
      maxPages: 3,
    });
    expect(written).toEqual([]);
    expect(report.skipped[0].note).toBe("playlistItems HTTP 500");
  });

  it("starts no channel after the start cutoff", async () => {
    const { written, write } = collect();
    const report = await runRefresh({
      key: "k",
      channels: [UC(1)],
      stamps: new Map(),
      write,
      fetchImpl: fakeApi([]),
      startCutoffMs: -1,
    });
    expect(written).toEqual([]);
    expect(report.unitsUsed).toBe(0);
  });

  it("harvests channels concurrently (bounded) and never overspends the shared budget", async () => {
    const inflight = { now: 0, max: 0 };
    const { written, write } = collect();
    const channels = Array.from({ length: 8 }, (_, i) => UC(i + 1));
    const report = await runRefresh({
      key: "k",
      channels,
      stamps: new Map(),
      write,
      fetchImpl: fakeApi([], { pages: 2, delayMs: 5, inflight }),
      concurrency: 3,
      maxPages: 2,
      maxUnits: 21, // 4 units per 2-page channel: exactly 5 channels fit, none is cut
    });
    expect(inflight.max).toBe(3);
    expect(report.unitsUsed).toBe(20);
    expect(written).toHaveLength(5);
    expect(written.every((s) => s.rows.length === 2)).toBe(true);
    expect(report.skipped).toEqual([]);
  });
});
