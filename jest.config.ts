import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleNameMapper: {
    // `server-only` throws under plain node (by design — it guards Next.js
    // client bundles); stub it out for jest.
    "^server-only$": "<rootDir>/__mocks__/server-only.ts",
    "^@/(.*)$": "<rootDir>/$1",
  },
};

export default config;
