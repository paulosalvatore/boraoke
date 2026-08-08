# TICKET-74 (+ TICKET-73) — independent merge-gate review

**Verdict: APPROVE** (round 2 — see "Round 2" at the bottom)

Round 1 raised three MAJOR defects in `app/robots.ts`. All three are fixed, independently re-verified against a third-party robots parser and the running build, and each is now covered by a regression test that I mutation-tested myself. The remaining items are NITs, none merge-blocking.

The round-1 findings below are retained unedited as the record of what was raised and why.

---

## Round 1 (superseded — retained for the record)

**Round-1 verdict: CHANGES REQUESTED**

Three MAJOR defects, all confined to `app/robots.ts` (in-boundary, introduced by this change), all fixable in ~4 lines. Everything else in this PR is correct, well-tested and — unusually — honestly reported. The copy work, the character budgets, the tri-locale consistency, the sitemap, the `viewportFit` change, the hreflang/canonical reasoning and the file-boundary discipline all verified clean against independent re-derivation. The dev report over-claims nowhere and under-claims in one place.

Reviewed at `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-74`, branch `ticket/74-metadata-seo-refresh`. Note the work is **uncommitted in the working tree** (`git diff origin/main...HEAD` is empty; `git log origin/main..HEAD` is empty) — reviewed via `git diff HEAD` + the untracked files. That must be committed before merge.

---

## 1. Unit suite — re-run, real numbers

```
$ npm test
Test Suites: 43 passed, 43 total
Tests:       714 passed, 714 total
Time:        4.337 s
```

```
$ npx jest __tests__/metadata.test.ts --verbose
Test Suites: 1 passed, 1 total
Tests:       39 passed, 39 total
Time:        0.416 s
```

Matches the report's `43/714` and `39`. The verbose listing shows all 39 names, including `opts into the full viewport so safe-area insets resolve (TICKET-73)` and the five per-locale blocks × 3 locales. **PASS.**

## 2. The `cantai` negative assertion — intact, un-weakened, and strengthened

Original, at `HEAD:__tests__/metadata.test.ts:16`:

```js
expect(JSON.stringify(metadata.title)).not.toMatch(/cantai/i);
```

Current, at line 28 — **byte-identical**, only shifted down by the new imports. Not deleted, not loosened, not made vacuous. A *second*, stronger assertion was added at line 121 covering the whole `Meta` object in **all three** locales:

```js
expect(JSON.stringify(CATALOGS[locale].Meta)).not.toMatch(/cantai/i);
```

Live `cantai*` identifiers **not** renamed. `git grep -i cantai` returns 50 hits across `app/(patron)/[room]/PatronRoom.tsx`, `app/page.tsx` (`cantai_last_room`), `lib/host-auth.ts`, `lib/room-memory.ts`, `lib/rooms.ts`, `components/feedback/useFeedbackContext.ts`, `next.config.ts` (`cantai-snowy.vercel.app` 308 redirect), `e2e/*`. `git diff HEAD | grep -i cantai` returns exactly **one** line — the added test assertion. `next.config.ts` is not in `git status` at all. **PASS.**

## 3. Character counts — independently re-counted

Counted as user-perceived characters (code points and `Intl.Segmenter` graphemes agree on every string — no surrogate pairs or combining marks):

| Locale | key | count | limit | |
|---|---|---|---|---|
| pt-BR | title | **54** | 60 | OK |
| pt-BR | description | **152** | 160 | OK |
| pt-BR | ogDescription | **97** | 100 | OK |
| en | title | **58** | 60 | OK |
| en | description | **154** | 160 | OK |
| en | ogDescription | **99** | 100 | OK |
| es | title | **55** | 60 | OK |
| es | description | **154** | 160 | OK |
| es | ogDescription | **98** | 100 | OK |

Every number matches the dev report exactly. **PASS.**

## 4. `Meta` keys present in all three locales; no drift with `app/metadata.ts`

All three catalogs expose exactly `["title","description","ogDescription"]`. `app/metadata.ts`'s `title.default`, `description`, `openGraph.title/description`, `twitter.title/description` are string-identical to the pt-BR catalog — verified by reading both, and pinned by the test `keeps app/metadata.ts identical to the pt-BR Meta catalog`. That pin is the right guard for this two-source problem. **PASS.**

