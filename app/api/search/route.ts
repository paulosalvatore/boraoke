import { NextRequest, NextResponse } from "next/server";
import {
  searchYouTubePage,
  cacheKey,
  rateLimitOk,
  indexRateLimitOk,
  SEARCH_DEFAULTS,
  MAX_SEARCH_PAGES,
  YouTubeQuotaError,
} from "@/lib/youtube-search";
import { getCachedSearchPage, setCachedSearchPage } from "@/lib/search-cache";
import { reserveSearchCall } from "@/lib/search-budget";
import { track } from "@/lib/telemetry";
import { getKaraokeIndex } from "@/lib/karaoke-index/store";
import { decideTier, INDEX_MORE_TOKEN } from "@/lib/karaoke-index/tier";
import { containsKaraoke } from "@/lib/search-query";
import { getTranslations } from "next-intl/server";
import { liveAllowed, liveCooldown } from "@/lib/live-search-gate";

/**
 * GET /api/search?q=<query>&uuid=<patronUuid>[&v=2[&live=1]][&pageToken=<token>&page=<n>]
 *
 * Server-side YouTube Data API v3 search. The API key is read from the
 * YOUTUBE_API_KEY env var HERE (server only) and never sent to the client.
 *
 * Response contract (all non-throwing so the client fails soft to paste-link):
 *   200 { results: SearchResult[], nextPageToken?: string }  — success
 *   200 { degraded: true, reason, results: [] }        — no key / quota / daily-limit / upstream error
 *   200 { results: [], liveRequired: true }            — v2 index-only request the free tiers can't answer
 *   200 { results: [], deferred: "live-cooldown", retryAfterMs } — billed attempt inside the per-uuid cooldown
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
 *
 * LIVE PERMISSION: the current client sends `v=2` on every request. A v2 first
 * page is INDEX-ONLY unless it also carries `live=1` — sent on Enter, after an
 * idle pause, or on "search again". A request without `v=2` is a legacy client
 * (a page loaded before this shipped) and keeps the old cache -> index -> live
 * fallback, still behind the per-uuid cooldown, rate limits and daily budget. Index-only requests are answered from the free tiers (cache, karaoke
 * index) or get `liveRequired`; they never reach the key, the daily budget or
 * Google. A `pageToken` request ("load more") is a deliberate tap and is
 * live-allowed. A per-uuid cooldown in front of the budget stops a modified
 * client from billing per keystroke. See lib/live-search-gate.ts.
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
  // Index-only requests (free) and live-allowed ones (may bill) are rate-limited
  // in separate buckets: as-you-type lookups must not starve the patron's Enter.
  const mayBill = liveAllowed(params, pageToken);
  const ip = clientIp(req);
  if (!(mayBill ? rateLimitOk(uuid, ip) : indexRateLimitOk(uuid, ip))) {
    // i18n (TICKET-30): user-facing copy follows the request locale.
    const te = await getTranslations("Errors");
    return NextResponse.json(
      { error: te("searchRateLimited") },
      { status: 429 },
    );
  }

  // Index escape hatch: "load more" past an index answer arrives as page 2
  // carrying INDEX_MORE_TOKEN. It is answered as the LIVE FIRST page of the same
  // query (cache-first, then one billed call — the price of any deep page today).
  const indexEscape = pageToken === INDEX_MORE_TOKEN;
  const livePageToken = indexEscape ? "" : pageToken;

  // Cross-instance read cache for identical queries (TICKET-55): memory L1 +
  // Upstash Redis when configured; fail-open (any Redis error = cache miss).
  // Served BEFORE any Data API call — a hit burns zero quota.
  // TICKET-83: the key is pageToken-scoped, so every page (not just the first)
  // is served free on revisit.
  // Karaoke index: the cache is still the FIRST tier — a query already answered live is served
  // from cache before the index is consulted.
  const ck = cacheKey(q, SEARCH_DEFAULTS.regionCode, livePageToken);
  const cached = await getCachedSearchPage(ck);
  if (cached) {
    void track("search_performed", { roomId: params.get("room") ?? "", uuid, props: { results: cached.results.length, source: "cache" } }); // TICKET-12: fire-and-forget, fail-open
    return NextResponse.json({
      results: cached.results,
      nextPageToken: cached.nextPageToken,
      cached: true,
    });
  }

  // ── The karaoke index, second tier ──────────────────────────────────
  // Harvested via playlistItems (10k-unit pool), searched in process memory,
  // ZERO search.list. It answers only a sing-mode first page with a confident
  // match (see lib/karaoke-index/tier.ts for the threshold and its tuning);
  // anything else falls through to the unchanged live path below. Index
  // answers are not written to the search cache: the index is already local,
  // and caching would keep serving rows past a shard's retention expiry.
  // Fail-open: a missing/expired/unreadable index is simply "no answer".
  // Sing mode and first page are checked BEFORE the index is loaded, so a
  // listen-mode request on a cold instance never pays the index load.
  if (!pageToken && containsKaraoke(q)) {
    const decision = decideTier({ q, pageToken, index: await getKaraokeIndex() });
    if (decision.tier === "index") {
      void track("search_performed", { roomId: params.get("room") ?? "", uuid, props: { results: decision.results.length, source: "index" } }); // fire-and-forget, fail-open
      return NextResponse.json({
        results: decision.results,
        // Lets "load more" escape to live search once the index rows run out.
        nextPageToken: INDEX_MORE_TOKEN,
        source: "index",
      });
    }
  }

  // Index-only request and neither free tier answered: tell the client a live
  // search is available on Enter / idle. Nothing billed, no key needed.
  if (!mayBill) {
    return NextResponse.json({ results: [], liveRequired: true });
  }

  // Degraded mode: no key provisioned → this is the local-dev / CI / outage path.
  // (Placed below the cache + index tiers, which spend nothing
  // and need no key: a configured index keeps answering when live search can't.)
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    return NextResponse.json({ degraded: true, reason: "no-api-key", results: [] });
  }

  // ── TICKET-87: platform-wide DAILY spend ceiling ──────────────────────────
  // Everything above this line is free; from here on we are about to spend one
  // of the platform's 100 daily `search.list` calls (its own hard cap since
  // 2026-06-01). The per-uuid/per-IP window above bounds one actor's RATE; it
  // does not bound the platform's daily TOTAL, so at the per-IP ceiling a single
  // client could drain the whole day in ~35s and kill search for every venue.
  //
  // The reservation is atomic and cross-instance (Upstash Lua EVAL), is taken
  // BEFORE the outbound call so a concurrent burst cannot all pass a check and
  // then all spend, and is NEVER refunded on failure (a refund-on-error path is
  // an attacker-triggerable free credit — see lib/search-budget.ts).
  //
  // Placed AFTER the cache read on purpose: a cache hit issues no `search.list`
  // call, so it must not consume budget. That also means cached/popular queries
  // keep working normally once the budget is spent.
  //
  // At cap (or when the configured counter store is unreachable — fail-closed,
  // argued in lib/search-budget.ts) we degrade exactly like the other quota
  // paths: HTTP 200, `degraded: true`, empty results, and the paste-a-YouTube-
  // link flow (which costs zero `search.list`) keeps working. The reason is the
  // single value "daily-limit" for BOTH denial causes, so the response body
  // cannot be used to probe whether our Redis is down, and it never leaks how
  // much budget remains (that would tell an attacker exactly how far a drain has
  // progressed) — remaining budget is server-log-only.
  // Per-uuid cooldown BEFORE the budget reservation, so a deferred request
  // spends nothing. Pre-boot "anon" callers are keyed by IP so they don't share
  // one cooldown across every anonymous patron on the instance.
  const cooldown = liveCooldown(uuid === "anon" ? `anon@${ip}` : uuid);
  if (!cooldown.ok) {
    return NextResponse.json({
      results: [],
      deferred: "live-cooldown",
      retryAfterMs: cooldown.retryAfterMs,
    });
  }

  const reservation = await reserveSearchCall();
  if (!reservation.ok) {
    return NextResponse.json({
      degraded: true,
      reason: "daily-limit",
      results: [],
    });
  }

  try {
    const page = await searchYouTubePage(q, key, { pageToken: livePageToken || undefined });
    // Only SUCCESSFUL responses reach this line — errors threw above and are
    // never cached. Non-empty → 12h TTL; empty → 10min TTL (see search-cache).
    await setCachedSearchPage(ck, page);
    void track("search_performed", { roomId: params.get("room") ?? "", uuid, props: { results: page.results.length, source: "live" } }); // TICKET-12: fire-and-forget, fail-open
    return NextResponse.json({ results: page.results, nextPageToken: page.nextPageToken });
  } catch (err) {
    if (err instanceof YouTubeQuotaError) {
      return NextResponse.json({ degraded: true, reason: "quota", results: [] });
    }
    // Any other upstream failure: fail soft to the paste-link fallback, never 500 the patron.
    return NextResponse.json({ degraded: true, reason: "error", results: [] });
  }
}
