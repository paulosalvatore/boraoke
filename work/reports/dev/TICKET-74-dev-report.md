# TICKET-74 dev report — metadata + SEO refresh (carries TICKET-73)

**Branch:** `ticket/74-metadata-seo-refresh` · **Worktree:** `.worktrees/ticket-74` · **Port:** 3185

## Files changed

| File | Change |
|---|---|
| `messages/pt-BR.json`, `messages/en.json`, `messages/es.json` | `Meta.title` / `Meta.description` / `Meta.ogDescription` rewritten; `Landing.freePromise` softened |
| `app/metadata.ts` | pt-BR baseline copy synced to the catalog; `viewportFit: "cover"` added (TICKET-73); stale hreflang comment replaced with the real reasoning |
| `app/sitemap.ts` | **new** — real sitemap for `/` and `/new` |
| `app/robots.ts` | **new** — replaces the static file; allowlist policy |
| `public/robots.txt` | **deleted** — superseded by `app/robots.ts` (a `public/` file and a metadata route cannot share a path) |
| `__tests__/metadata.test.ts` | +33 tests: char limits, tri-locale key presence, source-drift pin, bar-only guard, free-forever guard, sitemap/robots contracts, `viewportFit` |

`app/generate-metadata.ts` needed no change — it already reads the `Meta` catalog, so the copy rewrite flows through it. `components/FeedbackWidget.tsx`, `components/feedback/**`, `e2e/feedback-widget-safe-area.spec.ts`, `app/page.tsx`, `app/globals.css`, `components/tv/**` were **not** touched.

## Copy: before → after, with measured counts

Counts are user-perceived characters (`[...s].length`), measured from the **served HTML**, not the source.

### pt-BR
| | Before | After | Count |
|---|---|---|---|
| title | `Boraoke — a fila de karaokê do seu bar` | `Boraoke — a fila do karaokê na TV, no celular de todos` | **54** / 60 |
| description | `A fila de karaokê do seu bar, no celular de cada cliente. Crie a sala, mostre o QR, e todo mundo entra na fila com a mesa marcada. Grátis para começar.` | `Bar, festa, condomínio ou empresa: cada pessoa escaneia o QR e escolhe a música no celular. A TV toca a fila sozinha, em rodízio justo. Sem app, grátis.` | **152** / 160 |
| ogDescription | `A fila de karaokê do seu bar, no celular de cada cliente. Grátis para começar.` | `Cada pessoa escaneia o QR e escolhe a música. A TV toca a fila sozinha, em rodízio justo. Grátis.` | **97** / 100 |

### en
| | Before | After | Count |
|---|---|---|---|
| title | `Boraoke — your bar's karaoke queue` | `Boraoke — the karaoke queue on the TV, on everyone’s phone` | **58** / 60 |
| description | `Your bar's karaoke queue, on every customer's phone. Spin up the room, show the QR, and everyone joins the line with their table tagged. Free to start.` | `Bar, party, building or office: everyone scans the QR and picks a song on their phone. The TV plays the queue by itself, on a fair rotation. No app, free.` | **154** / 160 |
| ogDescription | `Your bar's karaoke queue, on every customer's phone. Free to start.` | `Everyone scans the QR and picks a song. The TV plays the queue by itself, on a fair rotation. Free.` | **99** / 100 |

### es
| | Before | After | Count |
|---|---|---|---|
| title | `Boraoke — la fila de karaoke de tu bar` | `Boraoke — la fila del karaoke en la TV, en cada celular` | **55** / 60 |
| description | `La fila de karaoke de tu bar, en el celular de cada cliente. Crea la sala, muestra el QR y todos entran a la fila con su mesa marcada. Gratis para empezar.` | `Bar, fiesta, edificio u oficina: cada persona escanea el QR y elige su canción en el celular. La TV toca la fila sola, en rotación justa. Sin app, gratis.` | **154** / 160 |
| ogDescription | `La fila de karaoke de tu bar, en el celular de cada cliente. Gratis para empezar.` | `Cada persona escanea el QR y elige su canción. La TV toca la fila sola, en rotación justa. Gratis.` | **98** / 100 |

