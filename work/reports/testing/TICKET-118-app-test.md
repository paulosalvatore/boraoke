# TICKET-118 / TICKET-112 App Test (PR #96)

- Verdict: **PASS** (with two LOW notes)
- Head tested: `887f507d383f7495ae20f58a3c8cb1e837de0a56` (branch `ticket/118-session-revocation`, tree clean apart from the node_modules symlink, which was never staged)
- Tester: App Tester, 2026-10-15. Server: `next dev -H 127.0.0.1 -p 3119`, `STORE_DRIVER=memory`, `NEXT_DIST_DIR=.next-apptest3119` (removed afterwards, `tsconfig.json` side effect reverted). Headless Chromium via Playwright, one browser context per device, never the TL's screen. Host load was 60 to 120 during the run, so the harness uses long timeouts and a full route warm-up before any state exists.
- Harness: `work/evidence/TICKET-118/apptest/apptest-t118.cjs`. Per-run machine results: `results-<locale>-<width>.json`. Expected strings are read from `messages/<locale>.json`, so every copy assertion is an exact match, not a regex.
- CI: this repo's merge gates are jest + build + e2e (no `verify-green-local.sh`, per the dev report); I did not re-run them. The PR body's own record: jest 1293 passed, build OK, e2e 134/136 with two `socket hang up` outside the diff. The PR Gates list still has the full-suite e2e re-run as an open TM decision.

## Matrix run

6 full runs: pt-BR, en, es, each at 390x844 and 1280x800, each on its own freshly created room (so throttle counters are independent). Each run also resizes to 320 px for the copy-fit pass. Totals across the 6 runs: 209 assertions PASS, 0 FAIL (final passing run of each combination).

| Scenario | Result | Evidence / note |
|---|---|---|
| 1. A (owner) shows logout + "sign out other devices"; B (staff, host code) shows logout only, no revoke button | PASS in all 6 | `*-1-A-owner-header.png`, `*-1-B-staff-header.png`. Labels equal the localised strings. |
| 2. Plain logout on B: confirm says "this device only", no owner warning; B lands on the code gate and stays there after reload; A stays signed in; A still re-enters with no code after its session cookie is deleted (claim token survived B's logout) | PASS in all 6 | `*-2-B-logout-confirm.png`, `*-2-B-after-logout-gate.png` |
| 3. A's logout confirm carries the owner warning ("you lose the option to sign out other devices, even after you get back in with the host code"); Cancel closes it, A stays in | PASS in all 6 | `*-3-A-logout-owner-warning.png` |
| 4. Fresh B login, then A "sign out other devices": confirm copy exact, done message exact; A stays signed in after reload and keeps the button; B's next host action returns 401; B's reload lands on the code gate | PASS in all 6 | `*-4-A-revoke-confirm.png`, `*-4-A-revoke-done.png`, `*-4-B-after-action-no-reload.png`, `*-4-B-gate-after-revoke.png` |
| 5. Staff forcing the revoke route: `403 {"error":"Only the room owner's device can sign out other devices","ownerOnly":true}`, B stays signed in, no crash. UI path of the friendly message (owner hint mocked on B's session probe, a stale-hint case) shows the localised "Only the device that created this room..." text and the dashboard stays up | PASS in all 6 | `*-5-B-forced-403-friendly.png`. The mock is harness-only; the 403 itself is the real server answer. |
| 6. Throttle: network log per run is `A 200 (use 1), B 403, B 403 (refused, not charged), A 200 (2), A 200 (3), A 429 (4th)`; the 4th shows the throttle message, A stays signed in | PASS in all 6 | `*-6-A-throttled.png` |
| 7. Copy fit at 390, 1280 and 320 (header, both confirm panels, toasts, B's 403 toast): no horizontal scroll, no clipped or overlapping header/panel/toast boxes (programmatic bounding-box check) in pt-BR, en, es | PASS | `*-7-320-A-logout-confirm.png`, `*-7-320-A-revoke-confirm+toast.png`, plus the layout checks in every results JSON. Visual spot check of es 320 and en 1280. |
| 8. Regression (pt-BR 1280, host A after three revokes): moderation toggle on, patron submits, pending card appears, approve puts the song in the queue, TV shows it, host pause/unpause/skip still 200 | PASS | `pt-BR-1280-8-A-pending.png`, `pt-BR-1280-8-A-queue.png`, `pt-BR-1280-8-TV.png` |

Console and network: the only console errors in all runs are expected status responses (401 from the revoked or logged-out device's probes, the intended 403 from forced staff revokes, the intended 429 on the 4th use). No page errors, no unexpected failed requests.

## Notes (not blocking)

1. **LOW, UX:** after A revokes, B's open dashboard stays up and its host actions fail silently (the action returns 401, `hostAction` ignores the result). B reaches the code gate on the next reload or probe, not at the moment of the failed action (`gate without reload: false`, screenshot `*-4-B-after-action-no-reload.png`). This matches the Testing Handoff wording ("any host action fails, and a reload shows the code gate") and the security property holds (every request is refused). Suggest a follow-up ticket: re-probe the session when a host action returns 401.
2. **LOW, layout:** at 390 and 320 the header wraps to three rows and "Sign out other devices" sits on its own row, near the existing floating feedback button (no overlap, closest at 320). Fits; just not tight.
3. **Harness race, disclosed:** in the very first pt-BR 390 run the throttle step read a stale "done" toast and recorded a FAIL. I could not tell then whether the 4th request had been throttled, so I added a network log of every revoke response and re-ran. All 6 final runs show the 4th request as `429`. I treat the first as a harness race (it read the toast before the new response landed), but state it here because I did not have the network log for that run.

## Design-parity pass

No approved mockup for this surface (header actions and confirm panels) was checked: none was referenced in the PR or ticket. Design-parity pass skipped, stated explicitly.

## Friction

- Cold route compiles under `next dev` at load 60 to 120 took 30 to 55 s each, longer than Playwright's default request timeout; the warm-up and the code login needed 150 s waits. The harness now does that. A first compile of `/api/rooms` and `/new` is the cost.
- `next dev` rewrites `tsconfig.json` (adds the dist dir to `include`); reverted. An untracked `NEXT_DIST_DIR` is not gitignored, so a per-lane distDir shows up in `git status` until removed.
- `/api/host/login` is slow to answer under load (the button sat on "Entrando…" for over 30 s once).

## Evidence index

All under `work/evidence/TICKET-118/apptest/`: 81 PNGs named `<locale>-<width>-<scenario>-<state>.png`, six `results-*.json`, and the harness `apptest-t118.cjs`. Each screenshot's assertion is recorded in the matching results JSON (`results[].step`, `ok`, `note`).
