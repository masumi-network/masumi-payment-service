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

const allE2ETestMatches = ['<rootDir>/tests/e2e/flows/**/*.test.ts', '<rootDir>/tests/e2e/v2/flows/**/*.test.ts'];

// CI runs one Jest process per payment source. Do the source split at discovery
// time instead of relying on `describe.skip`: skipped files still execute
// top-level imports/setup, which can trigger Mesh/libsodium async init after
// Jest tears down the file environment.
const sourceScopedTestMatches: Record<string, string[]> = {
	Web3CardanoV1: ['<rootDir>/tests/e2e/flows/**/*.test.ts'],
	Web3CardanoV2: ['<rootDir>/tests/e2e/v2/flows/**/*.test.ts'],
};

const testMatch = process.env.TEST_PAYMENT_SOURCE_TYPE
	? (sourceScopedTestMatches[process.env.TEST_PAYMENT_SOURCE_TYPE] ?? allE2ETestMatches)
	: allE2ETestMatches;

// One worker per V1 flow file, which is the largest set a single Jest
// invocation discovers today. Overridable with E2E_MAX_WORKERS.
const DEFAULT_E2E_MAX_WORKERS = 3;

function parseMaxWorkers(): number {
	const raw = process.env.E2E_MAX_WORKERS;
	if (raw == null || raw.trim() === '') return DEFAULT_E2E_MAX_WORKERS;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`E2E_MAX_WORKERS must be a positive integer, got "${raw}"`);
	}
	return parsed;
}

const config: Config.InitialOptions = {
	preset: 'ts-jest/presets/default-esm',
	displayName: 'E2E',
	verbose: true,
	moduleNameMapper,
	roots: ['<rootDir>/tests/e2e', '<rootDir>/src'],
	testMatch,
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
	setupFilesAfterEnv: ['<rootDir>/jest.setup.libsodium.ts', '<rootDir>/tests/e2e/setup/testEnvironment.ts'],
	// Per-test timeout (applies to each `test(...)` and async hooks in test files)
	testTimeout: 1_200_000, // 20 minutes
	// Concurrent test files. Suites mutate `global.testConfig.paymentSourceType`
	// and `global.testAgent`, but that cannot race across files: Jest gives every
	// test file its own module registry and its own `global`, and worker
	// processes inherit `process.env` at fork time, so globalSetup's agent state
	// still reaches them.
	//
	// What still serializes is on chain. V1 takes one request per hot wallet per
	// scheduler tick and keeps the wallet locked until its transaction confirms,
	// so flows sharing a wallet pipeline instead of running fully in parallel.
	// Seed one selling wallet per flow to remove that half (see
	// tests/e2e/README.md > Parallel flows).
	//
	// Set E2E_MAX_WORKERS=1 to go back to serial, live-streamed logs: a worker
	// buffers its console output until the test file finishes, which hides
	// progress while a long on-chain wait is in flight.
	maxWorkers: parseMaxWorkers(),
	collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/**/*.test.ts'],
};

export default config;
