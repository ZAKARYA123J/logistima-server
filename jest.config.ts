import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  clearMocks: true,

  testMatch: ["**/__tests__/**/*.test.ts", "**/*.spec.ts"],

  extensionsToTreatAsEsm: [".ts"],

  moduleFileExtensions: ["ts", "js", "json"],

  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },

  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "tsconfig.json",
      },
    ],
  },

  collectCoverage: true,
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/server.ts",
    "!src/**/index.ts",
  ],
};

export default config;