### Free-promise softening
| Locale | Before | After |
|---|---|---|
| pt-BR | `Tudo o que existe hoje é grátis — e continua grátis.` | `Tudo o que existe hoje é grátis, no acesso antecipado.` |
| en | `Everything that exists today is free — and stays free.` | `Everything that exists today is free, in early access.` |
| es | `Todo lo que existe hoy es gratis — y sigue gratis.` | `Todo lo que existe hoy es gratis, en el acceso anticipado.` |

Every claim maps to a shipped feature: QR join without an app, phone song-picking, `/tv` auto-advance, fair rotation. No accounts, theming, venue presets or payments are implied.

## SEO findings

### `/sitemap.xml` was a soft-200 — confirmed by body, not status

Live production, before this change:

```
HTTP/2 200
content-type: text/html; charset=utf-8
x-matched-path: /[room]
```

Body was the room-not-found page (`Essa sala não existe (ou o link está errado).`), 26,209 bytes of HTML. The 200 came from the dynamic `[room]` route swallowing the path. **No sitemap existed** despite `robots.txt` advertising one since TICKET-33.

After, served from the branch build:

```
HTTP/1.1 200 OK
content-type: application/xml

<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://boraoke.com/</loc><changefreq>weekly</changefreq><priority>1</priority></url>
<url><loc>https://boraoke.com/new</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>
</urlset>
```

The metadata route takes precedence over `[room]` — verified at runtime, not assumed.

### `robots.txt` — static file → `app/robots.ts`

Justification: the static file hardcoded the origin, a second copy of `SITE_URL` free to drift. As a route it imports the constant, so the origin is stated once and sits beside `app/sitemap.ts`.

Served output:

```
User-Agent: *
Allow: /$
Allow: /new$
Allow: /sitemap.xml
Allow: /_next/
Allow: /brand/
Allow: /icon.png
Allow: /apple-icon.png
Allow: /manifest.json
Disallow: /

Sitemap: https://boraoke.com/sitemap.xml
```

Three defects the Reviewer caught in the first version of this file, all fixed and all now regression-tested:

1. `Allow: /new` was a **prefix** rule, so it allowed `/new-year-party`, `/newton-bar` and any room slug starting with "new" — only the exact id `new` is reserved, so those rooms are creatable. Now `/new$`.
2. `Disallow: /` blocked `/sitemap.xml`, the very file the `Sitemap:` line advertises (a blocked sitemap is a reported Search Console error). Now explicitly allowed.
3. A doc comment claimed a parser ignoring `$` "falls back to fully-permissive behaviour, never something stricter". That is **false** — see the tradeoff below. Comment corrected.

**Known, deliberate tradeoff — the `$` end-anchor.** Blocking arbitrary root-level room slugs while allowing `/` is *only* expressible with the `$` end-anchor; no formulation achieves it without one. `$` is standardised (RFC 9309 §2.2.3) and supported by Google, Bing and Yandex. But a parser that does **not** implement `$` reads `/$` as a literal prefix, matches nothing, falls through to `Disallow: /` and blocks the site — it fails **closed**, not open. Demonstrated with Python's stdlib `urllib.robotparser` (no `$` support) against the served file:

```
  BLOCK  /                             <-- naive parser: homepage blocked
  BLOCK  /new                          <-- naive parser: blocked
  ALLOW  /sitemap.xml
  BLOCK  /bar-do-ze                    ✓ intended
  BLOCK  /new-year-party               ✓ intended (the MAJOR-1 regression)
  BLOCK  /newton-bar                   ✓ intended
  BLOCK  /default, /default/admin, /default/tv, /admin   ✓ intended
  ALLOW  /_next/…, /brand/…, /manifest.json              ✓ intended
```

