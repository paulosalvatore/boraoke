# TICKET-116 — Plan: move the e2e suite onto a production build

**Status:** executed. Approach handed down by the TM with the measurement already done (see the ticket's four appended update sections); this file records the approach actually taken and the decisions made inside it.

## Approach

1. **`playwright.config.ts` `webServer` → `npx next build && npx next start`.** Removes lazy compilation, module re-evaluation and idle eviction — the three mechanisms behind every measured failure family — rather than relocating their cost the way a warm-up does.
2. **Build isolation ships with it, not after it.** `next.config.ts` gains `distDir: process.env.NEXT_DIST_DIR || ".next"`; the suite sets `NEXT_DIST_DIR=.next-e2e`. A `next dev` session serving from `.next/` is therefore untouched by an e2e build. Per-worktree isolation follows for free (each worktree is its own tree).
3. **Pin `store` and `roomBackend` to `globalThis`.** Unconditional, not `NODE_ENV`-guarded — the e2e suite now runs a *production* build on the memory driver, so a NODE_ENV guard would exclude the exact case it exists for, and the Upstash driver holds no local state so pinning it is a no-op.
4. **Absorb what a production build changes**, without weakening the product (see the dev report's "Four things a production build changes" section).
5. **Measure** a cold-run distribution against the recorded baseline (cold `main`: 5/5 runs failed).

## Files touched

| File | Change |
|---|---|
| `playwright.config.ts` | build-and-start `webServer`, `NEXT_DIST_DIR`, `HOST_TOKEN`, `ROOM_CREATE_LIMIT`, `baseURL` host, timeout |
| `next.config.ts` | `distDir` from `NEXT_DIST_DIR` |
| `lib/store.ts`, `lib/rooms.ts` | `globalThis`-pinned singletons |
| `e2e/helpers.ts` | `drainQueue` falls back to host-authed removal when advancing is rate-limited |
| `e2e/host-controls.spec.ts` | its private advance-loop drain delegates to the shared helper |
| `e2e/render-and-links.spec.ts` | `clearCookiesSafely` — navigate away before clearing, so a rolling-session poll cannot restore the cookie |
| `.gitignore` | `.next-e2e/` |

## Risks considered

- **`.next` corruption becomes MORE likely, not less, without isolation** — this is the constraint that binds the change. Mitigated by `distDir`, and verified explicitly by running an e2e suite while a `next dev` session serves the same worktree.
- **A production build prerenders pages** — would have broken per-visitor `<html lang>`. Checked first: every meaningful route builds as `ƒ` (dynamic); only icons/robots/sitemap are static.
- **`NODE_ENV` divergences** — enumerated exhaustively before changing anything (dev-fallback host token, room-create throttle, `Secure` cookies, `isEphemeralRoomStore`, the YouTube origin override, the search budget's deployed-without-store deny).
- **Specs relying on the store resetting** — the ticket asked this be checked first. They do, implicitly, via the shared `default` room. Recorded as a defect and fixed at the drain, not preserved.

## Rejected

- **Warm-up helpers** — already tried, measured and reverted (ticket, second update). A warm-up relocates compile cost; it cannot reach the success-path modules behind an invalid-body fire, and it cannot run at all in a server that never booted.
- **Running `next start` with `NODE_ENV` overridden** — measured and dead: `next build` inlines `NODE_ENV` into server bundles, so a runtime override changes nothing (verified: the dev fallback token stayed locked and `ephemeral` stayed true under `NODE_ENV=test`).
- **Relaxing the cookie `Secure` flag for tests** — a security control; not weakened. The `localhost` hostname solved it at the harness layer instead.
