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
	'@/(.*)': '<rootDir>/src/$1',
	'^@prisma/client$': '<rootDir>/src/generated/prisma/client.ts',
	'^(\\.{1,2}/.*)\\.js$': '$1',
};

const config: Config.InitialOptions = {
	verbose: true,
	moduleNameMapper,
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
