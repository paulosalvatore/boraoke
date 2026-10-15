/**
 * Index loading over the Redis path: short retry after a failed load, and the
 * stamps check that skips re-downloading unchanged shards (bandwidth).
 */
const calls = { hgetall: 0, mget: 0 };
let stamps: Record<string, number> = {};
let shardsByKey: Record<string, string> = {};
let failNext = false;

jest.mock("@upstash/redis", () => ({
  Redis: {
    fromEnv: () => ({
      hgetall: async () => {
        calls.hgetall++;
        if (failNext) {
          failNext = false;
          throw new Error("redis down");
        }
        return stamps;
      },
      mget: async (...keys: string[]) => {
        calls.mget++;
        return keys.map((k) => shardsByKey[k] ?? null);
      },
    }),
  },
}));
jest.mock("@/lib/karaoke-index/channels.json", () => ["UC0000000000000000000001"]);

import {
  _resetKaraokeIndex,
  encodeShard,
  getKaraokeIndex,
  INDEX_RELOAD_MS,
  INDEX_RETRY_MS,
} from "@/lib/karaoke-index/store";
import { INDEX_MAX_AGE_MS, type ChannelShard } from "@/lib/karaoke-index/types";

const CH = "UC0000000000000000000001";
const NOW = Date.now();
const shard = (harvestedAt: number): ChannelShard => ({
  v: 1,
  channelId: CH,
  channelTitle: "Karaokê Club",
  harvestedAt,
  rows: [["vEvid", "Evidências (Karaokê)", "4:30"]],
});

beforeEach(() => {
  _resetKaraokeIndex();
  process.env.STORE_DRIVER = "upstash";
  calls.hgetall = 0;
  calls.mget = 0;
  stamps = { [CH]: NOW - 1000 };
  shardsByKey = { [`ki:shard:${CH}`]: encodeShard(shard(NOW - 1000)) };
  failNext = false;
});
afterAll(() => {
  delete process.env.STORE_DRIVER;
});

it("after a failed load, retries within INDEX_RETRY_MS instead of waiting an hour", async () => {
  failNext = true;
  expect(await getKaraokeIndex(NOW)).toBeNull();
  expect(await getKaraokeIndex(NOW + INDEX_RETRY_MS - 1)).toBeNull(); // not hammering
  expect(calls.hgetall).toBe(1);
  const idx = await getKaraokeIndex(NOW + INDEX_RETRY_MS);
  expect(idx?.size).toBe(1);
  expect(INDEX_RETRY_MS).toBeLessThan(INDEX_RELOAD_MS);
});

it("the hourly reload skips the shard download when ki:stamps is unchanged", async () => {
  expect((await getKaraokeIndex(NOW))?.size).toBe(1);
  expect(calls.mget).toBe(1);
  expect((await getKaraokeIndex(NOW + INDEX_RELOAD_MS))?.size).toBe(1);
  expect(calls.hgetall).toBe(2);
  expect(calls.mget).toBe(1); // unchanged stamps: no 1.5 MB MGET
});

it("re-downloads when the cron has rewritten a shard (stamps changed)", async () => {
  await getKaraokeIndex(NOW);
  stamps = { [CH]: NOW + 5 };
  shardsByKey = { [`ki:shard:${CH}`]: encodeShard(shard(NOW + 5)) };
  await getKaraokeIndex(NOW + INDEX_RELOAD_MS);
  expect(calls.mget).toBe(2);
});

it("an expired shard is not served even when ki:stamps is unchanged (cron dead)", async () => {
  expect((await getKaraokeIndex(NOW))?.size).toBe(1);
  // The shard (harvested at NOW - 1000) is now exactly at the retention limit,
  // and the cron never ran, so the stamps are unchanged: the reload must NOT
  // reuse the in-memory index, it must re-read and drop the expired shard.
  expect(await getKaraokeIndex(NOW - 1000 + INDEX_MAX_AGE_MS)).toBeNull();
});
