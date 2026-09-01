import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  // D-033 puts a ticket's git worktree at <repo>/.worktrees/<slug>, i.e. INSIDE
  // this rootDir. Without this ignore, a run started while any worktree exists
  // scans the worktree's copies too: suite count doubles, jest-haste-map reports
  // duplicate manual mocks, and every suite importing @boraoke/rotation-engine
  // fails to resolve it against two identical package.json files. The failures
  // are pure infrastructure noise, but they read exactly like real breakage —
  // and the passing-test COUNT still goes up, so a run that only checks "Tests:"
  // looks greener than green while 16 suites are failing.
  // Anchored to <rootDir> ON PURPOSE. A bare "/.worktrees/" also matches when the
  // run is started FROM inside a worktree (rootDir is then the worktree itself and
  // every test path contains /.worktrees/), which ignores the entire suite and
  // reports a cheerful "No tests found" — worse than the problem it fixes, since
  // that is where every agent actually runs. Anchoring means: ignore worktrees
  // nested BELOW this rootDir, never the rootDir we are running in.
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/.worktrees/"],
  modulePathIgnorePatterns: ["<rootDir>/.worktrees/"],
  // TICKET-56 FU-7, fixed at the class level rather than per call site:
  // several tests spy on `console.warn` and restore it as the LAST statement
  // of the test body. If an assertion above that line throws, the restore
  // never runs and the spy leaks into every later test in the module —
  // silencing warnings on a run that is already red, which is exactly when
  // they are worth reading. Restoring after every test makes the leak
  // impossible for existing and future spies alike, instead of relying on
  // each author remembering a `finally`.
  restoreMocks: true,
  moduleNameMapper: {
    // `server-only` throws under plain node (by design — it guards Next.js
    // client bundles); stub it out for jest.
    "^server-only$": "<rootDir>/__mocks__/server-only.ts",
    // next-intl/server ships ESM + needs a live request context; stub it to the
    // pt-BR source catalog so API-route tests run under CJS (TICKET-30).
    "^next-intl/server$": "<rootDir>/__mocks__/next-intl-server.ts",
    // rotation-engine (TICKET-10): resolve the workspace package to its source
    // entry. The engine's internal `.ts`-suffixed imports resolve as real files.
    "^@boraoke/rotation-engine$": "<rootDir>/packages/rotation-engine/src/index.ts",
    "^@/(.*)$": "<rootDir>/$1",
  },
  // The engine source lives outside the app tree and imports sibling `.ts` files
  // by explicit extension — let ts-jest transform it (default ignores node_modules
  // only, so this is a no-op today but pins the intent).
  transformIgnorePatterns: ["/node_modules/"],
};

export default config;
