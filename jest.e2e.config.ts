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
  setupFilesAfterEnv: ['<rootDir>/tests/e2e/setup/testEnvironment.ts'],
  testTimeout: 600000,
  maxWorkers: 1,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.test.ts',
  ],
};

export default config;
