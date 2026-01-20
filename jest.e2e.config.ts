import type { Config } from '@jest/types';

const moduleNameMapper = {
  '^@prisma/client$': '<rootDir>/src/generated/prisma/client',
  '@/generated/(.*)': '<rootDir>/src/generated/$1',
  '@/(.*)': '<rootDir>/src/$1',
  '@e2e/(.*)': '<rootDir>/tests/e2e/$1',
  '^(\\.{1,2}/.*)\\.js$': '$1',
};

const config: Config.InitialOptions = {
  preset: 'ts-jest/presets/default-esm',
  displayName: 'E2E Tests',
  verbose: true,
  moduleNameMapper,
  roots: ['<rootDir>/tests/e2e', '<rootDir>/src'],
  testMatch: ['<rootDir>/tests/e2e/**/*.test.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  globals: {
    'ts-jest': {
      useESM: true,
      tsconfig: 'tsconfig.test.json',
    },
  },
  testEnvironment: 'node',
  globalSetup: '<rootDir>/tests/e2e/setup/globalSetup.ts',
  globalTeardown: '<rootDir>/tests/e2e/setup/globalTeardown.ts',
  setupFilesAfterEnv: ['<rootDir>/tests/e2e/setup/testEnvironment.ts'],
  // Per-test timeout (applies to each `test(...)` and async hooks in test files)
  testTimeout: 1_200_000, // 20 minutes
  maxWorkers: 3,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.test.ts',
  ],
};

export default config;
