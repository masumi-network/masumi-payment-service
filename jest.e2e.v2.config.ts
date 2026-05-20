import type { Config } from '@jest/types';

process.env.TEST_PAYMENT_SOURCE_TYPE = 'Web3CardanoV2';

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
	displayName: 'E2E V2 Tests',
	verbose: true,
	moduleNameMapper,
	roots: ['<rootDir>/tests/e2e', '<rootDir>/src'],
	testMatch: ['<rootDir>/tests/e2e/v2/**/*.test.ts'],
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
	testTimeout: 1_200_000,
	maxWorkers: 1,
	collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/**/*.test.ts'],
};

export default config;