Every room/host path is blocked as intended. The two "mismatches" are the fail-closed behaviour on a parser with no `$` support. For the crawlers this ticket targets the policy is exactly right; **this is a judgement call and the TL can reverse it** — reverting to a permissive `Allow: /` re-exposes room pages to indexing until a per-page `noindex` lands (follow-up 2).

### hreflang — deliberately NOT added

Not a gap that can be closed here. hreflang annotates **distinct URLs** per language. This app serves all three locales from the **same** URL — locale comes from the `NEXT_LOCALE` cookie / `Accept-Language` (`i18n/locales.ts`), a documented deliberate choice so room URLs stay `/<room>`. Three hreflang entries pointing at one URL is invalid and ignored. Real hreflang needs per-locale URLs — a routing change. Confirmed empirically: the rendered `<head>` contains no `<link rel="alternate">`, before or after.

### Canonical — deliberately NOT added globally

`generateMetadata` is the **root layout's**, applies to every route, and a layout receives no pathname. One `alternates.canonical` there would declare `/new` and every room page canonical to the homepage — worse than none. Needs per-page metadata, outside this boundary.

### Per-room noindex — reasoned call

Rooms **should not** be indexed: a live per-venue queue with a guessable slug, ephemeral (expires on server restart), so an indexed URL later renders the not-found page — thin soft-404 content under the brand, with zero SEO upside.

Implemented as far as this boundary allows: `Disallow: /` with an allowlist. **Stated plainly:** `Disallow` blocks crawling, not indexing — a blocked URL can still appear as a bare link, and a blocked crawler can never read a `noindex` tag. The strictly correct pairing is `robots: { index: false }` on the room pages (`app/(patron)/[room]/**`), outside this ticket's files. Follow-up.

## TICKET-73 — what I verified, and what I could NOT

**Verified (real output):** the rendered meta tag is `width=device-width, initial-scale=1, viewport-fit=cover` in all three locales.

**Could NOT verify — stated plainly.** I could not empirically prove that `env(safe-area-inset-*)` goes from inert to live, and the method the ticket suggests does not work. Probing under Chromium's `Emulation.setSafeAreaInsetsOverride`, insets resolve to `47px` / `34px` on **both** live production (no `viewport-fit`) and this branch:

| | meta viewport | env top | env bottom | feedback spacer |
|---|---|---|---|---|
| production (before) | `width=device-width, initial-scale=1` | 47px | 34px | 34px |
| this branch (after) | `…, viewport-fit=cover` | 47px | 34px | 34px |

The CDP override forces the insets regardless of `viewport-fit`, so it cannot distinguish "wired but inert" from "wired and active" — exactly the gap TICKET-73 itself named. Confirming the real-device effect needs a real notched iPhone; that acceptance criterion is **not** met by this PR and I am not claiming it is. The change remains correct per the documented platform contract (`viewport-fit=cover` is the prerequisite for `env(safe-area-inset-*)` to resolve to non-zero on notched devices).

### Layout under `cover` at 390×844 — one real finding

No horizontal overflow anywhere (`scrollWidth` 390 = viewport 390 on every route). Topmost painted element per route, against a 47px notch band:

| Route | Topmost element | Verdict |
|---|---|---|
| `/` | language pill, y 58 → 93 | clear |
| `/new` | language pill, y 48 → 83 | clear (1px) |
| `/default/admin` | `🎤 Boraoke · admin`, y 64 → 101 | clear |
| `/default` (patron room) | language pill, **y 32 → 67** | **~15px of its top edge falls inside the 47px notch band** |

`/[room]/tv` has two fixed elements (`tv` container at 0→844, `chrome` at 820→834); neither is in the notch band, and the TV screen is a large-display surface, not a phone target.

