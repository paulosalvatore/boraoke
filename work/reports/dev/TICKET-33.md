# TICKET-33 — Dev Report: Boraoke code rebrand + publish metadata

Status: IMPLEMENTED — local suite + e2e green; PR open; awaiting CI-green then gates.
Branch: `ticket/33-code-rebrand` · Worktree: `.worktrees/ticket-33b`
Base: `main` (rebased onto `e2977f4`, the merged design-v2 #18).

## Picking up from
Fresh Dev on this ticket. Branched from a stale local `main`; re-fetched and rebased onto the just-merged design-v2 (#18) so the rebrand lands on the current design system. PR #19 (brand-assets, `public/brand/**`) is still OPEN — I did NOT touch `public/brand/**` or `work/design/**`; icon generation reads the brand source from `origin/ticket/33-brand-assets` without committing it.

## What changed (rename inventory)

### Renamed cantai → Boraoke/boraoke
- `package.json` `name` → `boraoke`; dev-server temp localstorage path `/tmp/cantai-ls.json` → `/tmp/boraoke-ls.json`. `package-lock.json` name field followed.
- `playwright.config.ts` webServer temp path `/tmp/cantai-ls-<PORT>.json` → `/tmp/boraoke-ls-<PORT>.json`.
- Visible wordmarks/strings: landing `🎤 Boraoke` + footer byline; patron room `🎤 Boraoke` (×2); admin `🎤 Boraoke · admin` + top-bar wordmark `Boraoke`; room-not-found `🎤 Boraoke` + venue fallback `"Boraoke"`; TV wordmark `Boraoke` (×2) and **`powered by Boraoke`** byline (×2, the growth-loop footer); TvScreen `joinLabel` fallback `"cantai"` → `"boraoke.com"`.
- Metadata titles: root default `Boraoke — a fila de karaokê do seu bar` + template `%s · Boraoke`; TV page title `TV` → renders `TV · Boraoke`.
- README: title, description, live URL → **https://boraoke.com** (vercel apex noted as redirecting), telemetry-section brand, port note.
- `.env.example` header + new canonical-domain section.
- run-app skill description + the "powered by Boraoke" note.
- Internal workspace package `@cantai/rotation-engine` → **`@boraoke/rotation-engine`** (package.json + its package-lock + README, plus the 4 app-side references: `lib/rotation.ts`, `lib/rotation-modes.ts`, `tsconfig.json` path alias, `jest.config.ts` moduleNameMapper). Fully self-contained — the package is never npm-installed, it resolves purely via the path alias + jest mapper. All rotation tests still pass, confirming resolution.
- Comment-only: `tv.module.css` "cantai.css" → "brand"; `config.ts` powered-by comments.

### Deliberately KEPT (with explanatory code comments) — storage-key decision
The `cantai*` **localStorage keys** (`cantai_patron_uuid`, `cantai_nickname`, `cantai_last_room`, `cantai_mode`, `cantai_room`, `cantai:<room>:nick|table`) and the **host cookie** (`cantai_host` / `cantai_host_<room>`) plus the **HMAC salt strings** (`cantai-host-session-v1`, `cantai-hostcode-v1`, `cantai-dev-host`) are LIVE STATE on real users' devices. Renaming the localStorage/cookie keys logs every existing patron/host out and loses their identity; rotating the HMAC salts invalidates every issued session cookie. I judged the read-old-write-new migration NOT worth the risk/churn for a cosmetic key rename, and kept them as-is with `STORAGE-KEY NOTE (TICKET-33 ...)` comments at each site (`PatronRoom.tsx`, `useFeedbackContext.ts`, `lib/host-auth.ts`). Documented in the ticket for a future migration if ever desired.

### Not applicable / not touched
- **`--brand-name` design token:** the merged design-v2 (#18) defines no such token — nothing to wire; wordmark text stays inline. Not inventing one (out of scope).
- **CSS module class prefixes:** no `cantai`-prefixed class names exist (design-v2 uses generic names). Only a stale comment updated.
- **Historical `work/` docs** (`work/tickets/TICKET-*.md`, past reports): left as-is — they are the historical record under the old brand.

## Publish-readiness metadata
- `app/metadata.ts` (split out of `app/layout.tsx` so it's unit-testable without CSS/client imports): `metadataBase = https://boraoke.com`, pt-BR title template + description, OpenGraph (type/siteName/locale `pt_BR`/url/title/description/image `/brand/og-image.png` 1200×630) and Twitter `summary_large_image` → same image, `manifest: /manifest.json`. **en/es OG variants + hreflang deferred to i18n wave-30** as scoped; pt-BR is the default now. `<html lang="pt-BR">`; `viewport.themeColor = #0D0A14`.
- Favicons via App-Router file convention: `app/icon.png` (32) + `app/apple-icon.png` (180), generated with `sips` from the square brand `app-icon.png` (1024²). PWA icons `public/icons/icon-192.png` + `icon-512.png`.
- `public/manifest.json`: name Boraoke, theme/bg `#0D0A14`, pt-BR, standalone, 192/512 icons (`any maskable`).
- `public/robots.txt`: `Allow: /` + sitemap host.
- NOTE: OG image path `/brand/og-image.png` resolves once PR #19 (brand-assets) merges into main; the metadata + tests are correct now.

## Canonical domain
- `next.config.ts` `redirects()`: host-matched (`cantai-snowy.vercel.app`) permanent **308** → `https://boraoke.com/:path*`, path + query preserved. Verified live: `HTTP/1.1 308` → `location: https://boraoke.com/bar-do-ze?x=1`; normal-host traffic not redirected.

## Tests
- Added `__tests__/metadata.test.ts` (node-env; imports `@/app/metadata`): asserts Boraoke title/template, canonical `metadataBase`, OG image + siteName + `pt_BR` locale, Twitter card, manifest ref, theme color, and NO `cantai` in the title. 6 cases.
- No test assertions referenced the visible cantai wordmark; the only remaining `cantai` in tests is the intentionally-kept `cantai-dev-host` DEV_TOKEN in e2e.

### Self-verification (local)
- `npm run build`: PASS (Next detects `/icon.png` + `/apple-icon.png` static routes).
- `npm test`: **24 suites / 354 tests PASS** (incl. new metadata.test.ts + rotation-adapter after the scope rename).
- Rotation engine `node --test` (packages/rotation-engine): **59/59 PASS**.
- `PORT=3033 npm run test:e2e`: **28/28 PASS**. Servers stopped after.
- Manual endpoint checks: `/icon.png` `/apple-icon.png` 200 image/png; `/manifest.json` 200 json; `/robots.txt` 200; TV page shows `powered by Boraoke`, zero `cantai` text.

## Evidence
`work/evidence/ticket-33/`: 01 landing (Boraoke wordmark + `Boraoke — a fila de karaokê do seu bar` title), 02 TV playing (`powered by Boraoke` byline), 03 patron header, 04 TV idle byline, 05 favicon (32px).

## TM follow-up actions (env — TM owns)
- Set `NEXTAUTH_URL` → `https://boraoke.com` when auth is wired (no auth env exists in the app today; flagged forward).
- Add `boraoke.com` to Google OAuth authorized JS origins + redirect URIs (when OAuth lands).
- OG image `/brand/og-image.png` depends on PR #19 (brand-assets) being merged into main for the asset to exist at runtime.

## CI
See PR thread for the verbatim `gh pr checks` output (CI-green contract).
