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
import { track } from "@/lib/telemetry";

/**
 * GET /api/search?q=<query>&uuid=<patronUuid>
 *
 * Server-side YouTube Data API v3 search. The API key is read from the
 * YOUTUBE_API_KEY env var HERE (server only) and never sent to the client.
 *
 * Response contract (all non-throwing so the client fails soft to paste-link):
 *   200 { results: SearchResult[] }                    — success
 *   200 { degraded: true, reason, results: [] }        — no key / quota / upstream error
 *   400 { error }                                      — bad query or malformed uuid
 *   429 { error }                                      — per-uuid OR per-IP rate limit exceeded
 */

const MIN_QUERY = 3;
const MAX_QUERY = 100;
// LOW #3 (PR #8 security gate): the uuid is used as a rate-limit map key, so
// cap its shape strictly (36-char UUID) before it touches any server state.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Caller IP for the rate-limit bucket (MEDIUM #1). On Vercel the first hop of
 * x-forwarded-for is the client IP (the platform sets/normalizes the header);
 * x-real-ip is the fallback. "" when neither is present (local unit tests).
 */
function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() ?? "";
}

export async function GET(req: NextRequest) {
  // Parse from req.url (works with a plain Request in unit tests too).
  const params = new URL(req.url).searchParams;
  const q = (params.get("q") ?? "").trim();
  const rawUuid = (params.get("uuid") ?? "").trim();

  // Validate the uuid BEFORE using it as a map key: absent or the literal
  // "anon" (pre-boot client) → "anon"; anything else that is not UUID-shaped
  // (incl. oversized values) → 400.
  if (rawUuid && rawUuid !== "anon" && !UUID_RE.test(rawUuid)) {
    return NextResponse.json(
      { error: "uuid must be a valid UUID" },
      { status: 400 },
    );
  }
  const uuid = rawUuid || "anon";

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

  // Dual rate limit (quota hygiene): per-uuid AND per-IP — rotating uuids from
  // one host is capped by the IP bucket. Reject politely; paste-link keeps working.
  if (!rateLimitOk(uuid, clientIp(req))) {
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
    void track("search_performed", { roomId: params.get("room") ?? "", uuid, props: { results: cached.length } }); // TICKET-12: fire-and-forget, fail-open
    return NextResponse.json({ results: cached, cached: true });
  }

  try {
    const results = await searchYouTube(q, key);
    setCached(ck, results);
    void track("search_performed", { roomId: params.get("room") ?? "", uuid, props: { results: results.length } }); // TICKET-12: fire-and-forget, fail-open
    return NextResponse.json({ results });
  } catch (err) {
    if (err instanceof YouTubeQuotaError) {
      return NextResponse.json({ degraded: true, reason: "quota", results: [] });
    }
    // Any other upstream failure: fail soft to the paste-link fallback, never 500 the patron.
    return NextResponse.json({ degraded: true, reason: "error", results: [] });
  }
}
