# TICKET-126 — Per-person daily search limit + single-flight cache (folds in TICKET-119 and TICKET-120)

**Filed:** 2026-10-14, by the boraoke Tech Manager.
**Priority:** HIGH — one person can still drain the platform's 90 billed `search.list` calls a day.
**Type:** Quota / security
**Size:** M (two PRs)
**Stacks on:** TICKET-125 (PR #89). PR A is cut from `ticket/125-enter-idle-search` and targets it until #89 merges. PR B (TICKET-120) is cut from `main`.

## Scope

1. **Per-device and per-IP daily sub-budgets** of the 90 billed calls, cross-instance (Redis, like TICKET-87's counter), with the fail-closed/fail-safe choice stated. A capped person still gets index and cache results free; live search shows a clear trilingual message, consistent with the existing daily-limit state. Numbers chosen from real usage (work/measurements/ticket-108, -124, -125); a bar's patrons often share one Wi-Fi IP.
2. **Single-flight lock** on the cache: concurrent identical queries across instances produce ONE billed call. Proven with a concurrency probe.
3. **TICKET-119 folded in** (prerequisite for a per-IP cap): derive the IP only from the header Vercel's edge overwrites, per Vercel's own documentation.
4. **TICKET-120 folded in as its own PR (PR B)**: the claim-token cap counts issues, not devices, so staff logins evict the owner. Requires the 30-concurrent-logins owner-survival probe, shown to fail against today's `slice(-5)`.

## Decisions (TM, 2026-10-14)

- Caps: 10 per device, 45 per IP, 90 platform; device and IP caps env-configurable with those defaults (`SEARCH_DEVICE_DAILY_CAP`, `SEARCH_IP_DAILY_CAP`). TL sees the numbers at the OK.
- **Superseded at the TL OK (2026-10-15):** caps raised to **30 per device, 90 per IP** (= platform budget), platform 90. TL: "Lets increase the numbers, because we are rebuilding the search mechanism to allow more searchs. Otherwise the app will be shitty". The caps only stop one abuser; they must never throttle normal patrons.
- The room-record write race found while planning is filed as TICKET-127, not fixed here.

Plan: `work/plans/TICKET-126-plan.md`.
