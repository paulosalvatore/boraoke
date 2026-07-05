# Review Report — TICKET-1: Walking Skeleton (Karaoke Prototype Core)

- **Ticket:** TICKET-1 (`work/tickets/TICKET-1-walking-skeleton.md`)
- **PR:** paulosalvatore/cantai #4 (`ticket/1-walking-skeleton`)
- **Reviewer:** Reviewer agent (sonnet pass)
- **Date:** 2026-07-05
- **Verdict:** REQUEST-CHANGES — one blocking item (CI node-version mismatch), two nits

---

## Evidence Consulted

| Artifact | Location | Relied on |
|---|---|---|
| Ticket spec | `work/tickets/TICKET-1-walking-skeleton.md` | Acceptance criteria |
| Dev report | `work/reports/dev/TICKET-1.md` | Implementation log, self-verification, security fix log |
| App Tester report | `work/reports/testing/TICKET-1-app-test.md` | Functional PASS, 20 evidence screenshots |
| Security report | `work/reports/security/TICKET-1-security.md` | 4 MEDIUMs, PASS-WITH-NOTES |
| Evidence screenshots | `work/evidence/ticket-1/` | 20 screenshots covering patron, TV, two-patron multi-context |
| CI status | `gh pr checks 4` | Vercel FAIL (TICKET-2 scope), no GitHub Actions run (bootstrap limitation — expected) |
| Full diff | `git diff <base>..<origin/ticket/1-walking-skeleton>` | Local diff read, 48 files |
| Build | Reviewer ran `npm ci && npm run build` | Clean, 7 routes |
| Unit tests | Reviewer ran `npm test -- --verbose` | 39/39 pass |
| E2E | Reviewer ran `npm run test:e2e` | 1/1 pass (1.4s) |

---

## Build / Test Results (Reviewer-Verified)

```
npm ci          → success (no errors, audit noise only)
npm run build   → ✓ Compiled successfully (next 15.5.20), 7 routes
npm test        → 39 passed, 39 total (3 suites: api-queue, queue, youtube) — 0.275s
npm run test:e2e → 1 passed (5.4s) [chromium] › patron submits a song and it appears in the queue
```

All claims in the dev report match what the reviewer ran. The 39 unit tests (was 25 pre-security-fixes) and the 1 Playwright e2e all pass independently.

---

## Acceptance Criteria Assessment

| Criterion | Met? | Evidence |
|---|---|---|
| `npm run dev` on :3040 → `/` and `/tv` work end-to-end | ✅ | App Tester PASS + 20 screenshots |
| Patron joins with nickname, submits YouTube URL, sees queue | ✅ | Screenshots 01–09, 10–11 (two-patron cross-context) |
| YouTube URL parser accepts full/short/shorts/embed/live formats | ✅ | 16 unit tests in `__tests__/youtube.test.ts`; parser verified correct |
| Venue screen `/tv` plays queue via official IFrame API | ✅ | Screenshot 19 (official embed URL with `enablejsapi`); auto-advance on ENDED |
| API routes: GET/POST `/api/queue`, POST `/api/queue/advance` | ✅ | API sanity checks in App Tester; 11 API validation unit tests |
| Input validation (post-security fixes) | ✅ | See Security section below |
| Unit tests + 1 Playwright e2e green | ✅ | Reviewer-verified: 39 + 1 |
| CI workflow replaces stub | ✅ (partial) | Workflow is real; **but node-version bug — see BLOCKING ITEM #1** |
| README: port, run instructions, limitations | ✅ | README complete; **nit: missing Node 22+ requirement** |
| Dev report current | ✅ | Report reflects final state including security commit 78f546d |
| Restart-loses-state documented | ✅ | Documented in `lib/store.ts` header + README + footer on patron page |

---

## Security MEDIUMs — Genuinely Fixed?

