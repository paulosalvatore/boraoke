# TICKET-134 local CI stand-in (merged head)

Every step of .github/workflows/ci.yml run locally:

- npm ci: OK
- rotation-engine node --test: 59/59 pass
- npm run build: OK (es-target and css-target gates OK)
- tv-runtime-check (Chromium 68): OK, QR rendered, 0 runtime exceptions
- npm test (jest): 81 suites, 1600 passed, 89 skipped
- Playwright e2e: 142/143 on the full run; the one failure (moderation ON, beforeEach 30s timeout) happened at host load average ~78 and passes 3/3 when e2e/moderation.spec.ts is rerun alone
- gh pr checks 99: build-and-test pass
