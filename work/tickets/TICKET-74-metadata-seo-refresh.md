# TICKET-74 — align site metadata + SEO with the shipped venue-agnostic positioning

**Status:** IN REVIEW — implemented, gated, PR open
**Filed:** 2026-08-08
**Priority:** MED
**Size:** M
**Carries:** TICKET-73 (`viewportFit: "cover"`) — shipped in the same PR because it is a one-property change to the same `app/metadata.ts` viewport export.

## Why this exists

The site metadata was still bar-only and, as of the TICKET-69 landing rebuild, actively contradicted the page it describes.

Live before this ticket:

- title: `Boraoke — a fila de karaokê do seu bar`
- description: `A fila de karaokê do seu bar, no celular de cada cliente. Crie a sala, mostre o QR, e todo mundo entra na fila com a mesa marcada. Grátis para começar.`

The landing shipped as Direction 2 ("Demo vivo"), deliberately venue-agnostic — bar, festa, condomínio, empresa — with the hook *"A fila do karaokê na TV. O controle, na mão de todo mundo."* A visitor arriving from a search result reading "a fila do seu bar" and landing on a page that opens with venue chips gets two different products.

## What changed

### 1. Meta copy, all three locales

Rewritten against the shipped `Landing` voice, venue-agnostic, and advertising only what ships today (QR join + tables, YouTube search/paste, `/tv` auto-advance, three rotation modes, host controls, free). Nothing implies accounts, theming, venue presets or payments — none exist.

Both sources of the copy were updated and are now pinned together by a test:

- the `Meta` namespace in `messages/pt-BR.json` / `en.json` / `es.json` (consumed by `app/generate-metadata.ts` at request time), and
- `app/metadata.ts`, the static pt-BR baseline.

### 2. Free-tier copy no longer makes a forward-looking promise

`Landing.freePromise` said "e continua grátis" / "and stays free" / "y sigue gratis" — an open-ended commercial guarantee the business has not decided. Now states the present tense only. A regression test blocks the whole family of substitutes ("sempre", "forever", "no paywall", …).

### 3. `/sitemap.xml` was a soft-200, now real

`public/robots.txt` had advertised `https://boraoke.com/sitemap.xml` since TICKET-33, but no sitemap route ever existed. Because rooms are addressed at the root (`/<room>`), the dynamic `[room]` segment swallowed the request. Production returned **HTTP 200** — with `content-type: text/html` and `x-matched-path: /[room]`, serving the "Essa sala não existe" page. The status code was not evidence of a sitemap; only the body was.

`app/sitemap.ts` now serves the two genuinely public routes, `/` and `/new`. Room-scoped routes (`/[room]`, `/[room]/admin`, `/[room]/tv`) are deliberately NOT enumerated — they are dynamic, ephemeral and semi-private.

### 4. `robots.txt` moved to `app/robots.ts` and became an allowlist

Moved off the static file so the canonical origin is stated once (`SITE_URL`) instead of duplicated. Policy is an allowlist: `Allow: /$` (end-anchored, homepage only), `Allow: /new$`, `Allow: /sitemap.xml`, plus the asset paths a renderer needs, then `Disallow: /`. This keeps per-venue room pages out of search.

The end-anchors are load-bearing, not decoration. The Reviewer caught that the first version used `Allow: /new` — a **prefix** rule that allowed `/new-year-party`, `/newton-bar` and any room slug starting with "new" (only the exact id `new` is reserved, so those rooms are creatable), defeating the policy; and that `Disallow: /` blocked `/sitemap.xml`, the very file the `Sitemap:` line advertises. Both fixed, both now covered by tests that evaluate real paths through RFC 9309 matching rather than asserting the array contains a string.

**Deliberate tradeoff:** blocking arbitrary root-level room slugs while allowing `/` is only expressible with the `$` end-anchor. `$` is standardised (RFC 9309 §2.2.3) and supported by Google, Bing and Yandex, but a parser lacking it falls through to `Disallow: /` and blocks the site — it fails **closed**. Verified with Python's `urllib.robotparser`. Acceptable for the crawlers this targets; recorded so the TL can reverse it knowingly.

### 5. TICKET-73 — `viewportFit: "cover"`

Added to the viewport export. Without it `env(safe-area-inset-*)` resolves to `0` regardless of device, leaving the TICKET-71 feedback-pill safe-area spacer present in CSS but inert in production.

## Decisions taken, with reasoning

**hreflang: deliberately NOT added.** The brief flagged `alternates.languages` as a likely gap. It is not implementable here, and adding it would be wrong. hreflang annotates *distinct URLs* per language version. This app serves all three locales from the **same** URL — locale comes from the `NEXT_LOCALE` cookie / `Accept-Language` (`i18n/locales.ts`), and that is a documented deliberate choice so room URLs stay `/<room>` (no `[locale]` segment, no middleware rewrite). Three hreflang entries all pointing at one URL is invalid and is ignored. Real hreflang needs per-locale URLs — a routing change, not a metadata change. Recorded as a follow-up, not silently skipped.

**Canonical URL: NOT added globally.** `generateMetadata` lives in the ROOT LAYOUT and applies to every route, and a layout receives no pathname. A single `alternates.canonical` there would declare `/new` and every room page canonical to the homepage — worse than having none. A correct self-referential canonical must be per-page, in files outside this ticket's boundary. Follow-up.

**Per-room `noindex`: yes in intent, partially achievable here.** A room page is a live per-venue queue with a guessable slug; indexing invites strangers into a venue's queue, and because rooms are ephemeral the indexed URL later renders the room-not-found page — thin soft-404 content under the brand. Zero SEO upside. The `Disallow: /` allowlist in `app/robots.ts` is the strongest control available within this ticket's file boundary. **Stated honestly:** `Disallow` prevents crawling, not indexing — a blocked URL can still surface as a bare link, and a blocked crawler can never see a `noindex` tag. The strictly correct pairing is a `robots: { index: false }` export on the room pages themselves (`app/(patron)/[room]/**`), which is outside this boundary. Follow-up.

## Verification

- `npm test` — 43 suites, 717 tests, all passing.
- `npx tsc --noEmit` — zero errors in `app/metadata.ts`, `app/robots.ts`, `app/sitemap.ts`. The repo has a large pre-existing baseline of `Cannot find name 'describe'/'it'/'expect'` errors (`@types/jest` is not installed); that is out of scope and unchanged in kind by this ticket.
- `npm run build` — clean; `/robots.txt` and `/sitemap.xml` register as static routes.
- Rendered output verified by serving the production build and inspecting the real `<head>` in all three locales, plus the real `/sitemap.xml` and `/robots.txt` bodies.
- Guards mutation-tested: re-introducing "e continua grátis", drifting `app/metadata.ts` from the catalog, and leaking `cantai` each make the suite fail, and reverting restores green.

## Not in scope

- The `@types/jest` baseline.
- Per-page canonical + per-room `noindex` meta (needs files outside this boundary).
- Per-locale URLs / real hreflang (a routing change).
- en/es OG card images — still fall back to the pt-BR image, unchanged.
- Any analytics or third-party tag. None added.