**MEDIUM #1 — Direct videoId bypass.** Fixed. The `resolvedVideoId` is now validated against `VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/` regardless of which path (direct `videoId` field or `youtubeUrl` parser) produced it. Both paths must pass the regex or get a 400. Confirmed by unit test `"rejects a direct videoId that is not 11 chars"` (and two more invalid-chars, URL-as-videoId tests). **GENUINELY FIXED.**

**MEDIUM #2 — No field length caps.** Fixed. `nickname ≤ 30`, `title ≤ 120`, `table ≤ 10`, `patronUuid` strict UUID regex, body capped at 4096 bytes. Client-side `maxLength` attributes on patron page inputs match server limits. Unit tests cover boundary (30-char nickname → 201) and over-limit → 400. **GENUINELY FIXED.**

**MEDIUM #3 — Unbounded queue depth.** Fixed. `QUEUE_MAX = 200` exported from `lib/store.ts`. `addToQueue` returns `false` when full. API returns 429 with clear message. Unit test fills queue to QUEUE_MAX, asserts next addition → 429. Post-advance acceptance also tested. **GENUINELY FIXED.**

**MEDIUM #4 — Next.js CVEs.** Fixed. Bumped `next` to `^15.5.20` in `package.json`; build verifies clean on that version. Remaining `npm audit` noise is a transitive `postcss` inside Next itself; no non-breaking fix exists. Accepted and documented. **GENUINELY FIXED.**

---

## Code Quality Assessment

### lib/youtube.ts — URL parser

Correct for all ticket-scoped formats. The `isValidVideoId` helper is private (unexported), which means `route.ts` duplicates the regex as `VIDEO_ID_RE`. Functionally equivalent and tests cover both paths. Minor inconsistency worth a future cleanup but not blocking.

For `youtu.be` URLs: `url.pathname.slice(1).split("?")[0]` is defensive but technically redundant (the URL API puts query params in `url.search`, not `pathname`). Harmless.

Raw-ID path: `/^[A-Za-z0-9_-]{11}$/` — correct. Test covers exact-11 ✓, <11 → null ✓, >11 → null ✓.

### lib/store.ts — In-memory queue

Module-level `let queue: QueueEntry[]` — the correct Next.js prototype pattern for shared in-memory state. `clearQueue()` is test-only and documented. Restart-loses-state limitation is prominently documented in the JSDoc header. `addToQueue` now returns `boolean` (false = full), consistent with the API.

### app/api/queue/route.ts — POST handler

Body is read via `req.text()` before parse, enabling the 4 KB cap check. JSON.parse error → 400. All field validations occur before `addToQueue`. Queue-full check occurs last (after validation), so invalid requests get 400 rather than consuming a queue slot — correct ordering.

One subtle point: if a caller sends `{videoId: "https://youtu.be/dQw4w9WgXcQ", ...}` (a URL as a `videoId` field), the code takes the direct path, sets `resolvedVideoId` to the full URL string, which then fails the 11-char regex → 400. Expected behavior.

### app/tv/page.tsx — YouTube IFrame player

Uses only the official YouTube IFrame Player API (`https://www.youtube.com/iframe_api`). No media proxying. The `currentVideoIdRef` guard prevents double-load when both the `onStateChange` handler and the `useEffect` queue-change path are triggered. The App Tester noted a test-environment double-advance (ENDED fires in headless); this is a test artifact, not a production bug. `playVideo` is cast via `unknown` because the local `YTPlayer` interface doesn't declare it (only `loadVideoById`, `stopVideo`, `destroy`) — a deliberate simplification, acceptable for prototype.

### app/page.tsx — Patron page

localStorage access guarded with `typeof window !== "undefined"` — correct for SSR. UUID generated and persisted per session. 3-second poll for live queue. `parsedVideoId` computed from YouTube URL in real-time; submit button disabled unless a valid ID is parsed. Error paths covered (network error, server error, no-videoId).

### e2e/submit-song.spec.ts

The pre-test cleanup (`POST /api/queue/advance`) only removes one item — if prior test state has multiple items queued, the cleanup is incomplete. This is fragile for future multi-e2e expansion, but passes in the current single-test suite (the test then adds its own item and verifies it appears). Acceptable for now.

