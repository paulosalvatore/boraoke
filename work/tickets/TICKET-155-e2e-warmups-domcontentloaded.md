---
ticket: TICKET-155
product: boraoke
status: backlog
---

# TICKET-155 — e2e warm-ups wait for `load` on the TV page and time out under host load

**Filed:** 2026-10-15, by a Dev agent, on a boraoke Tech Manager request (seen in PR #96's e2e run).
**Priority:** MEDIUM (a red e2e that is not a product failure costs a full re-run).
**Type:** Test reliability
**Size:** XS
**Patron-facing:** no. **Gates:** Reviewer.

## Problem

The warm-ups in `e2e/render-and-links.spec.ts` navigate to `/default/tv` and wait for the `load` event. On the TV page `load` includes the embedded YouTube player, which pulls third-party scripts and frames. Under a busy host that takes longer than the warm-up's timeout, so the spec fails before it tests anything.

## Proposal

Switch those warm-up navigations to `waitUntil: "domcontentloaded"`, or drop the TV warm-up if the server is already warm by then. The warm-up only needs the route compiled and served, not the player loaded.

## Acceptance

- [ ] No warm-up in `e2e/render-and-links.spec.ts` waits for `load` on a page that embeds the YouTube player.
- [ ] The spec passes in a full e2e run at high host load (record the load average with the run).
