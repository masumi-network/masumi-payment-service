import type { Config } from '@jest/types';

const moduleNameMapper = {
  '@/(.*)': '<rootDir>/src/$1',
  '@e2e/(.*)': '<rootDir>/tests/e2e/$1',
};

const config: Config.InitialOptions = {
  displayName: 'E2E Tests',
  verbose: true,
  moduleNameMapper,
  roots: ['<rootDir>/tests/e2e', '<rootDir>/src'],
  testMatch: ['<rootDir>/tests/e2e/**/*.test.ts'],
  transform: {
    '^.+\\.ts?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
  testEnvironment: 'node',
  globalSetup: '<rootDir>/tests/e2e/setup/globalSetup.ts',
  globalTeardown: '<rootDir>/tests/e2e/setup/globalTeardown.ts',
  setupFilesAfterEnv: ['<rootDir>/tests/e2e/setup/testEnvironment.ts'],
  // Per-test timeout (applies to each `test(...)` and async hooks in test files)
  testTimeout: 60_000,
  maxWorkers: 2,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.test.ts',
  ],
};

export default config;
