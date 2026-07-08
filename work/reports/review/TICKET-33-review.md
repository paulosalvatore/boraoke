# TICKET-33 — Reviewer Report: Boraoke code rebrand + publish metadata (PR #20)

Reviewed at tip `5049b45` (`ticket/33-code-rebrand`, worktree `.worktrees/ticket-33b`), diff read locally against merge-base `e2977f4` (git-local-first, zero API diff reads). Date: 2026-07-08.

## Verdict: APPROVE

Gate preconditions verified before review: CI green ×2 (verbatim `gh pr checks 20` in thread — required `build-and-test` pass at both `770818b`-era and post-reconciliation runs), App Tester PASS (`work/reports/testing/TICKET-33-app-test.md` + `apptester-0*.png` on branch, spot-viewed: landing wordmark + TV byline match claims), Security TM-waived N/A-by-content (assessed below — waiver holds).

## 1. Claims verified — my own runs (all at `5049b45`, after `npm ci`)

- `npm test`: **24 suites / 354 tests PASS** (includes new `__tests__/metadata.test.ts`).
- Rotation engine `node --test`: **59 pass / 0 fail**.
- `npm run build`: PASS (static + dynamic routes emitted, icon routes detected).
- `PORT=3033 npm run test:e2e`: **28 passed (1.3m)**. Server stopped after.

## 2. Redirect implementation (`next.config.ts` `redirects()`) — correct, not an open redirect

Implementation is a config-level redirect (not middleware): `source: "/:path*"` + `has: [{type: "host", value: "cantai-snowy.vercel.app"}]` → `destination: "https://boraoke.com/:path*"`, `permanent: true` (308). My own live checks against `next dev -p 3033`:

- Old host `/bar-do-ze?x=1&y=2` → `308`, `location: https://boraoke.com/bar-do-ze?x=1&y=2` (path + query preserved); root `/` → `308 https://boraoke.com`.
- **No open redirect:** destination host is a FIXED literal; only `:path*` interpolates. `X-Forwarded-Host: evil.com` on a matching request still yields `location: https://boraoke.com/a` — no header controls the target.
- **No loop:** `Host: boraoke.com` → 200, never matched (host matcher is the old vercel apex only). Worst case of Host-header spoofing is a single 308 to the canonical host on the attacker's own request.
- **Preview hosts unaffected:** `Host: boraoke-git-…-projects.vercel.app` → 200, no redirect — PR previews stay on the preview URL (exact-value host match; verified the compiled regex in the build manifest also excludes `/_next`).
- **Security waiver assessment: holds.** No new inputs/endpoints/secrets; the only security-adjacent surface is this redirect, and it is fixed-target, pass-through-only, loop-free. Storage keys / cookies / HMAC salts deliberately unchanged (no session invalidation).
- Note: `www.boraoke.com` is not covered — that is Vercel domain-config territory (TM follow-up, not code).

## 3. Rename completeness — source-level grep

`grep -rni cantai` over app/components/lib/e2e/config (excluding `work/` history, lockfiles, node_modules): **zero user-visible stragglers** — no UI strings, error messages, aria-labels, or API strings. All remaining hits are (a) the deliberately-kept storage/cookie keys + HMAC salts, (b) explanatory comments, (c) historical `work/` docs, (d) `CLAUDE.md` process file (product slug tied to the framework registry — out of scope, flagged to TM), (e) rotation-engine internal prose (nit 1 below).

## 4. `@cantai` → `@boraoke/rotation-engine`

Zero `@cantai` references remain. All seven resolution sites coherent (`package.json` + lock + README, `tsconfig.json` path alias, `jest.config.ts` moduleNameMapper, `lib/rotation.ts`, `lib/rotation-modes.ts`). Package is path-alias-only (never npm-installed) so the rename is self-contained; rotation tests passing confirms resolution.

## 5. Storage-key keep decision

Correct call (renaming live localStorage/cookie keys or rotating HMAC salts orphans every patron/host session for a cosmetic rename). `STORAGE-KEY NOTE (TICKET-33)` guard comments present at `PatronRoom.tsx`, `app/page.tsx`, `useFeedbackContext.ts`, `lib/host-auth.ts`. App Tester independently verified continuity through the real UI. One coverage gap: `lib/rooms.ts:67` (`cantai-hostcode-v1` salt) has no note at its own site (nit 2).

## 6. Metadata quality

- `metadataBase = https://boraoke.com` fixed for all environments — correct choice: preview deployments emit prod-absolute OG URLs rather than leaking preview hostnames; App Tester confirmed the rendered `og:image` is absolute.
- Title default + `%s · Boraoke` template working (TV renders `TV · Boraoke`); pt-BR description; OG type/siteName/locale/url/image(1200×630 + alt); Twitter `summary_large_image`; `manifest`/`robots.txt` present and valid; `<html lang="pt-BR">`; `viewport.themeColor #0D0A14`. New unit test locks all of it including a no-`cantai` regression assert.
- OG image `/brand/og-image-pt-BR.png` 404s until PR #19 merges — known cross-PR dependency, correctly reconciled to #19's per-locale filename at `9f8879f`. **Merge #19 before/with #20.**

