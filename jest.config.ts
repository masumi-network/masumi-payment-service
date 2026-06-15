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
	'^@masumi/payment-source-x402$': '<rootDir>/packages/payment-source-x402/src/index.ts',
	'^@masumi/payment-source-x402/(.*)$': '<rootDir>/packages/payment-source-x402/src/$1.ts',
	'@/(.*)': '<rootDir>/src/$1',
	'^@prisma/client$': '<rootDir>/src/generated/prisma/client.ts',
	'^(\\.{1,2}/.*)\\.js$': '$1',
};

const config: Config.InitialOptions = {
	verbose: true,
	moduleNameMapper,
	// Inject placeholder DATABASE_URL / ENCRYPTION_KEY before any test module
	// loads `@masumi/payment-core/config`, whose top-level body fail-fasts on
	// missing env vars. Specs that need real DB connections (e2e) use the
	// separate `jest.e2e.config.ts` configuration.
	setupFiles: ['<rootDir>/jest.setup.env.ts'],
	// Force libsodium's async WASM init to settle before tests so its `.ready`
	// continuations don't fire a `require` after the env is torn down (which
	// crashes the worker with an UnhandledPromiseRejection). See the setup file.
	setupFilesAfterEnv: ['<rootDir>/jest.setup.libsodium.ts'],
	roots: ['<rootDir>/src', '<rootDir>/packages'],
	extensionsToTreatAsEsm: ['.ts'],
	transform: {
		'^.+\\.tsx?$': [
			'ts-jest',
			{
				useESM: true,
				tsconfig: 'tsconfig.json',
			},
		],
	},
};
export default config;
