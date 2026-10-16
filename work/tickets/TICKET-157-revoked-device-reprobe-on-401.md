---
ticket: TICKET-157
product: boraoke
status: backlog
---

# TICKET-157 — A revoked staff device keeps its dashboard and fails silently: re-probe the session on any 401

**Filed:** 2026-10-15, from the App Tester's LOW-1 on PR #96 (TICKET-118/112). Evidence: `work/reports/testing/TICKET-118-app-test.md` (finding 1, screenshots `work/evidence/TICKET-118/apptest/*-4-B-after-action-no-reload.png` and `*-4-B-gate-after-revoke.png`).
**Priority:** LOW
**Type:** UX
**Size:** S
**Patron-facing:** host-facing (host panel only).

## What

After the owner device uses "Sign out other devices", a revoked staff device keeps showing its host dashboard. Its next host action is refused with 401 (the security property holds, every request is refused), but `hostAction` ignores the result, so the action fails with no feedback. The device only reaches the code gate on the next reload or session probe (`gate without reload: false`).

## Proposed change

When any host request returns 401, re-probe the session and, if it is gone, route the device to the code gate at once, with a short plain message that it was signed out. Handle it in one place (the shared host-request path used by `hostAction`), not per call site.

## Acceptance

- Revoked staff device B performs any host action after A revokes: B lands on the code gate without a reload.
- A still-valid device is unaffected by a transient 401 (the re-probe confirms the session before routing away).
- An e2e covers the revoke-then-act path (the App Tester's scenario 4).
