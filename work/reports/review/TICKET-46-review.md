# TICKET-46 — Kiosk-TV screen-token self-heal — Reviewer Report (D-022 opus, security lens)

**Verdict: APPROVE.**

Reviewed the full diff `origin/main..HEAD` (`BASE=c5d229f..HEAD c4d12d1`) locally in the worktree `.worktrees/ticket-46` (branch `ticket/46-tv-token-self-heal`). Cyber Security is folded into this pass (client-side auth-token change). Independently re-ran `npm test` (479/479) and `npm run build` (compiles + typecheck/lint clean). App Tester report is PASS (zero spurious reloads); dev report matches the diff.

## What I checked

- Full code diff: `app/(patron)/[room]/tv/page.tsx`, `components/tv/TvScreen.tsx`, new `components/tv/self-heal.ts`.
- Token scheme in `lib/screen-token.ts` (24h bucket, current+previous accepted → ≤48h effective) against the 20h proactive threshold.
- New unit tests `__tests__/tv-self-heal.test.ts` (17) — mapped to the ticket's required cases (a)–(e).
- Dev report `work/reports/dev/TICKET-46-dev-report.md` and test report `work/reports/testing/TICKET-46-test-report.md`.
- Independent gate re-runs (test suite + production build) in the worktree.

## Correctness — token age vs the 24h-bucket / ≤48h scheme

Correct and safe.

- `mintScreenToken(room, now)` already accepted a `now` default; the page now passes the SAME `screenTokenMintedAt = Date.now()` value used to derive the mint bucket AND as the client prop. So the client-visible timestamp is exactly the moment that selected the token's bucket — there is no server-internal skew between "the time the token was bucketed" and "the time reported to the client." No other caller of `mintScreenToken` exists (grep-confirmed), so the signature change is contained.
- 20h threshold: a fresh mint lands in bucket `floor(now/24h)`. A proactive reload at age ≥20h fires ≥4h before the bucket rolls, so the re-mint always lands in the current bucket — never in the previous-bucket grace tail — and ~28h before the ≤48h hard expiry. Threshold choice is sound and asserted by tests (`< 24h`, `< 48h`, exact-boundary reload/no-reload).
- Off-by-one: `shouldProactivelyReload` uses `>=` at the threshold; the boundary tests cover `-1` (no reload), exact (reload), exact+playing (no reload). Correct.

## Reload-storm safety

The worst outcome (a venue TV cycling) is adequately guarded on every path the prompt raised:

- **Layer 2 (401 backstop):** debounced by a `sessionStorage` timestamp marker (`boraoke-tv-selfheal-reload`), min 5min spacing. sessionStorage survives a reload, so a bad config where every fresh token 401s reloads at most once per 5min and then fails quietly (pre-existing silent behavior) — verified by the loop-simulation test and by tracing the wired code (`reactiveSelfHeal` writes the marker BEFORE `window.location.reload()`, and reads it on the fresh page). sessionStorage-unavailable degrades to "no prior reload" (one heal still possible), which cannot storm because a single reload either succeeds (fresh token) or the debounce marker is then written.
- **Layer 1 (proactive idle reload):** has no explicit debounce, but the reload itself is the guard — a successful reload re-mints a fresh token, resetting `tokenAgeMs` to ~0, so `shouldProactivelyReload` returns false on the fresh page. The "idle+old on every 60s tick" scenario self-terminates on the first tick. This holds as long as a reload actually produces a younger `screenTokenMintedAt` — which it does in every normal case (server `Date.now()` advances monotonically). See the one clock-skew caveat under Nits below (non-blocking).

## Security (Cyber lens)

Clean.

