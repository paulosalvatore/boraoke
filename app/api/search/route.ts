import { NextRequest, NextResponse } from "next/server";
import {
  searchYouTubePage,
  cacheKey,
  rateLimitOk,
  SEARCH_DEFAULTS,
  MAX_SEARCH_PAGES,
  YouTubeQuotaError,
} from "@/lib/youtube-search";
import { getCachedSearchPage, setCachedSearchPage } from "@/lib/search-cache";
import { track } from "@/lib/telemetry";
import { getTranslations } from "next-intl/server";

/**
 * GET /api/search?q=<query>&uuid=<patronUuid>[&pageToken=<token>&page=<n>]
 *
 * Server-side YouTube Data API v3 search. The API key is read from the
 * YOUTUBE_API_KEY env var HERE (server only) and never sent to the client.
 *
 * Response contract (all non-throwing so the client fails soft to paste-link):
 *   200 { results: SearchResult[], nextPageToken?: string }  — success
 *   200 { degraded: true, reason, results: [] }        — no key / quota / upstream error
 *   400 { error }                                      — bad query/uuid/pageToken, or page past the depth cap
 *   429 { error }                                      — per-uuid OR per-IP rate limit exceeded
 *
 * QUOTA (TICKET-83, post-2026-06-01 model): a cache MISS spends ONE of the
 * platform's 100 DAILY `search.list` CALLS — its own hard-capped bucket, shared
 * by every venue — plus 1 unit of the separate, barely-touched metadata pool for
 * durations. That one call returns up to SEARCH_DEFAULTS.maxResults (50) rows,
 * which the client reveals 8 at a time for free. `pageToken` requests the NEXT
 * Google page — another whole daily search on a miss — and is folded into the
 * cache key, so paging back to an already-seen page costs zero. Page depth is
 * hard-capped at MAX_SEARCH_PAGES; nothing is ever prefetched.
 */

const MIN_QUERY = 3;
const MAX_QUERY = 100;
// TICKET-83: Google's page cursors are opaque URL-safe base64. The token is
// echoed straight into an outbound URL and into a cache key, so constrain its
// shape and length strictly before it touches either.
const PAGE_TOKEN_RE = /^[A-Za-z0-9_\-=]{1,128}$/;
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
  const pageToken = (params.get("pageToken") ?? "").trim();

  if (pageToken && !PAGE_TOKEN_RE.test(pageToken)) {
    return NextResponse.json({ error: "invalid pageToken" }, { status: 400 });
  }

  // Depth cap (TICKET-83). Google's cursors are opaque, so the server cannot
  // infer depth from the token alone — the client declares which page it is
  // asking for and the server refuses anything past MAX_SEARCH_PAGES. This is a
  // budget guard, not a security boundary (the dual uuid/IP rate limiter is
  // what bounds a hostile caller); it stops a client bug or a naive scripted
  // loop from eating the platform's entire daily search allowance.
  const rawPage = params.get("page");
  const pageNum = rawPage ? Number(rawPage) : 1;
  if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > MAX_SEARCH_PAGES) {
    return NextResponse.json(
      { error: `page must be an integer between 1 and ${MAX_SEARCH_PAGES}` },
      { status: 400 },
    );
  }
  // `page` and `pageToken` must AGREE, otherwise the cap is trivially sidestepped
  // by sending page=1 with a deep cursor: page 1 is by definition the cursor-less
  // first page, and any cursor means depth ≥ 2.
  if ((pageNum === 1) !== (pageToken === "")) {
    return NextResponse.json(
      { error: "page and pageToken disagree" },
      { status: 400 },
    );
  }

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
    // i18n (TICKET-30): user-facing copy follows the request locale.
    const te = await getTranslations("Errors");
    return NextResponse.json(
      { error: te("searchRateLimited") },
      { status: 429 },
    );
  }

  // Degraded mode: no key provisioned → this is the local-dev / CI / outage path.
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    return NextResponse.json({ degraded: true, reason: "no-api-key", results: [] });
  }

  // Cross-instance read cache for identical queries (TICKET-55): memory L1 +
  // Upstash Redis when configured; fail-open (any Redis error = cache miss).
  // Served BEFORE any Data API call — a hit burns zero quota.
  // TICKET-83: the key is pageToken-scoped, so every page (not just the first)
  // is served free on revisit.
  const ck = cacheKey(q, SEARCH_DEFAULTS.regionCode, pageToken);
  const cached = await getCachedSearchPage(ck);
  if (cached) {
    void track("search_performed", { roomId: params.get("room") ?? "", uuid, props: { results: cached.results.length } }); // TICKET-12: fire-and-forget, fail-open
    return NextResponse.json({
      results: cached.results,
      nextPageToken: cached.nextPageToken,
      cached: true,
    });
  }

  try {
    const page = await searchYouTubePage(q, key, { pageToken: pageToken || undefined });
    // Only SUCCESSFUL responses reach this line — errors threw above and are
    // never cached. Non-empty → 12h TTL; empty → 10min TTL (see search-cache).
    await setCachedSearchPage(ck, page);
    void track("search_performed", { roomId: params.get("room") ?? "", uuid, props: { results: page.results.length } }); // TICKET-12: fire-and-forget, fail-open
    return NextResponse.json({ results: page.results, nextPageToken: page.nextPageToken });
  } catch (err) {
    if (err instanceof YouTubeQuotaError) {
      return NextResponse.json({ degraded: true, reason: "quota", results: [] });
    }
    // Any other upstream failure: fail soft to the paste-link fallback, never 500 the patron.
    return NextResponse.json({ degraded: true, reason: "error", results: [] });
  }
}
