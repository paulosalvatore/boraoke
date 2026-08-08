import type { MetadataRoute } from "next";
import { SITE_URL } from "./metadata";

/**
 * robots.txt (TICKET-74) — replaces the previous static `public/robots.txt`.
 *
 * WHY A ROUTE INSTEAD OF THE STATIC FILE: the static file hardcoded
 * `https://boraoke.com/sitemap.xml`, a second copy of the canonical origin that
 * could silently drift from {@link SITE_URL}. As a route it imports the same
 * constant `app/sitemap.ts` and the metadata use, so the origin is stated once.
 * (The two cannot coexist — a `public/` file and a metadata route at the same
 * path collide — so `public/robots.txt` is removed in the same change.)
 *
 * THE POLICY IS AN ALLOWLIST, AND THAT IS THE POINT.
 *
 * Rooms live at the ROOT (`/<room>`, plus `/<room>/admin` and `/<room>/tv`), so
 * they are not separable from public pages by a path prefix — there is no
 * `/rooms/*` to disallow. The only way to keep venue rooms out of search is to
 * disallow `/` and allow the known-public pages back in:
 *
 *   `Allow: /$`     matches the homepage EXACTLY.
 *   `Allow: /new$`  likewise — WITHOUT the end-anchor this is a PREFIX rule and
 *                   would allow `/new-year-party`, `/newton-bar`, and any other
 *                   room whose slug happens to start with "new", defeating the
 *                   whole policy. `RESERVED_ROOM_IDS` only reserves the exact
 *                   id `new`, so such rooms are creatable.
 *   `Allow: /sitemap.xml` — a `Disallow: /` otherwise blocks the very sitemap
 *                   this file advertises, and a blocked sitemap is a reported
 *                   error in Search Console.
 *   plus the asset paths a renderer needs to see the page correctly.
 *
 * The `$` end-anchor is standard (RFC 9309 §2.2.3) and supported by Google,
 * Bing and Yandex. Be precise about the failure mode, because it is NOT benign:
 * a legacy parser that does not implement `$` reads `/$` as a literal prefix,
 * matches nothing, and falls through to `Disallow: /` — i.e. it fails CLOSED,
 * blocking the whole site rather than over-allowing it. That is acceptable only
 * because `$` is standardised and universally supported by the crawlers that
 * matter; it is not a free safety margin, and anything added here must be
 * anchored deliberately.
 *
 * WHY ROOMS ARE EXCLUDED: a room page is a live, per-venue queue with a
 * guessable slug. Indexing it invites strangers into a venue's queue, and since
 * rooms are ephemeral the indexed URL later renders the "room does not exist"
 * page — thin, soft-404 content accumulating under the brand. There is no SEO
 * upside to offset either.
 *
 * KNOWN LIMIT, STATED HONESTLY: `Disallow` prevents CRAWLING, not indexing — a
 * disallowed URL can still appear as a bare link if something external points
 * at it, and a crawler that is blocked can never see a `noindex` meta tag. The
 * strictly correct pairing is `noindex` on the room pages themselves, which
 * lives in `app/(patron)/[room]/**` — outside this ticket's file boundary and
 * filed as a follow-up. This is the strongest control available from here.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: [
        "/$",
        "/new$",
        // Advertised in `sitemap` below; `Disallow: /` would otherwise block it.
        "/sitemap.xml",
        // Let crawlers fetch what they need to render and preview the allowed
        // pages; blocking these makes the homepage look broken to a renderer.
        "/_next/",
        "/brand/",
        "/icon.png",
        "/apple-icon.png",
        "/manifest.json",
      ],
      disallow: "/",
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
