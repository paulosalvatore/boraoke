# TICKET-118 + TICKET-112 production verification

- **Date:** 2026-10-16
- **Merge:** PR #96 squash `5f6bf40aa579415e83453f23c013d293f5d46daf`
- **Deploy:** GitHub deployment 7112462286 (Production), Vercel status `success` ("Deployment has completed").
- **Method:** headless Chromium (Playwright), separate browser contexts per device, pt-BR, never the TL's screen. New throwaway room `t118-prod-verify-throwaway` (rooms can't be deleted yet, TICKET-151). Host code kept only in a scratchpad file, deleted after the run; evidence grep for it: no match. Harnesses: `work/evidence/TICKET-118/prod-verify/harness.cjs` (phase 1), `harness-phase2.cjs`. Logs: `run-log.txt`, `run-error.txt`, `run-log-phase2.txt`.
- **Live searches spent:** 0.

## Results

| Check | Observed | Verdict |
|---|---|---|
| Creator A reaches admin without typing | dashboard rendered straight from creation | PASS |
| B (code login) does not see "Sign out other devices"; A does | revoke button B=0, A=1 (`01-B-staff-no-revoke-button.png`) | PASS |
| A's logout confirm shows the owner warning | "Este é o dispositivo que criou a sala. Se você sair aqui, perde a opção de desconectar outros dispositivos…" (`02-A-owner-logout-warning.png`) | PASS |
| A runs "Sign out other devices" | confirm copy shown, toast "Pronto. Os outros dispositivos foram desconectados… Este continua conectado." (`03-A-revoke-done.png`) | PASS |
| B's next host action fails, B lands on code gate; A stays signed in | NOT VERIFIED. The harness clicked the hidden moderation `<input>` (Playwright: "outside of the viewport") and crashed right after the revoke, which closed both contexts. The owner device's credentials went with it, and by design typing the host code does not restore owner status, so the revoke could not be redone in this room. Harness now clicks `moderation-track`. | UNVERIFIED |
| Plain logout on B leaves the other device signed in (TICKET-112) | phase 2, two code-login devices A2 + B: B's confirm has no owner warning; after confirm + reload B is on the code gate; A2 session 200, dashboard still rendered after reload (`07-…`, `08-…`) | PASS (on a non-owner A2, not the creator) |

Overall: **PARTIAL PASS**. Revoke UI and copy work live; the revoked device's post-revoke failure was not observed live (it is covered by e2e `creator-reentry.spec.ts` "a session copied to another browser dies", 21/21 green pre-merge). Re-observing it live needs one more throwaway room.

Code note (from reading `AdminRoom.tsx`, not a regression): a host action that gets 401 (e.g. moderation toggle) only reverts the control; the code gate appears on the next admin load, not in place. The revoke button's own 401 path does re-probe.

## Addendum: revoke re-check on a second throwaway room (2026-10-16)

- **Room:** `t118-prod-verify-throwaway-2` (rooms can't be deleted yet, TICKET-151). Headless Playwright, two contexts (A creator, B code login), host code only in a scratchpad file, deleted afterwards; grep of evidence/report/status/events for it: no match. Live searches: 0.
- **Harness:** `work/evidence/TICKET-118/prod-verify/harness-revoke-recheck.cjs`. Logs: `run-log-revoke-recheck.txt`, `network-revoke-recheck.txt`. Screenshots: `09-A-revoke-done-room2.png`, `10-B-after-failed-action-room2.png`, `11-B-code-gate-room2.png`, `12-A-still-in-room2.png`.

| Check | Observed | Verdict |
|---|---|---|
| A runs "Sign out other devices" | `POST /api/host/revoke-sessions` 200; toast "...Este continua conectado." | PASS |
| B host action after revoke is refused | `POST /api/host/moderation` (B) -> **401** | PASS |
| Action had no effect | moderation flag false before; false after, read from a fresh cookie-less context | PASS |
| B lands on code gate after reload | codeGate=1, dashboard=0; B `session` 401, `claim` 401 | PASS |
| A still signed in and still sees the button | A `session` 200, dashboard=1, gate=0, revoke button=1 after reload | PASS |

Network note: A's own `GET /api/host/pending` returned one transient 401 immediately after the revoke, then 200 on the next poll and every poll after (A's session was re-established as designed; A never lost the dashboard). Worth a glance as a polish item, not a defect.

Overall: **PASS**. The previously UNVERIFIED row is now verified live; the whole TICKET-118/112 live check is complete.