- **No secret / signing material crosses to the client.** Only `screenTokenMintedAt` (ms epoch) is added as a prop. The HMAC token itself was already sent (unchanged, TICKET-45 design). Confirmed no new server value reaches `TvScreen`.
- **Mint-timestamp leak:** exposing the mint time reveals only when the page was rendered — already inferable (page is public, `force-dynamic`, rendered at load). It does not narrow the HMAC key/bucket space in any useful way beyond what the token already implies (the token embeds its bucket by construction). No new attack surface.
- **401-reload abuse:** a patron cannot force venue-TV reloads. Layer 2 only fires on a 401 from `/api/queue/advance`, and advance is called by the TV's own client on auto-advance/skip — not by patron input. A patron hitting advance from their own device gets their own 401 on their own page, not the kiosk's. Even if a 401 path were reachable, the 5min sessionStorage debounce caps it. No cross-client reload vector.

## Log-mode neutrality (current prod default `ADVANCE_AUTH=log`)

Genuinely behavior-neutral, with one benign exception the ticket sanctions:

- Layer 2 is fully dormant in log mode — advance never returns 401 (the route records the would-block and proceeds), so `reactiveSelfHeal()` never runs.
- Layer 1 still evaluates in log mode, but its only effect is an occasional idle re-mint reload of a >20h-old page — explicitly called out as acceptable in the ticket (§Constraints) and harmless (idle-gated; identical UI re-renders on a fresh token).

## Mid-playback safety

A reload cannot fire while a song is playing. `isPlaying = nowPlaying !== null` (i.e. `queue[0]` present), and `shouldProactivelyReload` short-circuits `if (isPlaying) return false` before the age check — asserted by the "old + playing → no reload" and "exact threshold + playing → no reload" tests. Layer 2's 401 only occurs on an advance attempt (a transition, not steady-state playback). A singer is never cut off.

## Scope, tests, dead code

- Scope is tight: exactly the three files the ticket allowed (page, TvScreen, new helper) + tests + evidence + report. No moderation/brand drive-bys.
- Tests are meaningful: pure decision module isolated from React/DOM/timers (mirrors the existing `watchdog.ts` pattern), 17 tests covering the full decision matrix incl. boundaries and the storm-loop simulation. Coverage over quantity — good.
- `shouldSelfHealReload` (the combined surface) is exported and tested but not wired into `TvScreen` (which calls the two focused predicates directly). This is NOT dead code: it's the ticket's explicitly-suggested signature, kept as a tested single-surface contract, and the dev report discloses the choice. Acceptable.

## Nits (non-blocking — do not gate merge)

1. **Layer 1 clock-skew hot-loop (optional hardening).** `tokenAgeMs = client Date.now() - server screenTokenMintedAt`. If a kiosk's browser clock is ahead of the Vercel server clock by >20h, every fresh page computes age >20h and Layer 1 would reload every 60s while idle — the one path with no `sessionStorage` debounce. This requires ~a full day of client-clock skew (an extreme, self-evident misconfiguration that would already break TLS/time logic), is strictly idle-gated (never cuts off a singer), and stops the instant a song plays. Cheap full fix if desired later: mirror Layer 2's `sessionStorage` one-shot on the Layer 1 reload too (or clamp `tokenAgeMs` to `>= 0` and add a proactive-reload marker). Not blocking given the severity/likelihood, but worth a follow-up note. `components/tv/TvScreen.tsx` Layer 1 `useEffect` (~L601–616).
2. **Marker not cleared on successful advance.** The ticket suggested "clear/re-evaluate the marker on a successful advance"; the implementation never clears it. This is benign-to-better: the marker only debounces 401-reloads, and after a successful reload advances succeed and never read it. Leaving it avoids an extra write on the hot advance path. Fine as shipped; noting the intentional deviation (dev report discloses deviations but not this specific one).

## Gate status

- `npm test`: 479/479 (independently re-run in the worktree). ✓
- `npm run build`: compiles, typecheck + lint clean (pre-existing workspace-root warning only). ✓
- App Tester: PASS, zero spurious reloads on fresh token, advance 200-path intact. ✓
- (The framework `verify-green-local.sh` gates FRAMEWORK PRs; the cantai product gate is `build` + `test` + the App Tester visual gate, all green.)

**APPROVE** — correct, in-scope, well-tested, security-clean, log-mode neutral, and safe against the reload-storm and mid-song hazards for all realistic conditions. The two nits are non-blocking follow-ups.
