import type { Config } from '@jest/types';

const moduleNameMapper = {
	'^@masumi/payment-core$': '<rootDir>/packages/payment-core/src/index.ts',
	'^@masumi/payment-core/(.*)$': '<rootDir>/packages/payment-core/src/$1.ts',
	'^@masumi/payment-source-v1$': '<rootDir>/packages/payment-source-v1/src/index.ts',
	'^@masumi/payment-source-v1/services$': '<rootDir>/packages/payment-source-v1/src/services/index.ts',
	'^@masumi/payment-source-v1/(.*)$': '<rootDir>/packages/payment-source-v1/src/$1.ts',
	'^@masumi/payment-source-v2$': '<rootDir>/packages/payment-source-v2/src/index.ts',
	'^@masumi/payment-source-v2/services$': '<rootDir>/packages/payment-source-v2/src/services/index.ts',
	'^@masumi/payment-source-v2/(.*)$': '<rootDir>/packages/payment-source-v2/src/$1.ts',
	'^@prisma/client$': '<rootDir>/src/generated/prisma/client',
	'@/generated/(.*)': '<rootDir>/src/generated/$1',
	'@/(.*)': '<rootDir>/src/$1',
	'@e2e/(.*)': '<rootDir>/tests/e2e/$1',
	'^(\\.{1,2}/.*)\\.js$': '$1',
};

const config: Config.InitialOptions = {
	preset: 'ts-jest/presets/default-esm',
	displayName: 'E2E',
	verbose: true,
	moduleNameMapper,
	roots: ['<rootDir>/tests/e2e', '<rootDir>/src'],
	testMatch: ['<rootDir>/tests/e2e/flows/**/*.test.ts', '<rootDir>/tests/e2e/v2/flows/**/*.test.ts'],
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
	// Sequential workers: the V2 source-isolation suite mutates
	// `global.testConfig.paymentSourceType` and the describe.each blocks in the
	// shared flow tests do the same. Running in parallel would cause cross-file
	// races on that shared global.
	maxWorkers: 1,
	collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/**/*.test.ts'],
};

export default config;
