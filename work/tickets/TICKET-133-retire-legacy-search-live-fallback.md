# TICKET-133 — Retire the legacy (no `v=2`) live-search fallback once pre-#125 tabs have aged out

**Filed:** 2026-10-15, by the TICKET-126 Dev, from Cyber Security LOW 3 on PR #89 (TICKET-125, `work/reports/security/TICKET-125-security.md`). Not in scope of TICKET-125 or TICKET-126.
**Priority:** LOW (schedule it, do not let it rot)
**Type:** Security hardening / cleanup
**Size:** S

## What

TICKET-125 made live (billed) YouTube search fire only on Enter or after an idle pause. The current client marks every search request with `v=2` (`SEARCH_PROTOCOL_VERSION` in `lib/live-search-gate.ts`, sent from `components/SongSearch.tsx`), and a v2 first page bills only when it also sends `live=1`.

A request WITHOUT `v=2` is treated as a legacy client, meaning a tab loaded before #125 shipped: `isLegacyClient` makes `liveAllowed` return true, so the old "cache → index → live fallback on every search" path stays open. That compatibility path keeps old tabs working across the deploy. It is also a permanent bypass of the Enter/idle marker: any caller can omit `v=2` and get a live fallback on every index miss.

It is still bounded by the 2 s per-uuid billed cooldown, the per-uuid/per-IP rate limiter, the per-person daily shares (TICKET-126) and the platform daily budget. That is why it is LOW. It is still demand the marker was meant to remove.

## What's needed

- Pick a sunset date once pre-#125 tabs are realistically gone. A patron tab lives one venue night; a TV or host tab can stay open for days. A couple of weeks after #125 reaches production is a reasonable default. Optionally confirm with telemetry or logs that requests without `v=2` have stopped.
- Then make a request without `v=2` behave like a v2 request without `live=1`: index and cache only, never a billed fallback. Return a response the old client can render, for example the localized 429 "wait" copy it already shows, so a straggler tab degrades visibly rather than silently.
- Remove `isLegacyClient`'s live branch and the legacy-specific route code and comments. Update the route doc comment (`GET /api/search` header) and the legacy suites that model the old path.

## Constraints

- Read **`prove-your-test-can-fail`**: the regression test must show that a request without `v=2` on an index miss makes NO billed call, and must FAIL against today's code.
- Do not ship the sunset in the same deploy as anything that changes the client protocol again.
