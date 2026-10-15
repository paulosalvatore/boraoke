import { NextRequest, NextResponse } from "next/server";
import { clientIpFrom } from "@/lib/client-ip";
import { isValidVideoId } from "@/lib/youtube";
import { resolveVideoTitle } from "@/lib/video-meta";
import { videoMetaRateLimitOk } from "@/lib/video-meta-rate-limit";

/**
 * GET /api/video-meta?v=<videoId> — the title and channel of a pasted video,
 * so the patron sees the right song before tapping add (TICKET-140 gap 4).
 *
 * Server-side on purpose: one cached lookup is shared by every patron, the
 * browser needs no new CSP `connect-src` host, and the lookup is keyless
 * oEmbed only (lib/video-meta.ts `resolveVideoTitle`) so this public endpoint
 * can never spend Data API quota. Unknown title → `{}` with 200: the client
 * keeps its "YouTube link" placeholder, exactly as before.
 *
 * The answer is display-only. The submit route resolves the title again on
 * its own and never trusts what the client shows.
 */
export async function GET(req: NextRequest) {
  const v = req.nextUrl.searchParams.get("v") ?? "";
  if (!isValidVideoId(v)) {
    return NextResponse.json({ error: "Invalid video id" }, { status: 400 });
  }
  if (!videoMetaRateLimitOk(clientIpFrom(req))) {
    return NextResponse.json({}, { status: 429 });
  }
  const meta = await resolveVideoTitle(v);
  if (!meta) {
    // No title: a definite "missing" (already cached server-side for 10 min)
    // or a transient oEmbed error (deliberately not cached). Either way the
    // browser must not pin the empty answer, or a blip would hide the title
    // for 10 minutes.
    return NextResponse.json({}, { status: 200, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(
    { title: meta.title, ...(meta.channelTitle ? { channelTitle: meta.channelTitle } : {}) },
    { status: 200, headers: { "Cache-Control": "private, max-age=600" } },
  );
}
