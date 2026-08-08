import type { MetadataRoute } from "next";
import { SITE_URL } from "./metadata";

/**
 * Sitemap (TICKET-74).
 *
 * WHY THIS FILE EXISTS: `public/robots.txt` has been advertising
 * `https://boraoke.com/sitemap.xml` since TICKET-33, but no sitemap route ever
 * existed. Because rooms are addressed at the ROOT (`/<room>`), the dynamic
 * `[room]` segment swallowed the request: `/sitemap.xml` returned HTTP **200**
 * with `content-type: text/html` and `x-matched-path: /[room]` — the
 * "Essa sala não existe" room-not-found page, i.e. a soft-200, not a sitemap.
 * A 200 status was therefore NOT evidence of a sitemap; only the body was.
 * This file makes the advertised URL real. (A root metadata route takes
 * precedence over the dynamic `[room]` match — asserted in the PR's rendered
 * `/sitemap.xml` check, not assumed.)
 *
 * WHAT BELONGS IN IT — only genuinely public, stable, indexable URLs:
 *
 *   `/`     the landing page.
 *   `/new`  the create-a-room form; a real, linkable public entry point.
 *
 * WHAT MUST NEVER BE ENUMERATED HERE — everything room-scoped
 * (`/<room>`, `/<room>/admin`, `/<room>/tv`) and the legacy `/tv` + `/admin`
 * redirects. Room URLs are per-venue, ephemeral (a room can expire when the
 * server restarts) and semi-private: a live venue queue is not a search result.
 * They are additionally Disallow-ed in `app/robots.ts`. Listing a URL in a
 * sitemap while disallowing it in robots.txt is a direct contradiction, so this
 * list and that one are deliberately kept consistent.
 *
 * `lastModified` is intentionally omitted rather than faked with `new Date()`:
 * a build-time "now" claims every page changed on every deploy, which is a lie
 * crawlers learn to discount.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/new`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
  ];
}