So: on a notched iPhone in portrait, the language-switcher pill on **patron room pages** would have its top partially under the status bar / notch. The reasoning for why this is a delta from `cover` (I could not test a real device): without `cover` the layout viewport origin sits *below* the notch, so y=32 is safe; with `cover` the origin is the physical screen top, so y=32 is under it. The fix is a `padding-top: env(safe-area-inset-top)` on the room container — in `app/(patron)/[room]/**` or `app/globals.css`, both **outside this ticket's file boundary**. Not fixed here; flagged for the TL and filed as a follow-up.

Screenshots: `work/reports/dev/TICKET-73-viewportfit-390x844-top.png`, `…-bottom.png`.

## Test output (observed, not paraphrased)

`npm test`:
```
Test Suites: 43 passed, 43 total
Tests:       717 passed, 717 total
Time:        2.356 s
```

`npx jest __tests__/metadata.test.ts`: **42 passed**, including `carries a Boraoke-branded title and description` — the `cantai` negative assertion, untouched and passing — and `opts into the full viewport so safe-area insets resolve (TICKET-73)`.

**Guards mutation-tested** (proving they are not vacuous):

| Mutation | Result |
|---|---|
| restore `— e continua grátis` to `freePromise` | `✕ pt-BR free-promise line states only the present tense` → 1 failed |
| drift `app/metadata.ts` description from the catalog | `✕ keeps app/metadata.ts identical to the pt-BR Meta catalog` → 1 failed |
| leak `Cantai` into the title | `✕ carries a Boraoke-branded title and description` (+1) → 2 failed |
| all reverted | `Tests: 42 passed, 42 total` |
| `Allow: /new$` end-anchor removed | `✕ blocks room pages, including slugs that merely start with a public path` |
| `Allow: /sitemap.xml` removed | `✕ keeps the advertised sitemap crawlable` |

`npx tsc --noEmit`: **zero errors** in `app/metadata.ts`, `app/robots.ts`, `app/sitemap.ts`. `__tests__/metadata.test.ts` reports only the repo-wide pre-existing `Cannot find name 'describe'/'it'/'expect'` class (`@types/jest` is not installed — ~2190-line baseline on `main`, out of scope). I deliberately rewrote my new tests from `it.each` to typed `for…of` loops to avoid adding 14 `TS7006`/`TS7053` errors that `it.each` produced without jest types.

`npm run build`: clean. `/robots.txt` and `/sitemap.xml` both register as `○ (Static)` routes.

`npx playwright test --retries=1` (PORT=3185, full suite):
```
Running 77 tests using 1 worker
  77 passed (11.0m)
```

**Note on an earlier red run.** A first full e2e run reported `31 failed / 46 passed (17.7m)`. That was resource contention, not this change: three sibling agents were running full Playwright suites concurrently (`ticket-72` on 3184, `ticket-75` on 3187, `ticket-77` on 3189) alongside mine — four Next dev servers plus browsers on one machine. Evidence it was environmental: the failures included `contrast.spec.ts › black text on white background resolves to 21:1`, pure math no diff can affect; the failure mode was `net::ERR_ABORTED; maybe frame was detached` during navigation; and no e2e spec references robots, sitemap, or any string I changed (`grep` over `e2e/` returns nothing for `robots|sitemap|freePromise|continua grátis|Meta.`). The clean 77/77 rerun confirms it.

## Follow-ups filed (not done here)

1. Per-page canonical URLs (needs per-page metadata exports).
2. `robots: { index: false }` on `app/(patron)/[room]/**` to make the noindex intent authoritative. **Sequencing note (raised by the Reviewer): this must be paired with RELAXING the robots `Disallow` on room paths**, because a crawler blocked from fetching a page can never read its `noindex` tag. The end state is stronger than today's, since `noindex` prevents indexing whereas `Disallow` only prevents crawling — but the two changes must land together, not in isolation.
3. `padding-top: env(safe-area-inset-top)` for the patron-room header, per the finding above.
4. Per-locale URLs if real hreflang is ever wanted.
5. `@types/jest` for the repo-wide tsc baseline.
6. `app/page.module.css:12` still has a comment calling it "the free-forever promise" — stale after the softening; that file is outside this boundary.