## 5. Claims match shipped features only

`Landing` (pt-BR) advertises: venue chips *No bar / Na festa / No condomínio / Na empresa*; `featuresLabel: "O que já funciona hoje"`; QR join with no app; any YouTube song by search or link; three rotation modes. The new metadata says exactly that and nothing more — venue list, QR scan, phone song-pick, TV auto-plays the queue, fair rotation, "Sem app", "grátis". Voice matches the landing (same nouns, same present tense).

No accounts, theming, venue presets or payments implied in any locale. "Sem app / No app / Sin app" is truthful (browser-only, `heroSub` says "Sem app, sem cadastro"). **PASS.**

## 6. Free-promise softening — verified, and the guard provably bites

All three softened, forward-looking guarantee removed, no `sempre`/`forever`/`no paywall` substitute:

| | before | after |
|---|---|---|
| pt-BR | `… é grátis — e continua grátis.` | `Tudo o que existe hoje é grátis, no acesso antecipado.` |
| en | `… is free — and stays free.` | `Everything that exists today is free, in early access.` |
| es | `… es gratis — y sigue gratis.` | `Todo lo que existe hoy es gratis, en el acceso anticipado.` |

**Mutation test (mine, not the implementer's).** Reverted pt-BR to `— e continua grátis.` and set en to `free forever, no paywall.`:

```
● free-tier copy makes no forward-looking promise (TICKET-74) › en free-promise line states only the present tense
    Expected pattern: not /continua gr[áa]tis|stays free|sigue gratis|forever|para sempre|…|sin paywall/i
    Received string:  "Everything that exists today is free — free forever, no paywall."

Tests: 2 failed, 36 skipped, 1 passed, 39 total
```

Both mutations caught. Files restored and `diff`-verified byte-identical to pre-mutation. The guard is **not vacuous**. **PASS.**

## 7. Sitemap + robots against a RUNNING app

`npm run build` exit 0. Route table registers both as static:

```
├ ○ /robots.txt        180 B   103 kB
├ ○ /sitemap.xml       180 B   103 kB
```

Served from `npx next start -p 3185`:

```
$ curl -sD - -o /dev/null http://localhost:3185/sitemap.xml
HTTP/1.1 200 OK
content-type: application/xml          <-- real XML, not the text/html soft-200
x-nextjs-cache: HIT

$ curl -s http://localhost:3185/sitemap.xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://boraoke.com/</loc><changefreq>weekly</changefreq><priority>1</priority></url>
<url><loc>https://boraoke.com/new</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>
</urlset>
```

```
$ curl -s http://localhost:3185/robots.txt      # content-type: text/plain
User-Agent: *
Allow: /$
Allow: /new
Allow: /_next/
Allow: /brand/
Allow: /icon.png
Allow: /apple-icon.png
Allow: /manifest.json
Disallow: /

Sitemap: https://boraoke.com/sitemap.xml
```

The metadata route **does** win over the dynamic `/[room]` route — and `[room]` still works alongside it (`/some-random-room` → 200 `text/html`). No room-scoped URL is enumerated in the sitemap. `lastModified` deliberately omitted rather than faked — good call. **PASS.**

## 8. Rendered `<head>`, all three locales (driven by `Accept-Language`)

| | `<html lang>` | title | og:locale |
|---|---|---|---|
| `pt-BR` | `pt-BR` | `Boraoke — a fila do karaokê na TV, no celular de todos` | `pt_BR` |
| `en-US,en` | `en` | `Boraoke — the karaoke queue on the TV, on everyone’s phone` | `en_US` |
| `es-ES,es` | `es` | `Boraoke — la fila del karaoke en la TV, en cada celular` | `es_ES` |

`description`, `og:title`, `og:description`, `og:url`, `og:site_name`, `og:image` (+ width/height/alt), `og:type`, `twitter:card|title|description|image` all present and locale-correct in every case. OG image falls back to `og-image-pt-BR.png` for en/es as documented.

Viewport meta, identical in all three:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
```

**TICKET-73 confirmed at the rendered-output level. PASS.**

## 9. SEO reasoning — hreflang and canonical

**hreflang omitted — I agree.** `i18n/locales.ts` documents the URL decision explicitly ("rooms are addressed as `/<room>` and that MUST NOT change … locale lives in the `NEXT_LOCALE` cookie, never in the path. No `[locale]` segment, no middleware rewrite"). `next.config.ts` calls `createNextIntlPlugin` with no i18n routing and adds only the host-matched `cantai-snowy.vercel.app` 308. `app/layout.tsx` derives `lang` from `getLocale()`, not a route param. So all three locales genuinely share one URL, and hreflang — which annotates *distinct* URLs — has nothing to annotate. Three entries pointing at one URL would be invalid. Confirmed empirically: no `rel="alternate"` in the rendered head. Correct call, and the replacement comment in `app/metadata.ts` states the reasoning accurately.

**Global canonical omitted — I agree.** `generateMetadata()` in `app/generate-metadata.ts` has signature `(): Promise<Metadata>` — it takes no props at all, and it is re-exported from the **root layout**, which has no dynamic segment and therefore no pathname. A single `alternates.canonical` there would apply to `/`, `/new`, `/[room]`, `/[room]/admin`, `/[room]/tv` alike and declare every one of them canonical to the homepage. That is strictly worse than no canonical. Correct call; correctly deferred to per-page metadata.

**PASS on both.**

## 10. `app/robots.ts` allowlist policy — THREE DEFECTS

Evaluated the served file with a real parser (`urllib.robotparser`) plus RFC 9309 reasoning:

```
BLOCK  /                       <-- see MAJOR-3
ALLOW  /new
ALLOW  /new-year-party         <-- see MAJOR-1 (a ROOM)
ALLOW  /newton-bar             <-- see MAJOR-1 (a ROOM)
BLOCK  /bar-do-ze
BLOCK  /bar-do-ze/admin
BLOCK  /bar-do-ze/tv
BLOCK  /sitemap.xml            <-- see MAJOR-2
ALLOW  /_next/static/x.js
ALLOW  /brand/og-image-pt-BR.png
ALLOW  /manifest.json
BLOCK  /tv    BLOCK  /admin    BLOCK  /admin/analytics    BLOCK  /api/rooms
```

The core intent works: arbitrary room slugs and their `/admin` + `/tv` sub-pages are blocked, assets needed to render the homepage are allowed, and the legacy `/tv`, `/admin`, `/api/*` routes are correctly out. The `$` end-anchor **is** valid and standard. But three things are wrong — details in the ranked list below.

**Not accidentally blocked:** nothing else important. `/robots.txt` shows BLOCK but that is irrelevant — RFC 9309 §2.3 makes robots.txt itself always fetchable.

## 11. File boundary — respected

```
$ git status --short
 M __tests__/metadata.test.ts
 M app/metadata.ts
 M messages/en.json
 M messages/es.json
 M messages/pt-BR.json
D  public/robots.txt
?? app/robots.ts
?? app/sitemap.ts
?? work/reports/dev/TICKET-73-viewportfit-390x844-{top,bottom}.png
?? work/reports/dev/TICKET-74-dev-report.md
?? work/tickets/TICKET-74-metadata-seo-refresh.md
```

Every entry is inside the permitted set. All FORBIDDEN paths verified untouched — `components/FeedbackWidget.tsx`, `components/feedback/**`, `e2e/feedback-widget-safe-area.spec.ts`, `app/page.tsx`, `app/page.module.css`, `app/globals.css`, `components/tv/**` produce an empty `git diff HEAD --stat`. `next.config.ts` untouched.

`messages/*.json` diffs are exactly **two hunks each** — the `Landing.freePromise` line and the three-line `Meta` block. Nothing else in any of the three files. Verified by reading the full `git diff HEAD -- messages/`. **PASS.**

## 12. Honesty of the dev report

Every reproducible claim checks out. Spot-verified independently:

- `43/714` and `39` test counts — exact.
- All 9 character counts — exact.
- Live sitemap/robots bodies quoted — exact match to what I curled.
- "no e2e spec references robots, sitemap, or any string I changed" — `grep -rniE "robots|sitemap|freePromise|continua grátis|stays free" e2e/` returns **nothing**. Claim holds.
- "the rendered `<head>` contains no `<link rel="alternate">`" — confirmed.
- Follow-up 6, the stale `app/page.module.css` comment calling it "the free-forever promise" — confirmed present at that location, and correctly left alone as out-of-boundary.

**The `viewportFit` runtime limitation is honestly disclosed and I reached the same conclusion.** The report explicitly refuses to claim the acceptance criterion is met, explains precisely why CDP's `Emulation.setSafeAreaInsetsOverride` cannot discriminate (it forces 47px/34px with and without `viewport-fit`), and rests the change on the documented platform contract instead. That is the correct posture. I could not devise a cheaper discriminating test either; a real notched device is genuinely required.

**The layout finding reproduces exactly.** At 390×844 against the branch build:

```
/          langPill= {"top":58,"bottom":93}   scrollWidth/vw= 390/390
/new       langPill= {"top":48,"bottom":83}   scrollWidth/vw= 390/390
/default   langPill= {"top":32,"bottom":67}   scrollWidth/vw= 390/390   <-- top edge inside the 47px notch band
```

Identical to the report's numbers, including the "clear (1px)" margin on `/new` and the no-horizontal-overflow claim. ~15px of the pill's top edge falls inside a 47px notch band on patron room pages. Correctly diagnosed, correctly identified as out-of-boundary to fix, correctly filed as a follow-up rather than silently patched.

**No claim in the report is over-stated.** It *under*-claims in one place: it presents the `Disallow`-vs-`noindex` gap as the only known limit of the robots policy, having missed the three defects in section 10 — an omission, not a misrepresentation.

**e2e:** `77 passed (11.0m)` with `--retries=1` is **implementer-reported only** — not re-run here, per instruction (sibling agents holding 3184/3187/3189). The report's explanation of the earlier `31 failed / 46 passed` run as resource contention is plausible and independently supported: `contrast.spec.ts › black text on white background resolves to 21:1` is pure arithmetic no diff can affect, and my own grep confirms no e2e spec touches any changed string.

---

## Issues, severity-ranked

### MAJOR-1 — `Allow: /new` prefix-leaks room pages back into the crawl (`app/robots.ts:20`)

Robots path rules are **prefix** matches unless `$`-anchored. `Allow: /new` therefore matches every room whose slug starts with `new`. `RESERVED_ROOM_IDS` only blocks the *exact* id `new`, so such rooms mint freely. Proven end-to-end against the running branch build:

```
$ curl -sX POST localhost:3185/api/rooms -d '{"name":"New Year Party"}'
{"id":"new-year-party","joinPath":"/new-year-party",…}

$ robotparser: ALLOW /new-year-party      ALLOW /newton-bar
```

This directly defeats the file's own stated policy ("The only way to keep venue rooms out of search is to disallow `/` and allow the known-public pages back in"). A venue named "New Year Party", "Newton Bar", "News Room"… gets its live queue crawled. Fix: `"/new$"`, and update the test at `__tests__/metadata.test.ts` (`expect(rules.allow).toContain("/new")` → `"/new$"`).

### MAJOR-2 — the robots.txt disallows the very sitemap it advertises (`app/robots.ts:20,33`)

`Disallow: /` matches `/sitemap.xml`; no `Allow` rule rescues it (`/$` is end-anchored and does not match). So the file ends with `Sitemap: https://boraoke.com/sitemap.xml` while its own rules forbid fetching that URL — a self-contradiction, and the documented cause of Search Console's "Sitemap could not be read / blocked by robots.txt". This nullifies the main deliverable of the ticket's sitemap half. Fix: add `"/sitemap.xml"` to the allow list. One line, zero risk.

### MAJOR-3 — the `$`-degradation claim in the doc comment is false, and provably so (`app/robots.ts:22-24`)

The comment asserts:

> `Allow: /$` … the `$` end-anchor is standard — RFC 9309 §2.2.2 — and a crawler that ignores it merely falls back to today's fully-permissive behaviour, **never to something stricter than intended**.

The opposite is true. A parser without `$` support reads `/$` as a literal prefix that matches no real path, so `Disallow: /` wins and **the homepage is blocked entirely**. Demonstrated:

```
$ python3 urllib.robotparser on the served file
BLOCK  /
```

That is strictly *stricter* than intended — the exact failure mode the comment rules out. Google and Bing do support `$`, so the primary crawlers behave as designed, and that (not graceful degradation) is the real justification. The code is defensible; the stated reasoning is not, and a false safety claim in a load-bearing comment is what future maintainers will trust. Fix: correct the comment to say `$` is required and that non-supporting crawlers will see a fully-disallowed site.

### NIT-1 — wrong RFC section cited (`app/robots.ts:23`)

`$` is defined in **RFC 9309 §2.2.3 "Special Characters"**, not §2.2.2 (which is "The 'Allow' and 'Disallow' Lines"). Verified against the published RFC.

### NIT-2 — work is uncommitted

`git log origin/main..HEAD` is empty; everything sits in the working tree with `app/robots.ts` / `app/sitemap.ts` untracked. Must be committed (via the sanctioned commit path) before this can merge.

### NIT-3 — two sitemap/robots tests are near-vacuous

`enumerates no room-scoped URL` and `allows no room-scoped path back in` assert only `not.toMatch(/\/admin|\/tv/)` against a hardcoded two-element list that can never contain them. They pass trivially. Not wrong, just not load-bearing — the real guard is `lists exactly the public, non-room routes`, which is strong. Worth noting only because MAJOR-1 is precisely the room-leak these two tests were meant to catch and structurally cannot.

---

## What I'd need to flip to APPROVE

Only `app/robots.ts`: `"/new$"`, add `"/sitemap.xml"`, correct the degradation comment (+ the §2.2.3 citation), and update the one assertion in `__tests__/metadata.test.ts`. Roughly four lines. Everything else in this PR is merge-ready and of high quality — in particular the two-source drift pin, the mutation-tested guards, and a dev report that names its own unproven acceptance criterion instead of papering over it.

---

# Round 2 — re-review after the fixes

**Verdict: APPROVE.**

## Suites re-run

```
$ npm test
Test Suites: 43 passed, 43 total
Tests:       717 passed, 717 total     (was 714 — +3 net from the robots rewrite)

$ npx jest __tests__/metadata.test.ts
Tests:       42 passed, 42 total       (was 39)
```

Matches the implementer's reported numbers exactly.

## Robots policy re-derived against the RUNNING build

Rebuilt (`npm run build`, exit 0) and served on 3185. `curl http://localhost:3185/robots.txt`:

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

`/sitemap.xml` still serves real `application/xml` with the same two-URL body, and the rendered `<head>` still carries `viewport-fit=cover` and the correct per-locale title in all three locales (re-checked after the rebuild).

**Cross-checked with an independent, `$`-aware third-party parser** (`robots-parser` from npm — deliberately NOT the matcher the test implements, so this is not self-referential):

```
ALLOW  /                            ALLOW  /_next/static/chunks/main.js
ALLOW  /new                         ALLOW  /brand/og-image-pt-BR.png
ALLOW  /sitemap.xml                 ALLOW  /manifest.json
BLOCK  /bar-do-ze                   ALLOW  /icon.png
BLOCK  /new-year-party      <-- MAJOR-1 fixed
BLOCK  /newton-bar          <-- MAJOR-1 fixed
BLOCK  /default    BLOCK  /default/admin    BLOCK  /default/tv
BLOCK  /admin      BLOCK  /admin/analytics  BLOCK  /api/rooms   BLOCK  /tv
```

All 17 verdicts agree exactly with the in-test `decide()` function, which discharges my round-1 concern about the test reimplementing the matcher — the reimplementation is faithful to a real parser. I also read `decide()` line by line: specificity = literal pattern length, `*` → `.*`, `$` → end-anchor, ties broken in favour of Allow. That is RFC 9309 §2.2.2 matching, correctly done.

**MAJOR-1 fixed** (`/new$` — room slugs starting with "new" now blocked). **MAJOR-2 fixed** (`/sitemap.xml` explicitly allowed). **MAJOR-3 fixed** — the comment now states the true failure mode ("fails CLOSED, blocking the whole site rather than over-allowing it") and cites **§2.2.3**, which is correct (NIT-1 resolved).

## Regression guards — mutation-tested by me, independently

| Mutation I applied to `app/robots.ts` | Result |
|---|---|
| `"/new$"` → `"/new"` | `✕ blocks room pages, including slugs that merely start with a public path` → `1 failed, 41 passed` |
| removed `"/sitemap.xml"` | `✕ keeps the advertised sitemap crawlable` → `1 failed, 41 passed` |
| restored | `diff` byte-identical; `42 passed, 42 total` |

Both new guards bite. They are the real thing, not string-containment assertions — and note that these are precisely the two regressions the round-1 tests structurally *could not* catch (NIT-3 resolved).

## The `$` tradeoff — I agree with the call. Keep the allowlist.

Reproduced the fail-closed behaviour myself with the legacy non-`$` parser against the served file: `BLOCK /`, `BLOCK /new`. So the tradeoff is real and is stated accurately in both the code comment and the report.

I consider keeping the allowlist the **right** call, for three reasons:

1. **The goal is genuinely inexpressible without `$`.** Rooms live at the root, so "allow `/` but not `/<slug>`" has no unanchored formulation. This isn't a stylistic preference; there is no alternative construction.
2. **The failure direction is the safe one.** A non-`$` parser under-crawls a pre-launch marketing page — recoverable, low-cost, invisible to the business. The permissive alternative's failure is live per-venue queues indexed under the brand, later decaying into soft-404s — which is the harm the ticket exists to prevent, and it is not cheaply reversible once indexed.
3. **`$` is standardised and universally supported by the crawlers that matter.** Google, Bing and Yandex all implement it; they account for essentially all meaningful organic traffic to a Brazilian consumer product.

Shipping a permissive `Allow: /` and relying solely on a future per-page `noindex` would be the wrong order: it accepts a live, known exposure now in exchange for a control that does not exist yet. Don't do that.

**Forward note (not a change request).** There is a real tension between this policy and follow-up 2 (`robots: { index: false }` on `app/(patron)/[room]/**`): a crawler blocked by `Disallow` can never *read* a `noindex` tag. So when that follow-up lands, the correct end state is to **relax** robots on room paths so crawlers can fetch them and see the `noindex` — which is strictly stronger than blocking, since `noindex` prevents indexing whereas `Disallow` only prevents crawling. Worth capturing on that follow-up ticket so the two changes aren't made in isolation. The report states the crawling-vs-indexing distinction correctly but doesn't draw out this sequencing consequence.

## Dev report + ticket integrity

`work/reports/dev/TICKET-74-dev-report.md` reads as a **single clean document**, 208 lines. Every `#`/`##`/`###` heading occurs exactly once (checked by extracting and de-duplicating all headings) — no duplicated body, no truncated section. The reported corruption is genuinely repaired.

Its numbers match what I observed: `43 suites / 717 tests`, `42` in the metadata suite, the served robots body verbatim, and the legacy-parser `BLOCK /` + `BLOCK /new` output. The mutation table was extended with the two new robots rows, both of which I reproduced. The new robots section credits the three defects to review and documents the tradeoff without minimising it. Still no over-claiming anywhere; the `viewportFit` real-device limitation is still stated plainly rather than quietly dropped now that the rest is green.

## `cantai` — re-confirmed

Both assertions present and passing (`__tests__/metadata.test.ts:28` original byte-identical, `:121` the tri-locale one). `git diff HEAD | grep -i cantai` still returns exactly **one** line — the added assertion. `next.config.ts`, `app/page.tsx`, `lib/**`, `components/**` all produce an empty diffstat, so no `cantai*` product identifier moved.

## Boundary — still respected

`git status --short` unchanged in shape from round 1: only `__tests__/metadata.test.ts`, `app/metadata.ts`, the three `messages/*.json`, the deleted `public/robots.txt`, the two new `app/{robots,sitemap}.ts`, and `work/**` artefacts. No forbidden path touched.

## Remaining items (all NIT, none blocking)

- **NIT-2 (carried):** work is still uncommitted. Expected — the implementer commits after APPROVE, then opens the PR. Must be committed via the sanctioned `commit` skill before merge.
- **NIT-4 (new, cosmetic):** `work/tickets/TICKET-74-metadata-seo-refresh.md` "Verification" still says `43 suites, 714 tests`; the actual figure is now **717** (the dev report is correct at 717). One-number staleness in the ticket file. Fix while committing if convenient — not worth a round trip on its own.
- **NIT-1 and NIT-3 from round 1 are resolved.**

## Bottom line

Approved. The three MAJORs are genuinely fixed rather than papered over, the fixes are regression-tested with guards I confirmed bite, the policy now behaves correctly under a real independent parser, and the one deliberate tradeoff is both correctly reasoned and honestly surfaced for the TL rather than buried. Good work on the turnaround.