### .github/workflows/ci.yml — CI CORRECTNESS (BLOCKING — see below)

---

## Blocking Items

### BLOCKING #1 — CI node-version mismatch (CI will fail post-merge)

**File:** `.github/workflows/ci.yml`, line 16

**Problem:** The CI workflow specifies `node-version: "20"` but:

1. The Playwright e2e step sets `NODE_OPTIONS: "--localstorage-file=/tmp/cantai-ls.json"` for the step environment.
2. The `playwright.config.ts` `webServer.env` also passes `NODE_OPTIONS: "--localstorage-file=/tmp/cantai-ls.json"` to the dev-server subprocess.
3. The `--localstorage-file` flag was introduced in **Node.js v22.4.0**. On Node 20, it is an unrecognized option.

When `NODE_OPTIONS` contains an unrecognized flag, Node.js exits with "bad option: --localstorage-file" (exit code 9). This means the Playwright e2e step would fail on every CI run post-merge because `npm run test:e2e` itself (which is a Node.js program invocation) would reject the flag before any tests run.

The CI yml comment even says: "Node.js 22+ localStorage global needs a file path to be functional during Next.js SSR" — the author correctly identified the Node 22+ requirement but forgot to update the `node-version` field.

**Fix (one line):**
```yaml
node-version: "22"   # was "20" — --localstorage-file requires Node 22+
```

**Why blocking:** The ticket explicitly scoped CI setup. The reviewer assessment must confirm CI will work post-merge. With `node-version: "20"`, every PR post-merge will fail its e2e CI step, defeating the CI gate entirely.

---

## Nits (non-blocking)

### NIT-1 — README missing Node 22+ requirement

The README has thorough run instructions but does not mention that Node 22+ is required (due to `--localstorage-file`). Developers on Node 20 or Node 18 LTS would find `npm run dev` fails with an opaque Node error. Adding one line ("Requires Node.js 22 or later") would prevent confusion. `@types/node: "^22.0.0"` in devDependencies already signals this, but it should be in the README too.

### NIT-2 — `isValidVideoId` is private, leading to a duplicated regex

`lib/youtube.ts` defines `isValidVideoId` as an unexported function. `app/api/queue/route.ts` independently defines `VIDEO_ID_RE` with the same pattern. If the pattern ever changes, both must be updated in sync. Minor and low-risk at prototype scale; exporting `isValidVideoId` from `lib/youtube.ts` and importing it in the API route would be the clean fix.

---

## Scope Discipline

No scope creep. The PR contains exactly what the ticket specified: Next.js app, patron page, TV page, API routes, unit tests, Playwright e2e, CI workflow, README, and run-app skill update. No unrequested features added.

---

## CI Status (S1)

- **GitHub Actions:** Did not run — expected bootstrap limitation (workflow file must exist on `main` before GitHub triggers it on a PR). Not a gate blocker for this first PR.
- **Vercel:** Failing — explicitly out of TICKET-1 scope (deploy = TICKET-2).
- **Required checks:** None currently passing/failing through GitHub Actions. Post-merge CI correctness is blocked by the node-version issue above.

---

## Dev Report Currency (F23)

Dev report reflects the post-security-fix state (references commit 78f546d, shows 39 tests, lists all 4 MEDIUMs fixed). Current. No discrepancy with the diff.

---

## Summary

The implementation is functionally sound and complete. All 4 security MEDIUMs are genuinely closed with tests. The App Tester PASS is backed by 20 evidence screenshots covering all AC flows. The reviewer independently confirmed build + 39 unit tests + 1 e2e all green.

The single blocking issue is a one-line CI fix: `node-version: "20"` → `"22"`. Once fixed, CI is ready to enforce build + test + e2e on all subsequent PRs. The two nits (README Node version, duplicated regex) can be fixed in the same commit or deferred.

**Verdict: REQUEST-CHANGES — fix node-version in ci.yml, then re-review.**
