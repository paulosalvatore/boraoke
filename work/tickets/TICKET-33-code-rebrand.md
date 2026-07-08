# TICKET-33 — Boraoke code rebrand + publish-readiness metadata

Status: IN PROGRESS (Dev)
Product: boraoke (repo `paulosalvatore/boraoke`, RENAMED from cantai; live https://boraoke.com + https://cantai-snowy.vercel.app)
Branch: `ticket/33-code-rebrand` · Worktree: `.worktrees/ticket-33b`
Depends-on / concurrent: PR #18 design-v2 (MERGED into main) · PR #19 brand-assets (`public/brand/**`, OPEN) — do NOT touch `public/brand/**` or `work/design/**`.

## Scope

### 1. Rename user- and machine-facing "cantai" → Boraoke/boraoke
- `package.json` `name` → `boraoke`; dev-server localStorage temp-file path in the `dev` script (cosmetic, `/tmp/cantai-ls.json` → `/tmp/boraoke-ls.json`).
- UI wordmark / visible strings: landing `🎤 cantai` + footer, patron room `🎤 Cantai`, admin `🎤 cantai · admin` + `<span class=wordmark>cantai`, TV wordmark + `powered by cantai` byline (×2) → **powered by Boraoke**, room-not-found fallback `venueName ?? "cantai"`, TvScreen `joinLabel` fallback `"cantai"`.
- Page `<title>` metadata (see §2 for full publish metadata).
- README: title, description, live URL → **https://boraoke.com**, port note.
- `.env.example` header comment.
- run-app skill description + `powered by cantai` note.
- Internal workspace package `@cantai/rotation-engine` → `@boraoke/rotation-engine` (path-alias + jest moduleNameMapper only; no real npm install — clean, self-contained rename).

### Storage / cookie keys — DELIBERATELY KEPT (live device state)
`cantai_patron_uuid`, `cantai_nickname`, `cantai_last_room`, `cantai_mode`, `cantai_room`, `cantai:<room>:*` (localStorage) and `cantai_host` / `cantai_host_<room>` (cookie), plus the HMAC salt strings (`cantai-host-session-v1`, `cantai-hostcode-v1`, `cantai-dev-host`). Renaming these logs every existing user out / loses their patron identity and host sessions on live devices, and rotating the HMAC salts invalidates every issued host cookie. **Kept as-is with explanatory code comments.** A read-old-write-new migration was judged not worth the risk/churn for a cosmetic key rename; documented for a future ticket if desired.

### CSS module class prefixes
No `cantai`-prefixed CSS class names exist (design-v2 uses generic token/class names). Only a code comment in `tv.module.css` references "cantai.css" (historical) — updated cheaply.

### `--brand-name` design token
The merged design-v2 (#18) does NOT define a `--brand-name` CSS/JS token, so there is nothing to wire. Wordmark text is inline. Noted; no token introduced (out of scope to invent one).

### 2. Publish-readiness metadata
- Root `app/layout.tsx` `metadata`: pt-BR `title` (template + default) / `description`, `metadataBase` = https://boraoke.com, OpenGraph + Twitter card → `/brand/og-image.png` (en/es variants deferred to i18n wave-30; hreflang/locale-aware OG is wave-30 scope, default pt-BR now), `lang="pt-BR"`, theme-color, icons, manifest.
- Per-page titles via title template (TV page keeps its own short title).
- Favicon set generated from `public/brand/favicon-source.png` via `sips`: `app/icon.png` (32), `app/apple-icon.png` (180), plus `public/favicon.ico`-compatible + manifest icons (192/512). NOTE: `public/brand/favicon-source.png` ships in PR #19 (brand-assets) — generation runs against it; if PR #19 is not yet merged into this branch the icons are committed as generated artifacts.
- `public/manifest.json`: name **Boraoke**, theme color **#0D0A14**, icons.
- `public/robots.txt`: allow crawl + sitemap-ready host.

### 3. Canonical domain
- `next.config.ts` `redirects()` (permanent 308): `cantai-snowy.vercel.app` → `https://boraoke.com` preserving path. Host-based `has` matcher so only the vercel apex redirects.
- **TM follow-up** (flagged in PR body, TM owns env): `NEXTAUTH_URL` → `https://boraoke.com`; add `boraoke.com` to Google OAuth authorized origins + redirect URIs.

### 4. Tests
- Update assertions referencing cantai strings (`cantai-dev-host` DEV_TOKEN in e2e stays — it is the host-auth salt/token, KEPT per storage-key decision; verify no user-visible-string assertions break).
- Add a meta test asserting root metadata has title/description/OG image present (node-env, imports the `metadata` export).
- Full jest suite + Playwright e2e green locally (PORT=3033). Stop servers after.

## Evidence
Screenshots into `work/evidence/ticket-33/`: new page title, OG tags in head, favicon visible, TV `powered by Boraoke` byline.

## Deliverables
- Dev report `work/reports/dev/TICKET-33.md`
- Draft PR "TICKET-33: Boraoke code rebrand + publish metadata", base main, `gh -R paulosalvatore/boraoke`.
