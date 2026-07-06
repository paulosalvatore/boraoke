import { defineConfig, devices } from "@playwright/test";

// PORT override (default 3040 — unchanged) so parallel ticket worktrees can
// run e2e without clashing on the shared dev port (TICKET-18).
const PORT = Number(process.env.PORT ?? 3040);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
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
      NODE_OPTIONS: `--localstorage-file=/tmp/cantai-ls-${PORT}.json`,
    },
  },
});