## 7. Rebase surface

Branch is 0 behind `origin/main`. File overlap with PR #19 is only `work/events/2026-07.jsonl` (append-only event log) — no `public/brand/**` / `work/brand/**` collision. Clean.

## Follow-ups (non-blocking) and nits

1. **favicon.ico (required follow-up, not a blocker):** no `public/favicon.ico`, so raw `/favicon.ico` falls into the `[room]` catch-all and returns 200 HTML (reproduced myself: `200 text/html`). Not a 3-line fix from this branch — it needs a real ICO binary generated from the brand source that lives in unmerged PR #19 (`sips` can't emit ICO). Browsers use the linked PNG icons so UX is unaffected. **Condition: ship a real `favicon.ico` (App-Router `app/favicon.ico` or `public/favicon.ico`) riding PR #19 or an immediate follow-up ticket.**
2. Nit: `packages/rotation-engine` — package renamed to `@boraoke/...` but `package.json` `description` ("for cantai venue modes"), the `cantai` keyword, and README body prose (×3) still carry the old brand in files this PR touched. Internal-only; fold into the favicon follow-up.
3. Nit: add a one-line STORAGE-KEY NOTE at `lib/rooms.ts` `hashHostCode` (the `cantai-hostcode-v1` salt site) — host-auth.ts's note says "in this file" and doesn't protect rooms.ts from a future "cleanup".
4. Optional: `manifest.json` `purpose: "any maskable"` combined — Lighthouse prefers separate `any` and `maskable` entries (maskable crops edges of a non-padded icon).
5. TM note: `www.boraoke.com` → apex redirect is Vercel domain config, not code; and `CLAUDE.md` / framework product slug still say `cantai` (framework-registry change, out of PR scope).

## Evidence relied on

- Own runs (§1) at `5049b45`; own redirect curls (§2); own greps (§3–4).
- `work/reports/dev/TICKET-33.md` (current: status, inventory, self-verification — matches the diff).
- `work/reports/testing/TICKET-33-app-test.md` + `work/evidence/ticket-33/apptester-0{1,3}*.png` (viewed).
- PR #20 thread: verbatim CI-green ×2, reconciliation note for #19's per-locale OG filename.

---

# D-022 OPUS SECOND PASS (merge-counting) — 2026-07-08

Second (opus, judgment-layer) pass over the sonnet APPROVE above. Reviewed at `origin/ticket/33-code-rebrand` tip `72d0728`, diff read locally against merge-base `e2977f4` (git-local-first). This is the identity the product ships to boraoke.com — reviewed as the last set of eyes.

## Verdict: APPROVE — merge-counting — with ONE required one-line condition (salt guard comment)

The rebrand is correct, complete, and safe to ship. I independently re-verified every gate claim and loaded the running app as a first-time visitor. The single required condition below is a one-line safety comment on an already-shipping, deliberately-unchanged file — it does not change behavior and does not warrant a re-review round; the TM may require the Dev to add it as a fast follow before or with merge and confirm the one-liner landed.

## Independent verification (my own runs, tip `72d0728`)

- `npx jest`: **24 suites / 354 tests PASS** (incl. `__tests__/metadata.test.ts`).
- Rotation engine `node --test`: **59 pass / 0 fail**.
- `npm run build`: PASS — `/icon.png` + `/apple-icon.png` static routes emitted, all API/dynamic routes present.
- Ran the app on `next dev` (dev script hardcodes `-p 3040`; `PORT` env is ignored — pre-existing, not a PR concern). Loaded landing, `/tv`, and a patron room; extracted the live DOM + `<head>`.

## The cutover moment — walked the deploy

- **QR / join-path shape.** Join URLs are built client-side as `${window.location.origin}/${roomId}` (`AdminRoom.tsx:60`) and `${origin}${path}` (`TvScreen.tsx:87`) — always at the apex, path `/<room>`. So:
  - **Post-DNS printed QRs** already encode `boraoke.com/<room>` (origin = the live host) — no redirect needed.
  - **Pre-cutover printed QRs** encode `cantai-snowy.vercel.app/<room>` → I live-tested `Host: cantai-snowy.vercel.app` `/bar-do-ze?x=1` → **308** → `location: https://boraoke.com/bar-do-ze?x=1`. Path AND query preserved. The redirect's `/:path*` → `/:path*` shape exactly covers the join-path shape. Old posters keep working. Confirmed.
- **No loop:** `Host: boraoke.com` → 200 (host matcher is the old vercel apex only). A live venue with phones/TVs already on `boraoke.com` is never redirected onto itself.
- **No open redirect:** `X-Forwarded-Host: evil.com` on a matching request still yields `location: https://boraoke.com/a` — destination host is a fixed literal, only `:path*` interpolates. Confirmed live.
- **SEO / social caching:** OG/Twitter absolute URLs render `https://boraoke.com/brand/og-image-pt-BR.png` and `og:url = https://boraoke.com` on every environment (metadataBase pin). A social scrape of the canonical host caches the canonical card; scrapes of the old vercel apex get 308'd to the canonical URL before the card is read. No stale-brand card can be cached from the canonical host.

