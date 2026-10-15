import { createHmac, timingSafeEqual } from "crypto";

import { NextResponse } from "next/server";

import { runRefresh } from "@/lib/karaoke-index/refresh";
import { getIndexRedis, INDEX_CHANNELS, readStamps, writeShard } from "@/lib/karaoke-index/store";

/**
 * GET /api/cron/karaoke-index — refresh the oldest karaoke index shards.
 * Scheduled daily by `vercel.json` `crons`.
 *
 * AUTH: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. The route is
 * FAIL-CLOSED: with no CRON_SECRET configured it refuses every request (503),
 * so an unconfigured deployment can never be made to spend the unit pool by an
 * anonymous caller. The comparison is constant-time.
 *
 * QUOTA: spends only videos.list/playlistItems.list units (10k/day pool), at
 * most REFRESH_MAX_UNITS per run, and ZERO search.list calls (enforced in
 * lib/karaoke-index/harvest.ts before any request is made).
 */

export const dynamic = "force-dynamic";
/** Vercel Hobby ceiling; the refresh stops starting channels at 40 s. */
export const maxDuration = 60;

function bearerMatches(header: string | null, secret: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = createHmac("sha256", "cron-cmp").update(presented).digest();
  const b = createHmac("sha256", "cron-cmp").update(secret).digest();
  return presented.length > 0 && timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!bearerMatches(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const key = process.env.YOUTUBE_API_KEY;
  const redis = getIndexRedis();
  if (!key || !redis) {
    return NextResponse.json({ error: "index storage or API key not configured" }, { status: 503 });
  }
  try {
    const report = await runRefresh({
      key,
      channels: INDEX_CHANNELS,
      stamps: await readStamps(redis),
      write: (shard) => writeShard(redis, shard),
    });
    // Counts only — never the key, never row content.
    console.info(
      `[karaoke-index] refreshed ${report.refreshed.length} channels, skipped ${report.skipped.length}, ` +
        `units ${report.unitsUsed}, search.list 0`,
    );
    return NextResponse.json(report);
  } catch {
    return NextResponse.json({ error: "refresh failed" }, { status: 500 });
  }
}
