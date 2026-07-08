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