## metadataBase pin — verified nothing else derives URLs from request host

`metadataBase = https://boraoke.com` is a hard literal in `app/metadata.ts` (`SITE_URL`). I grepped the URL-deriving surfaces: OG/canonical/Twitter URLs all flow through Next's metadata resolver off this pin — none read the request host. The only request-host consumers are the CLIENT-side join-URL builders (`window.location.origin`), which is exactly what you want (a phone joining a preview deploy joins that preview; a phone joining prod joins prod). The pin therefore breaks nothing: preview deploys emit prod-absolute OG URLs (shares of a preview point at prod — acceptable and arguably desirable), and no functional URL derivation depends on the request host in a way the pin corrupts.

## Brand-integrity — judged as a first-time visitor (live app)

- **Landing:** title `Boraoke — a fila de karaokê do seu bar`, `🎤 Boraoke` wordmark, strong pt-BR description ("no celular de cada cliente… Grátis para começar"), byline "Boraoke — early access". Reads as a finished, confident product identity.
- **TV:** `powered by Boraoke` byline (the growth-loop footer, formerly `powered by cantai` ×2), wordmark `Boraoke`, title `TV · Boraoke` (`%s · Boraoke` template working).
- **Patron room:** `🎤 Boraoke`; `/cantai/i.test(documentElement.innerHTML)` === **false** over the entire rendered HTML.
- Judgment: nothing feels unbranded, half-migrated, or unfinished. Wordmark placement is consistent across all three surfaces. Title/description copy quality is genuinely good, not placeholder. This identity is ready to be the face of the product.

## Kept `cantai_` internals — guard sufficiency

Guard comments present and sufficient at `PatronRoom.tsx`, `app/page.tsx`, `useFeedbackContext.ts`, `lib/host-auth.ts` (the cookie + `cantai-host-session-v1` salt). **One insufficient site — REQUIRED CONDITION:**

**R1 (required, one line).** `lib/rooms.ts:67` — `createHmac("sha256", "cantai-hostcode-v1")` in `hashHostCode`. This file is NOT touched by this PR, so it carries no `STORAGE-KEY NOTE`. The docstring at lines 60–65 explains it is a keyed HMAC that "doubles as the room's session-derivation secret in `lib/host-auth.ts`" but does NOT warn against renaming the salt. This salt is load-bearing twice over: rotating it invalidates every stored `hostCodeHash` (every room's host can no longer log in) AND breaks host-session derivation. host-auth.ts's note explicitly scopes itself to "in this file", so it does not protect rooms.ts from a future well-meaning "finish the rebrand" cleanup. Add one line at `hashHostCode`:
> `// STORAGE-KEY NOTE (TICKET-33): the "cantai-hostcode-v1" salt is DELIBERATELY kept — rotating it invalidates every stored hostCodeHash (all host logins) and breaks host-session derivation. Do NOT rename in the rebrand. See lib/host-auth.ts + work/tickets/TICKET-33-code-rebrand.md.`

This is the one comment that, if missing, lets a later cleanup silently brick all host codes. Trivial to add; required before this ships.

## Concurring with sonnet's non-blocking items (not conditions)

- **favicon.ico follow-up:** raw `/favicon.ico` falls into the `[room]` catch-all (200 HTML) until a real ICO ships. Browsers use the linked PNG icons, so UX is unaffected; ICO needs the brand source from PR #19. Ride PR #19 or an immediate follow-up ticket. Non-blocking — agreed.
- **rotation-engine prose** (`description`/keyword/README still say cantai): internal-only, fold into the favicon follow-up. Non-blocking.
- **manifest `purpose: "any maskable"`** combined: Lighthouse prefers split `any` + `maskable` entries. Optional polish, non-blocking.
- **`www.boraoke.com` apex redirect + `NEXTAUTH_URL`/OAuth origins:** Vercel domain-config + env, TM-owned, out of code scope. Correctly flagged.

## Merge sequencing (unchanged, load-bearing)

**Merge PR #19 (brand-assets) before or together with PR #20**, else `og-image-pt-BR.png` (and the favicon source) 404 at runtime. The metadata + tests are correct now; only the asset is cross-PR. Branch is 0 behind main; only `work/events/2026-07.jsonl` overlaps #19 (append-only) — clean.

## Security waiver — concur

TM-waived, sonnet-verified. My own live tests reconfirm: fixed-target 308, no open redirect, no loop, previews excluded, no new inputs/endpoints/secrets, storage keys/salts deliberately unchanged (zero session invalidation). Waiver holds.

## Bottom line

APPROVE (merge-counting). All three suites green + build green (verified myself). Cutover is safe — old QRs 308 with path preserved, no loop, no open redirect, OG cards resolve canonical. Brand identity is complete and polished as judged live. Ship it with the one-line R1 salt-guard comment added (fast follow, no re-review round required — TM confirms the line landed), and merge #19 first/with it.
