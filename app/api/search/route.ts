import { NextRequest, NextResponse } from "next/server";
import {
  searchYouTube,
  cacheKey,
  getCached,
  setCached,
  rateLimitOk,
  SEARCH_DEFAULTS,
  YouTubeQuotaError,
} from "@/lib/youtube-search";

/**
 * GET /api/search?q=<query>&uuid=<patronUuid>
 *
 * Server-side YouTube Data API v3 search. The API key is read from the
 * YOUTUBE_API_KEY env var HERE (server only) and never sent to the client.
 *
 * Response contract (all non-throwing so the client fails soft to paste-link):
 *   200 { results: SearchResult[] }                    — success
 *   200 { degraded: true, reason, results: [] }        — no key / quota / upstream error
 *   400 { error }                                      — bad query (too short/long/missing)
 *   429 { error }                                      — per-uuid rate limit exceeded
 */

const MIN_QUERY = 3;
const MAX_QUERY = 100;

export async function GET(req: NextRequest) {
  // Parse from req.url (works with a plain Request in unit tests too).
  const params = new URL(req.url).searchParams;
  const q = (params.get("q") ?? "").trim();
  const uuid = (params.get("uuid") ?? "").trim() || "anon";

  if (q.length < MIN_QUERY) {
    return NextResponse.json(
      { error: `Query must be at least ${MIN_QUERY} characters` },
      { status: 400 },
    );
  }
  if (q.length > MAX_QUERY) {
    return NextResponse.json(
      { error: `Query must be at most ${MAX_QUERY} characters` },
      { status: 400 },
    );
  }

  // Per-uuid rate limit (quota hygiene) — reject politely, keep paste-link working.
  if (!rateLimitOk(uuid)) {
    return NextResponse.json(
      { error: "Muitas buscas — aguarde um instante e tente de novo." },
      { status: 429 },
    );
  }

  // Degraded mode: no key provisioned → this is the local-dev / CI / outage path.
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    return NextResponse.json({ degraded: true, reason: "no-api-key", results: [] });
  }

  // Brief read cache for identical queries (per serverless instance; best-effort).
  const ck = cacheKey(q, SEARCH_DEFAULTS.regionCode);
  const cached = getCached(ck);
  if (cached) {
    return NextResponse.json({ results: cached, cached: true });
  }

  try {
    const results = await searchYouTube(q, key);
    setCached(ck, results);
    return NextResponse.json({ results });
  } catch (err) {
    if (err instanceof YouTubeQuotaError) {
      return NextResponse.json({ degraded: true, reason: "quota", results: [] });
    }
    // Any other upstream failure: fail soft to the paste-link fallback, never 500 the patron.
    return NextResponse.json({ degraded: true, reason: "error", results: [] });
  }
}
