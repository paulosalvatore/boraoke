import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleNameMapper: {
    // `server-only` throws under plain node (by design — it guards Next.js
    // client bundles); stub it out for jest.
    "^server-only$": "<rootDir>/__mocks__/server-only.ts",
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
