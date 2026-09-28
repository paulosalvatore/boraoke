import { defineConfig, devices } from "@playwright/test";

// PORT override (default 3040 — unchanged) so parallel ticket worktrees can
// run e2e without clashing on the shared dev port (TICKET-18).
const PORT = Number(process.env.PORT ?? 3040);

// TICKET-116 — the e2e production build lives in its OWN directory so it can
// never corrupt the `.next/` a `next dev` session is serving from (see the
// webServer block below). Overridable for the rare case of wanting to inspect
// or reuse a specific build directory.
const DIST_DIR = process.env.NEXT_DIST_DIR ?? ".next-e2e";

// TICKET-116 — the suite talks to `localhost`, NOT `127.0.0.1`, and the
// difference is load-bearing rather than cosmetic.
//
// A production build issues its auth cookies with `Secure` (`lib/host-auth.ts`,
// `lib/identity.ts` both key that flag off NODE_ENV, which `next build` inlines
// — it cannot be turned off at runtime). Playwright's APIRequestContext applies
// the secure-context rule by HOSTNAME: `localhost` counts as trustworthy and it
// sends the cookie, `127.0.0.1` does not and it silently sends nothing. The
// browser accepts both, so the symptom was a dashboard that rendered authed
// while every `page.request.get("/api/host/session")` beside it returned 401.
// Measured, both hosts against the same built server:
//   127.0.0.1  page.request -> 401   browser fetch -> 200
//   localhost  page.request -> 200   browser fetch -> 200
// The server is identical and provably correct in both cases (verified with
// curl); only the client's cookie rule differs. Using `localhost` keeps the
// product's cookie hardening untouched instead of weakening `Secure` for tests.
const HOST = "localhost";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  // Serial execution (single worker) — KEPT, but for a different reason than the
  // one this comment used to give. TICKET-116 tested the old justification and
  // it no longer holds; the replacement was measured, not assumed.
  //
  // The ORIGINAL reason was that the in-memory singletons reset on each route's
  // first compile, and parallel workers raced those resets. That cause is gone:
  // a built server compiles nothing at request time, and the singletons are now
  // pinned to `globalThis`. So lifting `workers: 1` was worth a real try — the
  // suite is the slowest gate this product has.
  //
  // It does not survive the try, because a SECOND cause was underneath it all
  // along and is unaffected by the build: **17 of the 20 spec files touch the
  // one shared `default` room** (nine of them seed into it), and with the store
  // no longer being wiped between files they contend on it directly. On top of that,
  // `POST /api/queue/advance` is capped at 12 per room per 60s
  // (lib/advance-rate-limit.ts, hardcoded), a budget several workers drain far
  // faster than one.
  //
  // Measured cold, full suite, same machine, four workers' worth of evidence:
  //   workers: 1  -> 126/126 on 5 of 5 runs        (3m54s - 4m07s)
  //   workers: 2  ->   1 failure on 4 of 4 runs    (2m38s - 2m44s)
  //   workers: 4  -> 2-4 failures on 4 of 4 runs   (2m01s - 2m25s)
  // Under `workers: 2` it is the SAME test every time —
  // `tv-watchdog.spec.ts:180`, the stall-ladder recreate rung, which asserts on
  // the shared room's TV player. A deterministic failure, not load noise.
  //
  // So parallelism is roughly a 1.5-2x wall-clock win that currently costs
  // determinism, and a flaky gate is worth less than a slow one. The real unlock
  // is giving each spec its own room rather than raising this number — until
  // that lands, this stays 1. Production uses the durable Upstash driver and has
  // no such constraint.
  workers: 1,
  use: {
    baseURL: `http://${HOST}:${PORT}`,
    headless: true,
    // i18n (TICKET-30): pin the browser locale to the product's source locale so
    // the suite exercises the pt-BR baseline deterministically (Playwright's
    // default en-US would resolve the app to English via Accept-Language).
    // Locale-specific specs override per-file/describe via test.use().
    locale: "pt-BR",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // TICKET-116 — the e2e suite runs against a PRODUCTION BUILD, not `next dev`.
    //
    // `npx next dev` was the single cause behind three measured failure families:
    //   1. routes compile LAZILY, during the tests, so first-compile latency
    //      landed inside 5s/30s assertion windows (`page.goto: net::ERR_ABORTED`,
    //      `toBeVisible` timeouts on working product paths);
    //   2. module re-evaluation DISCARDED the in-memory singletons, wiping
    //      seeded rooms and queue entries mid-test (the deterministic
    //      served-lang.spec.ts failure that made `main` red);
    //   3. routes were EVICTED and recompiled after ~25s idle, so (1) and (2)
    //      recurred at arbitrary points — which is why no warm-up ordering ever
    //      closed this, and why three warm-up helpers accumulated in helpers.ts.
    // Measured: 5 of 5 cold runs on `main` failed, with a roaming failure set.
    //
    // A built server compiles nothing at request time, re-evaluates nothing and
    // evicts nothing, so all three disappear at once. It is also MORE correct:
    // e2e now exercises what we actually deploy (no strict-mode double
    // invocation, real minification and bundling), rather than a dev server that
    // can both fail on working code and pass on code that breaks when built.
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://${HOST}:${PORT}`,
    reuseExistingServer: !process.env.CI,
    // Build (~20s clean, longer on a contended box) + boot, not just boot.
    timeout: 600_000,
    env: {
      // TICKET-116 build isolation — the caveat that BINDS the change above.
      // `next build` and `next dev` share `.next/` by default, and a build run
      // while a dev server is live corrupts that server's artefacts (missing
      // `app-paths-manifest.json`, `Cannot find module './vendor-chunks/*.js'`).
      // Moving e2e onto a build would have made that routine, because agents run
      // `next dev` in the same tree for hand-testing. The suite therefore builds
      // into its OWN directory (next.config.ts reads NEXT_DIST_DIR) and never
      // touches the `.next/` a dev server is serving from. Per-worktree
      // isolation comes for free: each worktree has its own tree.
      NEXT_DIST_DIR: DIST_DIR,
      // Node.js 22+ provides localStorage as a global; without a valid file path it's a broken stub.
      // Provide a temp file so the global is functional during SSR.
      NODE_OPTIONS: `--localstorage-file=/tmp/boraoke-ls-${PORT}.json`,
      // Advance-auth (TICKET-45): run the WHOLE e2e suite in enforce mode. This
      // proves the drain/advance migration is complete (every authed advance
      // path works) AND lets advance-auth.spec.ts assert a bare advance → 401.
      // Production ships with the log-only default until the TM flips the env.
      ADVANCE_AUTH: "enforce",
      // TICKET-116 — two dev-only defaults the suite relied on implicitly, now
      // supplied explicitly because a production build no longer grants them.
      // Neither weakens anything: both restore exactly the posture the suite
      // already ran under, instead of leaving it to a NODE_ENV branch.
      //
      // `lib/host-auth.ts` hands the `default` room DEV_FALLBACK_TOKEN only when
      // NODE_ENV !== "production"; e2e/helpers.ts hard-codes that same value as
      // its host secret. Setting HOST_TOKEN to it keeps default-room host auth
      // working, and matches how a real deployment configures the legacy room.
      HOST_TOKEN: "cantai-dev-host",
      // `app/api/rooms/route.ts` skips the per-IP creation throttle only in
      // `next dev`. The suite creates far more than the 3/hour default, so the
      // limit is raised for the test process — the same effective posture the
      // dev server gave it, made explicit rather than implied.
      ROOM_CREATE_LIMIT: "100000",
    },
  },
});
