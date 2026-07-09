import { defineConfig, devices } from "@playwright/test";

// PORT override (default 3040 — unchanged) so parallel ticket worktrees can
// run e2e without clashing on the shared dev port (TICKET-18).
const PORT = Number(process.env.PORT ?? 3040);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  // Serial execution (single worker). The dev/CI store + room registry use the
  // in-memory driver, whose singletons live in ONE Next dev process and reset on
  // each route's first compile (documented memory-driver caveat). Parallel
  // workers race those resets across test files and wipe seeded state, so e2e
  // runs serially — deterministic and fast enough (~40s). Production uses the
  // durable Upstash driver and has no such constraint.
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
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
    command: `npx next dev -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Node.js 22+ provides localStorage as a global; without a valid file path it's a broken stub.
      // Provide a temp file so the global is functional during SSR.
      NODE_OPTIONS: `--localstorage-file=/tmp/boraoke-ls-${PORT}.json`,
    },
  },
});
